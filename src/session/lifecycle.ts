import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAgentLaunch, requireAgent, type AgentId } from '../agents/profiles.js';
import { inspectCa, loadOrCreateCa } from '../broker/ca.js';
import type { BrokerConfig } from '../broker/types.js';
import type { GlobalConfig } from '../core/config.js';
import { loadMcpState, loadProjectConfig } from '../core/config.js';
import { CoveError } from '../core/errors.js';
import { ensureDir, writeFileAtomic, writeJsonAtomic } from '../core/fs.js';
import { openBrowser } from '../core/browser.js';
import { newPlaceholder, newSessionId } from '../core/tokens.js';
import { sessionPaths, type CovePaths } from '../core/paths.js';
import { assertProjectPath, assertProjectSafe, scanProject } from '../core/preflight.js';
import { DockerRuntime } from '../docker/runtime.js';
import { requirePreset } from '../mcp/catalog.js';
import { renderMcpConfig, type McpSelection, type PlaceholderProvider } from '../mcp/render.js';
import type { Vault } from '../vault/vault.js';
import { buildSessionSecurity, type SessionSecret } from './security.js';
import { createSessionRecord, removeSessionConfig, updateSession, type SessionRecord } from './store.js';

export interface SessionDependencies {
  paths: CovePaths;
  config: GlobalConfig;
  vault: Vault;
  docker: DockerRuntime;
}

export interface RunSessionOptions {
  projectDir: string;
  agent: AgentId;
  args: string[];
  allowProjectSecrets: boolean;
  trustProjectConfig?: boolean;
  open?: boolean;
  tty?: boolean;
}

export interface SessionResult {
  exitCode: number;
  sessionId: string;
  webUrl?: string;
}

interface SessionArtifacts {
  record: SessionRecord;
  configDir: string;
  bundleFile: string;
  brokerConfig: BrokerConfig;
  brokerConfigBase64: string;
  launch: ReturnType<typeof buildAgentLaunch>;
  publish?: { hostPort: number; containerPort: number };
}

export async function runSession(deps: SessionDependencies, options: RunSessionOptions): Promise<SessionResult> {
  const projectDir = await assertProjectPath(options.projectDir);
  const projectConfig = await loadProjectConfig(projectDir);
  const scan = await scanProject(projectDir);
  assertProjectSafe(scan, options.allowProjectSecrets);
  const effectiveProject = {
    ...projectConfig,
    security: { allowProjectSecretFiles: false },
    egress: { extraHosts: options.trustProjectConfig === true ? projectConfig.egress.extraHosts : [] },
  };

  await ensureImages(deps);

  const agent = requireAgent(options.agent);
  const mcpState = await loadMcpState(deps.paths);
  const mcp = resolveMcpSelections(mcpState.servers);
  const secretIds = collectSecretIds(agent.secretId, mcp);
  const secrets = new Map<string, SessionSecret>();
  const placeholders = new Map<string, string>();
  for (const id of secretIds) {
    const record = await deps.vault.get(id);
    secrets.set(id, { value: record.value, placeholder: newPlaceholder(placeholderPrefix(id)) });
    placeholders.set(id, secrets.get(id)?.placeholder ?? '');
  }
  const placeholderProvider: PlaceholderProvider = {
    placeholderFor(secretId: string): string {
      const value = placeholders.get(secretId);
      if (value === undefined) {
        throw new CoveError('SECRET_NOT_FOUND', `缺少占位符对应的密钥: ${secretId}`);
      }
      return value;
    },
  };

  const caState = await inspectCa(deps.paths, deps.vault);
  if (!caState.ok) {
    throw new CoveError('SETUP_REQUIRED', '本地 CA 尚未就绪，不能启动沙箱', {
      hint: `运行 \`cove setup\` 初始化 CA（${caState.reason ?? '未知原因'}）`,
    });
  }
  const ca = await loadOrCreateCa(deps.paths, deps.vault);
  const sessionId = newSessionId();
  const record = await createSessionRecord(deps.paths, {
    id: sessionId,
    project: projectDir,
    agent: options.agent,
    secretIds: [...secretIds],
    mcp: mcp.map((selection) => selection.preset.id),
  });
  const session = sessionPaths(deps.paths, sessionId);
  let artifacts: SessionArtifacts | undefined;

  try {
    const security = buildSessionSecurity({
      agent: options.agent,
      secrets,
      mcp,
      project: effectiveProject,
    });
    const brokerConfig: BrokerConfig = {
      sessionId,
      auditPath: '/audit/audit.jsonl',
      ca,
      policy: security.policy,
      credentials: security.credentials,
      reverseRoutes: security.reverseRoutes,
      limits: { bodyBytes: 16 * 1024 * 1024, auditBytes: 10 * 1024 * 1024 },
    };
    const brokerConfigBase64 = Buffer.from(JSON.stringify(brokerConfig), 'utf8').toString('base64');
    if (brokerConfigBase64.length > 96 * 1024) {
      throw new CoveError('CONFIG_INVALID', '本会话的 broker 配置过大（超过 96 KiB）', {
        hint: '减少启用的 MCP 数量，或缩短密钥长度',
      });
    }

    const mcpConfig = renderMcpConfig(mcp, placeholderProvider);
    await ensureDir(session.configDir, 0o700);
    await writeFileAtomic(path.join(session.configDir, 'claude-mcp.json'), mcpConfig.claudeJson, 0o644);
    await writeFileAtomic(path.join(session.configDir, 'codex-config.toml'), mcpConfig.codexToml, 0o644);
    await writeFileAtomic(path.join(session.configDir, 'dsh-cordis.patch.yml'), mcpConfig.dshYaml, 0o644);
    const bundleFile = await prepareBundle(deps, session.configDir, ca.certPem);
    const resources = projectConfig.resources ?? deps.config.resources;

    const publish = options.agent === 'dsh' ? { hostPort: await freePort(), containerPort: 7788 } : undefined;
    const launch = buildAgentLaunch(options.agent, {
      args: options.args,
      placeholders,
      ...(publish === undefined
        ? {}
        : {
            dsh: {
              port: publish.containerPort,
              publicUrl: `http://127.0.0.1:${publish.hostPort}`,
              trustedHost: `127.0.0.1:${publish.hostPort}`,
            },
          }),
    });
    launch.env.COVE_SESSION_ID = sessionId;
    launch.env.COVE_AGENT_ID = options.agent;

    artifacts = {
      record,
      configDir: session.configDir,
      bundleFile,
      brokerConfig,
      brokerConfigBase64,
      launch,
      ...(publish === undefined ? {} : { publish }),
    };

    await deps.docker.createNetwork(record.network, sessionId);
    await deps.docker.startBroker({
      sessionId,
      name: record.broker,
      image: deps.config.images.broker,
      network: record.network,
      configBase64: brokerConfigBase64,
      auditDir: session.auditDir,
    });
    await deps.docker.waitBrokerHealthy(record.broker);
    await deps.docker.connectBridge(record.broker);
    const dnsIp = await deps.docker.containerIp(record.broker, record.network);

    if (publish !== undefined) {
      record.webPort = publish.hostPort;
      await writeJsonAtomic(session.sessionFile, { ...record, state: 'running', webPort: publish.hostPort });
    } else {
      await updateSession(deps.paths, record, { state: 'running' });
    }

    const sandboxOptions = {
      sessionId,
      name: record.container,
      image: deps.config.images.sandbox,
      network: record.network,
      dnsIp,
      projectDir,
      configDir: session.configDir,
      bundleFile,
      homeVolume: record.homeVolume,
      env: launch.env,
      command: launch.command,
      resources,
      ...(publish === undefined ? {} : { publish }),
    };

    if (launch.mode === 'dsh-web') {
      const webUrl = await runDshSession(deps, sandboxOptions, publish, options.open !== false);
      return { exitCode: 0, sessionId, webUrl };
    }

    const onSignal = (): void => {
      void deps.docker.stopAndRemove(record.container).catch(() => undefined);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      const exitCode = await deps.docker.runSandboxInteractive(sandboxOptions, options.tty !== false);
      return { exitCode, sessionId };
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  } catch (error) {
    record.state = 'failed';
    await updateSession(deps.paths, record, { state: 'failed' }).catch(() => undefined);
    if (artifacts === undefined) {
      await removeSessionConfig(deps.paths, sessionId).catch(() => undefined);
    }
    throw error;
  } finally {
    if (artifacts !== undefined) {
      await cleanupSession(deps, artifacts);
    }
  }
}

async function runDshSession(
  deps: SessionDependencies,
  sandboxOptions: Parameters<DockerRuntime['runSandboxDetached']>[0],
  publish: { hostPort: number; containerPort: number } | undefined,
  open: boolean,
): Promise<string> {
  if (publish === undefined) throw new CoveError('INTERNAL', 'DSH 端口未配置');
  await deps.docker.runSandboxDetached(sandboxOptions);
  const gatewayName = `cove-gw-${sandboxOptions.sessionId}`;
  await deps.docker.startDshGateway({
    name: gatewayName,
    image: deps.config.images.broker,
    network: sandboxOptions.network,
    sandboxName: sandboxOptions.name,
    hostPort: publish.hostPort,
    containerPort: publish.containerPort,
  });
  const publicUrl = `http://127.0.0.1:${publish.hostPort}`;
  const url = await waitForDsh(deps.docker, sandboxOptions.name, publicUrl);
  process.stdout.write(`\nDSH Web UI: ${url}\n按 Ctrl-C 结束会话。\n`);
  if (open) openBrowser(url);
  const onInterrupt = (): void => {
    void deps.docker.stopAndRemove(gatewayName);
    void deps.docker.stopAndRemove(sandboxOptions.name);
  };
  process.once('SIGINT', onInterrupt);
  try {
    await deps.docker.waitContainer(sandboxOptions.name);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    await deps.docker.stopAndRemove(gatewayName).catch(() => undefined);
  }
  return url;
}

async function waitForDsh(docker: DockerRuntime, container: string, publicUrl: string): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const logs = await docker.logs(container).catch(() => '');
    const match = logs.match(/https?:\/\/[^\s"'<>]+/u);
    if (match !== null) {
      try {
        const printed = new URL(match[0]);
        const base = new URL(publicUrl);
        if (printed.pathname !== '/' && !printed.pathname.startsWith('/?')) continue;
        if (printed.search.length > 0 && !/^\?token=[A-Za-z0-9_-]+$/u.test(printed.search)) continue;
        const url = `${base.origin}/${printed.search}`;
        if (await httpReady(url)) return url;
      } catch {
        // Keep polling.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = await docker.logs(container).catch(() => '');
  throw new CoveError('AGENT_CONFIG_INVALID', 'DSH Web UI 未在 45 秒内就绪', {
    hint: logs.replace(/\u001b\[[0-9;]*m/gu, '').trim().slice(0, 800) || '查看 `docker logs` 输出',
  });
}

async function httpReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status < 500 && response.status !== 404;
  } catch {
    return false;
  }
}

async function prepareBundle(deps: SessionDependencies, configDir: string, caPem: string): Promise<string> {
  let publicRoots = '';
  try {
    const { readFile } = await import('node:fs/promises');
    publicRoots = await readFile(deps.paths.publicRootsFile, 'utf8');
  } catch {
    publicRoots = await deps.docker.readFileFromImage(deps.config.images.sandbox, '/etc/ssl/certs/ca-certificates.crt');
    await writeFileAtomic(deps.paths.publicRootsFile, publicRoots, 0o644);
  }
  const bundle = `${publicRoots.trimEnd()}\n${caPem.trimEnd()}\n`;
  const bundleFile = path.join(configDir, 'ca-bundle.pem');
  await writeFile(bundleFile, bundle, { encoding: 'utf8', mode: 0o644 });
  return bundleFile;
}

async function ensureImages(deps: SessionDependencies): Promise<void> {
  const [broker, sandbox] = await Promise.all([
    deps.docker.imageExists(deps.config.images.broker),
    deps.docker.imageExists(deps.config.images.sandbox),
  ]);
  if (!broker || !sandbox) {
    throw new CoveError('IMAGE_MISSING', 'Cove 镜像尚未构建', {
      hint: '运行 `cove setup --build` 或 `cove build` 后重试',
    });
  }
}

function resolveMcpSelections(servers: readonly { preset: string; enabled: boolean; secretId?: string }[]): McpSelection[] {
  const selections: McpSelection[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    const preset = requirePreset(server.preset);
    selections.push({ preset, ...(server.secretId === undefined ? {} : { secretId: server.secretId }) });
  }
  return selections;
}

function collectSecretIds(agentSecretId: string | undefined, mcp: readonly McpSelection[]): Set<string> {
  const ids = new Set<string>();
  if (agentSecretId !== undefined) ids.add(agentSecretId);
  for (const selection of mcp) {
    if (selection.preset.secret !== undefined) {
      ids.add(selection.secretId ?? selection.preset.secret.id);
    }
  }
  return ids;
}

function placeholderPrefix(id: string): string {
  if (id === 'anthropic') return 'sk-ant-cove';
  if (id === 'openai') return 'sk-cove';
  return `cove-${id}`;
}

async function cleanupSession(deps: SessionDependencies, artifacts: SessionArtifacts): Promise<void> {
  const { record } = artifacts;
  const errors: string[] = [];
  const attempt = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await attempt('dsh-gateway', () => deps.docker.stopAndRemove(`cove-gw-${record.id}`));
  await attempt('sandbox', () => deps.docker.stopAndRemove(record.container));
  await attempt('broker', () => deps.docker.stopAndRemove(record.broker));
  await attempt('network', () => deps.docker.removeNetwork(record.network));
  await attempt('volume', () => deps.docker.removeVolume(record.homeVolume));
  await attempt('config', () => removeSessionConfig(deps.paths, record.id));
  const state = errors.length === 0 && record.state !== 'failed' ? 'stopped' : 'failed';
  await updateSession(deps.paths, record, { state }).catch(() => undefined);
  if (errors.length > 0) {
    process.stderr.write(`cove: 清理未完全成功，可运行 \`cove down --all\`：${errors.join('; ')}\n`);
  }
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
