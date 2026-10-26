import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GLOBAL_CONFIG } from '../src/core/config.js';
import { resolveCovePaths } from '../src/core/paths.js';
import { MemoryProtector } from '../src/vault/dpapi.js';
import { Vault } from '../src/vault/vault.js';
import { runSession, type SessionDependencies } from '../src/session/lifecycle.js';
import type { SandboxStartOptions } from '../src/docker/runtime.js';
import type { SessionRecord } from '../src/session/store.js';

const roots: string[] = [];
const calls: string[] = [];

afterEach(async () => {
  calls.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(agentSecret?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'cove-session-'));
  roots.push(root);
  const project = await mkdtemp(path.join(root, 'project-'));
  const paths = resolveCovePaths({ COVE_HOME: path.join(root, 'home') });
  const vault = await Vault.open(paths.vaultFile, new MemoryProtector());
  if (agentSecret !== undefined) {
    await vault.set('anthropic', agentSecret, { hosts: ['api.anthropic.com'] });
  }
  let sandboxOptions: SandboxStartOptions | undefined;
  let brokerEnv: string | undefined;
  const sandboxConfigFiles = new Map<string, string>();
  const docker = {
    imageExists: async () => true,
    createNetwork: async () => {
      calls.push('network-create');
    },
    startBroker: async (options: { configBase64: string }) => {
      calls.push('broker-start');
      brokerEnv = options.configBase64;
    },
    waitBrokerHealthy: async () => {
      calls.push('broker-healthy');
    },
    connectBridge: async () => {
      calls.push('broker-bridge');
    },
    containerIp: async () => '172.20.0.2',
    readFileFromImage: async () => 'PUBLIC ROOTS\n',
    runSandboxInteractive: async (options: SandboxStartOptions) => {
      calls.push('sandbox-run');
      sandboxOptions = options;
      for (const name of ['claude-mcp.json', 'codex-config.toml', 'dsh-cordis.patch.yml']) {
        sandboxConfigFiles.set(name, await readFile(path.join(options.configDir, name), 'utf8'));
      }
      return 0;
    },
    stopAndRemove: async (name: string) => {
      calls.push(`stop:${name}`);
    },
    removeNetwork: async () => {
      calls.push('network-remove');
    },
    removeVolume: async () => {
      calls.push('volume-remove');
    },
    debug: async () => undefined,
    docker: 'docker',
  };
  const deps: SessionDependencies = {
    paths,
    config: DEFAULT_GLOBAL_CONFIG,
    vault,
    docker: docker as unknown as SessionDependencies['docker'],
  };
  return {
    root,
    project,
    paths,
    deps,
    getSandbox: () => sandboxOptions,
    getBrokerEnv: () => brokerEnv,
    getConfig: (name: string) => sandboxConfigFiles.get(name) ?? '',
  };
}

describe('session lifecycle', () => {
  it('runs shell with only placeholders and cleans up', async () => {
    const env = await setup();
    const result = await runSession(env.deps, {
      projectDir: env.project,
      agent: 'shell',
      args: [],
      allowProjectSecrets: false,
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toContain('sandbox-run');
    expect(calls).toContain('network-remove');
    expect(calls).toContain('volume-remove');
    const session = JSON.parse(await readFile(path.join(env.paths.sessionsDir, result.sessionId, 'session.json'), 'utf8')) as SessionRecord;
    expect(session.state).toBe('stopped');
    expect(session.agent).toBe('shell');
  });

  it('injects only a placeholder into the sandbox for Claude', async () => {
    const secret = 'sk-ant-real-super-secret';
    const env = await setup(secret);
    const result = await runSession(env.deps, {
      projectDir: env.project,
      agent: 'claude',
      args: [],
      allowProjectSecrets: false,
    });
    const sandbox = env.getSandbox();
    expect(sandbox).toBeDefined();
    expect(sandbox?.env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-cove_/u);
    expect(sandbox?.env.ANTHROPIC_API_KEY).not.toBe(secret);
    expect(sandbox?.env.ANTHROPIC_BASE_URL).toBe('http://broker:8080/anthropic');
    expect(JSON.stringify(sandbox?.env)).not.toContain(secret);
    expect(sandbox?.command).toContain('claude');

    const brokerConfig = JSON.parse(Buffer.from(env.getBrokerEnv() ?? '', 'base64').toString('utf8')) as {
      credentials: Array<{ value: string; placeholder: string }>;
    };
    expect(brokerConfig.credentials[0]?.value).toBe(secret);
    expect(brokerConfig.credentials[0]?.placeholder).toContain('sk-ant-cove_');

    expect(env.getConfig('claude-mcp.json')).not.toContain(secret);
    expect(env.getConfig('codex-config.toml')).not.toContain(secret);
    expect(env.getConfig('dsh-cordis.patch.yml')).not.toContain(secret);
    expect(result.sessionId.length).toBeGreaterThan(10);
  });

  it('fails before starting Docker when the agent secret is missing', async () => {
    const env = await setup();
    await expect(
      runSession(env.deps, { projectDir: env.project, agent: 'claude', args: [], allowProjectSecrets: false }),
    ).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
    expect(calls).not.toContain('broker-start');
  });

  it('rejects a project with secret files unless explicitly allowed', async () => {
    const env = await setup();
    await writeFile(path.join(env.project, '.env'), 'TOKEN=secret', 'utf8');
    await expect(
      runSession(env.deps, { projectDir: env.project, agent: 'shell', args: [], allowProjectSecrets: false }),
    ).rejects.toMatchObject({ code: 'PROJECT_SECRETS_FOUND' });
    expect(calls).not.toContain('broker-start');
  });
});
