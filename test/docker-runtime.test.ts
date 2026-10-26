import { describe, expect, it } from 'vitest';
import { DockerRuntime } from '../src/docker/runtime.js';
import type { ExecResult } from '../src/docker/runner.js';

class FakeRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.calls.push({ command, args });
    if (args[0] === 'inspect') return { code: 0, stdout: '{"net":{"IPAddress":"172.20.0.2"}}', stderr: '' };
    if (args[0] === 'image') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: 'ok', stderr: '' };
  }
  async execChecked(command: string, args: string[]): Promise<string> {
    this.calls.push({ command, args });
    return 'id';
  }
  async interactive(command: string, args: string[]): Promise<number> {
    this.calls.push({ command, args });
    return 0;
  }
}

const resources = { cpus: 2, memory: '4g', pids: 512 };
const sandbox = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  name: 'cove-sb-test',
  image: 'cove-sandbox:0.1.0',
  network: 'cove-net-test',
  dnsIp: '172.20.0.2',
  projectDir: 'D:\\projects\\demo',
  configDir: 'C:\\Users\\me\\.cove\\sessions\\x\\config',
  bundleFile: 'C:\\Users\\me\\.cove\\sessions\\x\\config\\ca-bundle.pem',
  homeVolume: 'cove-home-test',
  env: { ANTHROPIC_API_KEY: 'placeholder', COVE_SESSION_ID: 'x' },
  command: ['claude'],
  resources,
};

describe('Docker runtime hardening', () => {
  it('creates a broker without host privileges and with a broker alias', async () => {
    const runner = new FakeRunner();
    const docker = new DockerRuntime(runner as never);
    await docker.startBroker({
      sessionId: sandbox.sessionId,
      name: 'cove-br-test',
      image: 'cove-broker:0.1.0',
      network: 'cove-net-test',
      configBase64: 'eyJ4IjoxfQ==',
      auditDir: 'C:\\audit',
    });
    const create = runner.calls.find((call) => call.args[0] === 'create');
    expect(create).toBeDefined();
    const args = create?.args.join(' ') ?? '';
    expect(args).toContain('--cap-drop ALL');
    expect(args).toContain('--cap-add NET_BIND_SERVICE');
    expect(args).toContain('--cap-add SETUID');
    expect(args).toContain('--cap-add SETGID');
    expect(args).toContain('--security-opt no-new-privileges:true');
    expect(args).toContain('--read-only');
    expect(args).toContain('--network-alias broker');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('docker.sock');
  });

  it('hardens the sandbox and never mounts the host home or Docker socket', async () => {
    const runner = new FakeRunner();
    const docker = new DockerRuntime(runner as never);
    const code = await docker.runSandboxInteractive(sandbox);
    expect(code).toBe(0);
    const run = runner.calls.find((call) => call.args[0] === 'run');
    const args = run?.args.join(' ') ?? '';
    expect(args).toContain('--read-only');
    expect(args).toContain('--user 1000:1000');
    expect(args).toContain('--cap-drop ALL');
    expect(args).toContain('--security-opt no-new-privileges:true');
    expect(args).toContain('--dns 172.20.0.2');
    expect(args).toContain('type=bind,source=D:\\projects\\demo,target=/workspace');
    expect(args).toContain('type=bind,source=C:\\Users\\me\\.cove\\sessions\\x\\config,target=/cove/config,readonly');
    expect(args).toContain('target=/etc/ssl/certs/ca-certificates.crt,readonly');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('docker.sock');
    expect(args).not.toContain('C:\\Users\\me:/home');
  });
});
