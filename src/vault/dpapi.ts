import { spawn } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { CoveError } from '../core/errors.js';
import type { Protector } from './vault.js';

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd()
try {
  $bytes = [Convert]::FromBase64String($raw.Trim())
  $out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($out))
} catch {
  [Console]::Error.Write('protect-failed')
  exit 1
}
`.trim();

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd()
try {
  $bytes = [Convert]::FromBase64String($raw.Trim())
  $out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($out))
} catch {
  [Console]::Error.Write('unprotect-failed')
  exit 1
}
`.trim();

export class DpapiProtector implements Protector {
  readonly kind = 'dpapi:current-user';

  async encrypt(plaintext: Buffer): Promise<string> {
    const result = await runPowerShell(PROTECT_SCRIPT, plaintext.toString('base64'));
    return result;
  }

  async decrypt(ciphertext: string): Promise<Buffer> {
    const result = await runPowerShell(UNPROTECT_SCRIPT, ciphertext);
    return Buffer.from(result, 'base64');
  }
}

export class MemoryProtector implements Protector {
  readonly kind = 'memory:test';
  private readonly key = randomBytes(32);

  async encrypt(plaintext: Buffer): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
  }

  async decrypt(ciphertext: string): Promise<Buffer> {
    const raw = Buffer.from(ciphertext, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }
}

export function createProtector(): Protector {
  if (process.platform !== 'win32') {
    throw new CoveError('VAULT_UNAVAILABLE', 'v0.1 的保险箱仅支持 Windows DPAPI', {
      hint: '在 Windows 上运行 Cove；macOS/Linux 支持在后续版本提供',
    });
  }
  return new DpapiProtector();
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new CoveError('VAULT_UNAVAILABLE', 'DPAPI 调用超时', { hint: '检查 PowerShell 是否可用' }));
    }, 15_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) {
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CoveError('VAULT_UNAVAILABLE', '无法启动 PowerShell 调用 DPAPI', {
        hint: '确认 powershell.exe 在 PATH 中，且未被安全软件拦截',
        cause: error,
      }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new CoveError('VAULT_DECRYPT_FAILED', 'DPAPI 操作失败', {
          hint: stderr.includes('unprotect-failed')
            ? '当前 Windows 用户无法解密该数据；请确认使用创建保险箱时的用户'
            : '确认 PowerShell 的 System.Security 程序集可用',
        }));
        return;
      }
      const trimmed = stdout.trim();
      if (!/^[A-Za-z0-9+/=]+$/u.test(trimmed)) {
        reject(new CoveError('VAULT_UNAVAILABLE', 'DPAPI 返回了无效数据'));
        return;
      }
      resolve(trimmed);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
