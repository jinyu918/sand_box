import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  await bestEffortPermissions(dir, mode);
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
    await bestEffortPermissions(temp, mode);
    await rename(temp, file);
    await bestEffortPermissions(file, mode);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function writeFileAtomic(file: string, content: string, mode = 0o600): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode });
    await bestEffortPermissions(temp, mode);
    await rename(temp, file);
    await bestEffortPermissions(file, mode);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function bestEffortPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows ignores POSIX modes; the user-profile ACL remains the effective control.
  }
}

export async function hardenWindowsAcl(target: string, directory: boolean): Promise<void> {
  if (process.platform !== 'win32') return;
  const domain = process.env.USERDOMAIN ?? '';
  const user = process.env.USERNAME ?? '';
  if (!user) return;
  const principal = domain ? `${domain}\\${user}` : user;
  const grant = directory ? `${principal}:(OI)(CI)F` : `${principal}:F`;
  const args = ['/inheritance:r', '/grant:r', grant, target];
  await execFileAsync('icacls', args, { windowsHide: true }).catch(() => undefined);
}


