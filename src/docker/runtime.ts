import { CoveError } from '../core/errors.js';
import type { ProcessRunner } from './runner.js';

export interface DockerInfo {
  serverVersion: string;
  os: string;
  arch: string;
}

export interface BrokerStartOptions {
  sessionId: string;
  name: string;
  image: string;
  network: string;
  configBase64: string;
  auditDir: string;
}

export interface SandboxStartOptions {
  sessionId: string;
  name: string;
  image: string;
  network: string;
  dnsIp: string;
  projectDir: string;
  configDir: string;
  bundleFile: string;
  homeVolume: string;
  env: Record<string, string>;
  command: string[];
  resources: { cpus: number; memory: string; pids: number };
  publish?: { hostPort: number; containerPort: number };
}

export class DockerRuntime {
  private readonly runner: ProcessRunner;
  private readonly docker: string;

  constructor(runner: ProcessRunner, docker = process.env.COVE_DOCKER ?? 'docker') {
    this.runner = runner;
    this.docker = docker;
  }

  async info(): Promise<DockerInfo> {
    const raw = await this.runner.exec(this.docker, ['info', '--format', '{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}'], {
      timeoutMs: 20_000,
    });
    if (raw.code !== 0) {
      throw new CoveError('DOCKER_UNAVAILABLE', '无法连接 Docker', {
        hint: '启动 Docker Desktop，并确认 `docker info` 成功',
      });
    }
    const [serverVersion = '', os = '', arch = ''] = raw.stdout.trim().split('|');
    if (os !== 'linux') {
      throw new CoveError('DOCKER_LINUX_REQUIRED', 'Docker 必须运行 Linux containers', {
        hint: '在 Docker Desktop 中切换到 Linux containers 后重试',
      });
    }
    return { serverVersion, os, arch };
  }

  async imageExists(tag: string): Promise<boolean> {
    const result = await this.runner.exec(this.docker, ['image', 'inspect', tag], { timeoutMs: 20_000 });
    return result.code === 0;
  }

  async build(tag: string, dockerfile: string, context: string, buildArgs: Record<string, string> = {}): Promise<void> {
    const args = ['build', '--tag', tag, '--file', dockerfile];
    for (const [key, value] of Object.entries(buildArgs)) args.push('--build-arg', `${key}=${value}`);
    args.push(context);
    const code = await this.runner.interactive(this.docker, args, { cwd: context });
    if (code !== 0) {
      throw new CoveError('DOCKER_FAILED', `镜像构建失败: ${tag}`, { hint: '查看上方的 Docker 构建输出' });
    }
  }

  async createNetwork(name: string, sessionId: string): Promise<void> {
    const result = await this.runner.exec(this.docker, [
      'network',
      'create',
      '--internal',
      '--label',
      `cove.session=${sessionId}`,
      name,
    ]);
    if (result.code !== 0) {
      throw new CoveError('DOCKER_FAILED', '无法创建沙箱网络', {
        hint: result.stderr.trim().slice(0, 300) || '检查 Docker Desktop',
      });
    }
  }

  async removeNetwork(name: string): Promise<void> {
    const result = await this.runner.exec(this.docker, ['network', 'rm', name], { timeoutMs: 20_000 });
    assertCleanup(result, 'network', name);
  }

  async startBroker(options: BrokerStartOptions): Promise<void> {
    const args = [
      'create',
      '--name',
      options.name,
      '--label',
      `cove.session=${options.sessionId}`,
      '--label',
      'cove.role=broker',
      '--network',
      options.network,
      '--network-alias',
      'broker',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'NET_BIND_SERVICE',
      '--cap-add',
      'SETUID',
      '--cap-add',
      'SETGID',
      '--security-opt',
      'no-new-privileges:true',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--pids-limit',
      '256',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--init',
      '--mount',
      `type=bind,source=${options.auditDir},target=/audit`,
      '--env',
      `COVE_BROKER_CONFIG=${options.configBase64}`,
      options.image,
    ];
    const created = await this.runner.execChecked(this.docker, args, { timeoutMs: 45_000, maxBuffer: 32 * 1024 * 1024 });
    if (created.length === 0) throw new CoveError('DOCKER_FAILED', '无法创建 broker 容器');
    const started = await this.runner.exec(this.docker, ['start', options.name], { timeoutMs: 30_000 });
    if (started.code !== 0) {
      throw new CoveError('BROKER_UNHEALTHY', '无法启动 broker 容器', {
        hint: started.stderr.trim().slice(0, 300),
      });
    }
  }

  async waitBrokerHealthy(name: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.runner.exec(this.docker, [
        'inspect',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
        name,
      ]);
      const status = result.stdout.trim();
      if (status === 'healthy' || status === 'running') {
        if (status === 'running') {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        return;
      }
      if (status === 'unhealthy' || status === 'exited' || status === 'dead') {
        const logs = await this.logs(name);
        throw new CoveError('BROKER_UNHEALTHY', 'broker 启动失败', {
          hint: sanitizeHint(logs),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new CoveError('BROKER_UNHEALTHY', 'broker 健康检查超时', {
      hint: '运行 `cove doctor` 查看 Docker 与镜像状态',
    });
  }

  async connectBridge(name: string): Promise<void> {
    const result = await this.runner.exec(this.docker, ['network', 'connect', 'bridge', name], { timeoutMs: 20_000 });
    if (result.code !== 0) {
      throw new CoveError('DOCKER_FAILED', '无法为 broker 连接出网网络', {
        hint: result.stderr.trim().slice(0, 300),
      });
    }
  }

  async containerIp(name: string, network: string): Promise<string> {
    const raw = await this.runner.execChecked(this.docker, [
      'inspect',
      '--format',
      '{{json .NetworkSettings.Networks}}',
      name,
    ]);
    let networks: Record<string, { IPAddress?: string }>;
    try {
      networks = JSON.parse(raw) as Record<string, { IPAddress?: string }>;
    } catch {
      throw new CoveError('DOCKER_FAILED', '无法读取 broker 网络地址');
    }
    const ip = networks[network]?.IPAddress;
    if (ip === undefined || ip.length === 0) {
      throw new CoveError('DOCKER_FAILED', 'broker 没有分配到 internal 网络地址');
    }
    return ip;
  }

  async runSandboxDetached(options: SandboxStartOptions): Promise<string> {
    const args = ['run', '-d', ...sandboxCommonArgs(options), '--name', options.name];
    if (options.publish !== undefined) {
      args.push('-p', `127.0.0.1:${options.publish.hostPort}:${options.publish.containerPort}`);
    }
    args.push(options.image, ...options.command);
    const output = await this.runner.execChecked(this.docker, args, { timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return output.trim();
  }

  async runSandboxInteractive(options: SandboxStartOptions, tty = true): Promise<number> {
    const args = [
      'run',
      '--rm',
      ...(tty ? ['-it'] : ['-i']),
      ...sandboxCommonArgs(options),
      '--name',
      options.name,
      options.image,
      ...options.command,
    ];
    return await this.runner.interactive(this.docker, args);
  }

  async stopAndRemove(name: string): Promise<void> {
    const stopped = await this.runner.exec(this.docker, ['stop', '--time', '5', name], { timeoutMs: 20_000 });
    assertCleanup(stopped, 'container', name);
    const removed = await this.runner.exec(this.docker, ['rm', '-f', name], { timeoutMs: 20_000 });
    assertCleanup(removed, 'container', name);
  }

  async removeVolume(name: string): Promise<void> {
    const result = await this.runner.exec(this.docker, ['volume', 'rm', '-f', name], { timeoutMs: 20_000 });
    assertCleanup(result, 'volume', name);
  }

  async logs(name: string): Promise<string> {
    const result = await this.runner.exec(this.docker, ['logs', '--tail', '80', name], { timeoutMs: 20_000 });
    return `${result.stdout}${result.stderr}`;
  }

  async readFileFromImage(image: string, file: string): Promise<string> {
    const result = await this.runner.exec(
      this.docker,
      ['run', '--rm', '--network', 'none', '--entrypoint', 'cat', image, file],
      { timeoutMs: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.code !== 0) {
      throw new CoveError('DOCKER_FAILED', `无法从镜像读取 ${file}`, {
        hint: result.stderr.trim().slice(0, 300),
      });
    }
    return result.stdout;
  }

  async startDshGateway(options: {
    name: string;
    image: string;
    network: string;
    sandboxName: string;
    hostPort: number;
    containerPort: number;
  }): Promise<void> {
    const sandboxIp = await this.containerIp(options.sandboxName, options.network);
    if (!/^\d+\.\d+\.\d+\.\d+$/u.test(sandboxIp)) {
      throw new CoveError('DOCKER_FAILED', '无法获取 DSH 容器地址');
    }
    const script = `const net=require('net');net.createServer(c=>{const u=net.connect(${options.containerPort},'${sandboxIp}');c.pipe(u).pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());}).listen(${options.containerPort},'0.0.0.0');`;
    const result = await this.runner.exec(this.docker, [
      'run',
      '-d',
      '--name',
      options.name,
      '--label',
      'cove.role=dsh-gateway',
      '--network',
      'bridge',
      '-p',
      `127.0.0.1:${options.hostPort}:${options.containerPort}`,
      '--entrypoint',
      'node',
      options.image,
      '-e',
      script,
    ], { timeoutMs: 40_000 });
    if (result.code !== 0) {
      throw new CoveError('DOCKER_FAILED', '无法启动 DSH 本地端口网关', {
        hint: result.stderr.trim().slice(0, 300),
      });
    }
    const connected = await this.runner.exec(this.docker, ['network', 'connect', options.network, options.name], { timeoutMs: 20_000 });
    if (connected.code !== 0) {
      throw new CoveError('DOCKER_FAILED', '无法连接 DSH 网关到沙箱网络', {
        hint: connected.stderr.trim().slice(0, 300),
      });
    }
  }

  async waitContainer(name: string): Promise<number> {
    const result = await this.runner.exec(this.docker, ['wait', name], { timeoutMs: 24 * 60 * 60 * 1000 });
    return Number(result.stdout.trim()) || 0;
  }
}

function sandboxCommonArgs(options: SandboxStartOptions): string[] {
  const args = [
    '--label',
    `cove.session=${options.sessionId}`,
    '--label',
    'cove.role=sandbox',
    '--network',
    options.network,
    '--dns',
    options.dnsIp,
    '--user',
    '1000:1000',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=1g',
    '--tmpfs',
    '/run:rw,noexec,nosuid,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    String(options.resources.pids),
    '--memory',
    options.resources.memory,
    '--cpus',
    String(options.resources.cpus),
    '--init',
    '--shm-size',
    '256m',
    '--ulimit',
    'nofile=4096:4096',
    '--mount',
    `type=bind,source=${options.projectDir},target=/workspace`,
    '--mount',
    `type=bind,source=${options.configDir},target=/cove/config,readonly`,
    '--mount',
    `type=bind,source=${options.bundleFile},target=/etc/ssl/certs/ca-certificates.crt,readonly`,
    '--mount',
    `type=volume,source=${options.homeVolume},target=/home/agent`,
    '--hostname',
    'workspace',
    '--workdir',
    '/workspace',
  ];
  for (const [key, value] of Object.entries(options.env)) {
    args.push('--env', `${key}=${value}`);
  }
  return args;
}

function sanitizeHint(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, '').trim().slice(0, 800);
}

function assertCleanup(result: { code: number; stderr: string }, kind: string, name: string): void {
  if (result.code === 0) return;
  const message = sanitizeHint(result.stderr);
  if (/no such (container|network|volume)|already in progress|already removed|not found/iu.test(message)) return;
  throw new CoveError('DOCKER_FAILED', `清理 ${kind} 失败: ${name}`, { hint: message });
}
