import { stdin, stdout } from 'node:process';
import { CoveError } from '../core/errors.js';

export async function promptHidden(label: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new CoveError('SECRET_INVALID', '当前终端不支持隐藏输入', {
      hint: '使用 --stdin 从管道读取密钥，或直接在交互式终端运行',
    });
  }
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new CoveError('USER_CANCELLED', '已取消', { exitCode: 130 }));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (char === '\u001b' || char === '\t') continue;
        value += char;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '');
}

export function out(line = ''): void {
  stdout.write(`${line}\n`);
}

export function ok(label: string): void {
  out(`\u001b[32m✓\u001b[0m ${label}`);
}

export function warn(label: string): void {
  out(`\u001b[33m!\u001b[0m ${label}`);
}

export function fail(label: string): void {
  out(`\u001b[31m✗\u001b[0m ${label}`);
}

export function heading(label: string): void {
  out(`\n\u001b[1m${label}\u001b[0m`);
}
