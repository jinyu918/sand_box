import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryProtector } from '../src/vault/dpapi.js';
import { Vault } from '../src/vault/vault.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cove-vault-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Vault', () => {
  it('stores encrypted secrets with metadata and never returns plaintext in the file', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'vault.json');
    const protector = new MemoryProtector();
    const vault = await Vault.open(file, protector);

    await vault.set('anthropic', 'sk-ant-secret-value', {
      label: 'Anthropic',
      hosts: ['api.anthropic.com', 'API.ANTHROPIC.COM.'],
    });
    const record = await vault.get('anthropic');
    expect(record.value).toBe('sk-ant-secret-value');
    expect(record.hosts).toEqual(['api.anthropic.com']);

    const disk = await readFile(file, 'utf8');
    expect(disk).not.toContain('sk-ant-secret-value');
    expect(disk).toContain('api.anthropic.com');
    expect((await vault.list()).map((item) => item.id)).toEqual(['anthropic']);
  });

  it('rejects reserved and malformed IDs', async () => {
    const vault = await Vault.open(path.join(await tempDir(), 'vault.json'), new MemoryProtector());
    await expect(vault.set('system.ca-key', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    await expect(vault.set('../escape', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    await expect(vault.set('UPPER', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
  });

  it('hides system entries from list and get', async () => {
    const vault = await Vault.open(path.join(await tempDir(), 'vault.json'), new MemoryProtector());
    await vault.setSystem('ca-key', 'private-ca-key');
    expect(await vault.getSystem('ca-key')).toBe('private-ca-key');
    expect(await vault.list()).toEqual([]);
    await expect(vault.get('system.ca-key')).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });

  it('fails closed on corrupt vault data', async () => {
    const file = path.join(await tempDir(), 'vault.json');
    await writeFile(file, '{not json', 'utf8');
    await expect(Vault.open(file, new MemoryProtector())).rejects.toThrow();
  });

  it('fails closed when the protector backend does not match', async () => {
    const file = path.join(await tempDir(), 'vault.json');
    const first = await Vault.open(file, new MemoryProtector());
    await first.set('token', 'value');
    const wrong = new MemoryProtector();
    // Same kind but a different key: decryption must fail rather than return garbage.
    await expect((await Vault.open(file, wrong)).get('token')).rejects.toMatchObject({
      code: 'VAULT_DECRYPT_FAILED',
    });
  });

  it('removes secrets', async () => {
    const vault = await Vault.open(path.join(await tempDir(), 'vault.json'), new MemoryProtector());
    await vault.set('github', 'ghp_example');
    expect(await vault.remove('github')).toBe(true);
    expect(await vault.remove('github')).toBe(false);
    await expect(vault.get('github')).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });
});
