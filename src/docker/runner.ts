import { spawn } from 'node:child_process';
import { CoveError } from '../core/errors.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface InteractiveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export class ProcessRunner {
  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new CoveError('DOCKER_FAILED', `命令超时: ${command}`, { hint: '检查 Docker Desktop 是否响应' }));
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > maxBuffer) child.kill();
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > maxBuffer) child.kill();
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new CoveError('DOCKER_UNAVAILABLE', `无法启动命令: ${command}`, {
            hint: '确认 Docker Desktop 正在运行，且 docker 在 PATH 中',
            cause: error,
          }),
        );
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  async execChecked(command: string, args: string[], options: ExecOptions = {}): Promise<string> {
    const result = await this.exec(command, args, options);
    if (result.code !== 0) {
      throw new CoveError('DOCKER_FAILED', `命令失败: ${command}`, {
        hint: stripAnsi(result.stderr).trim().slice(0, 500) || `exit code ${result.code}`,
      });
    }
    return result.stdout;
  }

  async interactive(command: string, args: string[], options: InteractiveOptions = {}): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: 'inherit',
        windowsHide: false,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      child.on('error', (error) => {
        reject(
          new CoveError('DOCKER_UNAVAILABLE', `无法启动命令: ${command}`, {
            hint: '确认 Docker Desktop 正在运行',
            cause: error,
          }),
        );
      });
      child.on('close', (code, signal) => {
        resolve(code ?? (signal === 'SIGINT' ? 130 : 1));
      });
    });
  }
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, '');
}
