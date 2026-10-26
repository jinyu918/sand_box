import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GLOBAL_CONFIG } from '../src/core/config.js';
import { resolveCovePaths } from '../src/core/paths.js';
import { MemoryProtector } from '../src/vault/dpapi.js';
import { Vault } from '../src/vault/vault.js';
import { startUiServer, type UiServer } from '../src/ui/server.js';
import type { CliContext } from '../src/cli/context.js';

const roots: string[] = [];
const servers: UiServer[] = [];

async function createContext(): Promise<{ ctx: CliContext; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'cove-ui-'));
  roots.push(root);
  const paths = resolveCovePaths({ COVE_HOME: root });
  const vault = await Vault.open(paths.vaultFile, new MemoryProtector());
  const docker = {
    info: async () => ({ serverVersion: 'test', os: 'linux', arch: 'x64' }),
    imageExists: async () => true,
  };
  return {
    ctx: {
      paths,
      config: DEFAULT_GLOBAL_CONFIG,
      vault,
      docker: docker as unknown as CliContext['docker'],
    },
    root,
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local UI server', () => {
  it('serves the console and protects writes with CSRF', async () => {
    const { ctx } = await createContext();
    const server = await startUiServer(ctx, { port: 0, open: false });
    servers.push(server);
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Cove');

    const status = await fetch(`${server.url}api/status`);
    const body = (await status.json()) as { csrf: string; docker: { ok: boolean } };
    expect(body.docker.ok).toBe(true);
    expect(body.csrf.length).toBeGreaterThan(20);

    const denied = await fetch(`${server.url}api/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'custom', value: 'secret' }),
    });
    expect(denied.status).toBe(403);

    const saved = await fetch(`${server.url}api/secrets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cove-csrf': body.csrf,
        origin: new URL(server.url).origin,
      },
      body: JSON.stringify({ id: 'custom', value: 'super-secret-value', hosts: ['api.example.com'] }),
    });
    expect(saved.status).toBe(200);
    const secrets = (await (await fetch(`${server.url}api/secrets`)).json()) as { secrets: Array<Record<string, unknown>> };
    expect(secrets.secrets[0]?.id).toBe('custom');
    expect(JSON.stringify(secrets)).not.toContain('super-secret-value');
    const vaultFile = await readFile(ctx.paths.vaultFile, 'utf8');
    expect(vaultFile).not.toContain('super-secret-value');
  });

  it('asks for a secret when connecting a secret-backed MCP', async () => {
    const { ctx } = await createContext();
    const server = await startUiServer(ctx, { port: 0, open: false });
    servers.push(server);
    const status = (await (await fetch(`${server.url}api/status`)).json()) as { csrf: string };
    const headers = { 'content-type': 'application/json', 'x-cove-csrf': status.csrf, origin: new URL(server.url).origin };
    const first = await fetch(`${server.url}api/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ preset: 'github' }),
    });
    expect(first.status).toBe(409);
    const firstBody = (await first.json()) as { needsSecret: boolean; secretId: string };
    expect(firstBody).toMatchObject({ needsSecret: true, secretId: 'github' });

    const second = await fetch(`${server.url}api/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ preset: 'github', secretValue: 'ghp_test_value' }),
    });
    expect(second.status).toBe(200);
  });
});
