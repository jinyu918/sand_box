import { symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertProjectPath, assertProjectSafe, scanProject } from '../src/core/preflight.js';

describe('project preflight', () => {
  it('detects common secret files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cove-preflight-'));
    await writeFile(path.join(root, '.env'), 'TOKEN=secret', 'utf8');
    await writeFile(path.join(root, '.env.example'), 'TOKEN=', 'utf8');
    await writeFile(path.join(root, 'server.pem'), 'pem', 'utf8');
    await writeFile(path.join(root, 'README.md'), 'ok', 'utf8');
    const scan = await scanProject(root);
    expect(scan.sensitiveFiles).toEqual(['.env', 'server.pem']);
    expect(() => assertProjectSafe(scan, false)).toThrowError(/密钥文件/u);
    expect(() => assertProjectSafe(scan, true)).not.toThrow();
  });

  it('rejects symlinks that escape the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cove-preflight-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'cove-outside-'));
    await symlink(outside, path.join(root, 'escape'), 'junction').catch(() => undefined);
    const scan = await scanProject(root);
    if (scan.escapingSymlinks.length > 0) {
      expect(() => assertProjectSafe(scan, false)).toThrowError(/符号链接/u);
    }
  });

  it('rejects project paths containing a comma', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cove-preflight-'));
    await expect(assertProjectPath(`${root},bad`)).rejects.toThrowError(/逗号/u);
  });

  it('accepts a normal project path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cove-preflight-'));
    await expect(assertProjectPath(root)).resolves.toBe(root);
  });
});
