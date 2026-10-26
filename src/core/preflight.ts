import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CoveError } from './errors.js';

export interface ProjectScan {
  root: string;
  sensitiveFiles: string[];
  escapingSymlinks: string[];
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.cove', 'dist', 'coverage', '.next', '.turbo']);
const SENSITIVE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.git-credentials',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
]);
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template'];

export async function scanProject(projectDir: string): Promise<ProjectScan> {
  const root = await realpath(projectDir).catch(() => {
    throw new CoveError('PROJECT_INVALID', `项目目录不存在: ${projectDir}`);
  });
  const sensitiveFiles: string[] = [];
  const escapingSymlinks: string[] = [];
  await walk(root, root, 0, sensitiveFiles, escapingSymlinks);
  return {
    root,
    sensitiveFiles: [...new Set(sensitiveFiles)].sort(),
    escapingSymlinks: [...new Set(escapingSymlinks)].sort(),
  };
}

export function assertProjectSafe(scan: ProjectScan, allowProjectSecrets: boolean): void {
  if (scan.escapingSymlinks.length > 0) {
    throw new CoveError('SYMLINK_ESCAPE', '项目内存在指向项目外部的符号链接', {
      hint: `移除或改为项目内链接后重试：${scan.escapingSymlinks.slice(0, 5).join(', ')}`,
    });
  }
  if (!allowProjectSecrets && scan.sensitiveFiles.length > 0) {
    throw new CoveError('PROJECT_SECRETS_FOUND', '项目内含可能被 Agent 读取的密钥文件', {
      hint:
        `沙箱会挂载整个项目，Agent 可以读取这些文件：${scan.sensitiveFiles.slice(0, 8).join(', ')}。` +
        ' 请移出敏感文件，或确认风险后使用 --allow-project-secrets',
    });
  }
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  sensitiveFiles: string[],
  escapingSymlinks: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full);
    if (entry.isSymbolicLink()) {
      const target = await realpath(full).catch(() => undefined);
      if (target !== undefined && escapes(root, target)) escapingSymlinks.push(relative);
      continue;
    }
    if (entry.isFile() && isSensitive(entry.name, relative)) {
      sensitiveFiles.push(relative);
    }
    if (entry.isDirectory() && depth < 2 && !SKIP_DIRS.has(entry.name)) {
      await walk(root, full, depth + 1, sensitiveFiles, escapingSymlinks);
    }
  }
}

function isSensitive(name: string, relative: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_NAMES.has(lower)) return true;
  if (SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (lower.startsWith('.env.')) {
    return !SAFE_ENV_SUFFIXES.some((suffix) => lower.endsWith(suffix));
  }
  if (relative.replace(/\\/gu, '/').toLowerCase().endsWith('.aws/credentials')) return true;
  return false;
}

function escapes(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

export async function assertProjectPath(projectDir: string): Promise<string> {
  const resolved = path.resolve(projectDir);
  if (resolved.includes(',')) {
    throw new CoveError('PROJECT_INVALID', '项目路径包含逗号，Docker bind mount 无法安全解析', {
      hint: '将项目移动到不含逗号的路径，或使用 --project 指向另一个目录',
    });
  }
  const info = await lstat(resolved).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new CoveError('PROJECT_INVALID', `项目目录不存在或不是目录: ${resolved}`);
  }
  return resolved;
}
