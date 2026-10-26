import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadMcpState, saveMcpState } from '../core/config.js';
import { CoveError, describeError } from '../core/errors.js';
import { openBrowser } from '../core/browser.js';
import { knownSecret, knownSecrets } from '../cli/providers.js';
import { runSetup } from '../cli/setup.js';
import { MCP_PRESETS, findPreset } from '../mcp/catalog.js';
import { listSessions } from '../session/store.js';
import { readAudit } from '../cli/audit.js';
import type { CliContext } from '../cli/context.js';

export interface UiOptions {
  port?: number;
  open?: boolean;
}

export interface UiServer {
  url: string;
  close: () => Promise<void>;
}

export async function startUiServer(ctx: CliContext, options: UiOptions = {}): Promise<UiServer> {
  const csrf = randomBytes(24).toString('base64url');
  const server = http.createServer((req, res) => {
    void handleRequest(ctx, csrf, req, res).catch((error) => {
      const detail = describeError(error);
      sendJson(res, 500, { error: detail.message, code: detail.code });
    });
  });

  let port: number;
  try {
    port = await listen(server, options.port ?? ctx.config.ui.port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    port = await listen(server, 0);
  }
  const url = `http://127.0.0.1:${port}/`;
  if (options.open !== false) openBrowser(url);
  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(ctx: CliContext, csrf: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!/^127\.0\.0\.1:\d+$/u.test(req.headers.host ?? '')) {
    sendJson(res, 403, { error: 'invalid_host' });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();

  if (url.pathname === '/' || url.pathname === '/index.html') {
    await serveFile(res, 'index.html', 'text/html; charset=utf-8');
    return;
  }
  if (url.pathname === '/styles.css') {
    await serveFile(res, 'styles.css', 'text/css; charset=utf-8');
    return;
  }
  if (url.pathname === '/app.js') {
    await serveFile(res, 'app.js', 'text/javascript; charset=utf-8');
    return;
  }
  if (url.pathname === '/favicon.svg') {
    await serveFile(res, 'favicon.svg', 'image/svg+xml');
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  if (method !== 'GET') {
    enforceSameOrigin(req);
    if (req.headers['x-cove-csrf'] !== csrf) {
      sendJson(res, 403, { error: 'csrf_mismatch' });
      return;
    }
  }

  if (method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, { csrf, ...(await buildStatus(ctx)) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/secrets') {
    sendJson(res, 200, { secrets: await ctx.vault.list() });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/secrets') {
    const body = await readJsonBody(req);
    const id = typeof body.id === 'string' ? body.id : '';
    const value = typeof body.value === 'string' ? body.value : '';
    const known = knownSecret(id);
    const label = typeof body.label === 'string' ? body.label : known?.label;
    const hosts = Array.isArray(body.hosts) ? body.hosts.map(String) : known?.hosts;
    if (hosts === undefined || hosts.length === 0) {
      throw new CoveError('SECRET_INVALID', '自定义密钥必须至少声明一个允许主机');
    }
    const metadata = await ctx.vault.set(id, value, { ...(label === undefined ? {} : { label }), hosts });
    sendJson(res, 200, { secret: metadata });
    return;
  }

  if (method === 'DELETE' && url.pathname.startsWith('/api/secrets/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/secrets/'.length));
    const removed = await ctx.vault.remove(id);
    sendJson(res, removed ? 200 : 404, { removed });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/mcp') {
    sendJson(res, 200, await buildMcp(ctx));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/mcp') {
    const body = await readJsonBody(req);
    const presetId = typeof body.preset === 'string' ? body.preset : '';
    const preset = findPreset(presetId);
    if (preset === undefined) throw new CoveError('MCP_UNKNOWN', `未知 MCP preset: ${presetId}`);
    const state = await loadMcpState(ctx.paths);
    if (state.servers.some((server) => server.preset === presetId)) {
      sendJson(res, 200, { added: false, ...(await buildMcp(ctx)) });
      return;
    }
    let secretId: string | undefined;
    if (preset.secret !== undefined) {
      secretId = preset.secret.id;
      if (!(await ctx.vault.has(secretId))) {
        const value = typeof body.secretValue === 'string' ? body.secretValue : '';
        if (value.length === 0) {
          sendJson(res, 409, {
            needsSecret: true,
            secretId,
            label: preset.secret.label,
            helpUrl: preset.secret.helpUrl,
          });
          return;
        }
        await ctx.vault.set(secretId, value, {
          label: preset.secret.label,
          hosts: preset.secret.hosts,
        });
      }
    }
    state.servers.push({ preset: presetId, enabled: true, ...(secretId === undefined ? {} : { secretId }) });
    await saveMcpState(ctx.paths, state);
    sendJson(res, 200, { added: true, ...(await buildMcp(ctx)) });
    return;
  }

  if (method === 'DELETE' && url.pathname.startsWith('/api/mcp/')) {
    const presetId = decodeURIComponent(url.pathname.slice('/api/mcp/'.length));
    const state = await loadMcpState(ctx.paths);
    const next = state.servers.filter((server) => server.preset !== presetId);
    await saveMcpState(ctx.paths, { ...state, servers: next });
    sendJson(res, 200, { removed: next.length !== state.servers.length, ...(await buildMcp(ctx)) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/audit') {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const events = await readAudit(ctx.paths, undefined, Number.isFinite(limit) ? Math.min(500, Math.max(1, limit)) : 50);
    sendJson(res, 200, { events });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/setup') {
    await runSetup(ctx, { build: false, autoBuild: false });
    sendJson(res, 200, await buildStatus(ctx));
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

async function buildStatus(ctx: CliContext): Promise<Record<string, unknown>> {
  const secrets = await ctx.vault.list().catch(() => []);
  const sessions = await listSessions(ctx.paths).catch(() => []);
  const caOk = await readFile(ctx.paths.caCertFile, 'utf8').then(() => true).catch(() => false);
  const docker = await ctx.docker.info().then(
    (info) => ({ ok: true, version: info.serverVersion }),
    (error: unknown) => ({ ok: false, error: describeError(error).message }),
  );
  const images = {
    broker: await ctx.docker.imageExists(ctx.config.images.broker).catch(() => false),
    sandbox: await ctx.docker.imageExists(ctx.config.images.sandbox).catch(() => false),
  };
  const audit = await readAudit(ctx.paths, undefined, 20).catch(() => []);
  const mcp = await buildMcp(ctx);
  return {
    initialized: caOk && secrets !== undefined,
    docker,
    ca: { ok: caOk },
    vault: { ok: true, count: secrets.length },
    images,
    sessions,
    secrets,
    providers: knownSecrets(),
    paths: {
      home: ctx.paths.home,
      config: ctx.paths.configFile,
      vault: ctx.paths.vaultFile,
      ca: ctx.paths.caCertFile,
      sessions: ctx.paths.sessionsDir,
    },
    mcp,
    audit,
  };
}

async function buildMcp(ctx: CliContext): Promise<Record<string, unknown>> {
  const state = await loadMcpState(ctx.paths);
  const servers = [];
  for (const preset of MCP_PRESETS) {
    const entry = state.servers.find((server) => server.preset === preset.id);
    const secretConfigured = preset.secret === undefined ? true : await ctx.vault.has(preset.secret.id);
    servers.push({
      id: preset.id,
      title: preset.title,
      description: preset.description,
      category: preset.category,
      risk: preset.risk,
      transport: preset.transport.type,
      enabled: entry?.enabled === true,
      secret: preset.secret === undefined
        ? null
        : { id: preset.secret.id, label: preset.secret.label, helpUrl: preset.secret.helpUrl, configured: secretConfigured },
    });
  }
  return { servers };
}

function enforceSameOrigin(req: http.IncomingMessage): void {
  const host = req.headers.host ?? '';
  if (!/^127\.0\.0\.1:\d+$/u.test(host)) {
    throw new CoveError('POLICY_DENIED', '非法 Host');
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) {
    throw new CoveError('POLICY_DENIED', '跨站请求被拒绝');
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') {
    throw new CoveError('POLICY_DENIED', '跨站请求被拒绝');
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new CoveError('CONFIG_INVALID', '请求体过大');
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CoveError('CONFIG_INVALID', '请求体不是合法 JSON');
  }
}

async function serveFile(res: http.ServerResponse, name: string, contentType: string): Promise<void> {
  const dir = publicDir();
  const content = await readFile(path.join(dir, name));
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(content);
}

function publicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'public'), path.join(here, '..', '..', 'src', 'ui', 'public')];
  for (const candidate of candidates) {
    try {
      return candidate;
    } catch {
      // continue
    }
  }
  return candidates[0] ?? here;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine UI port'));
        return;
      }
      resolve(address.port);
    });
  });
}
