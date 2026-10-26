import { describe, expect, it } from 'vitest';
import { DpapiProtector } from '../src/vault/dpapi.js';

describe.skipIf(process.platform !== 'win32')('DPAPI protector', () => {
  it('round-trips a unicode secret through PowerShell', async () => {
    const protector = new DpapiProtector();
    const secret = 'sk-test-密钥-🔐-' + Date.now();
    const ciphertext = await protector.encrypt(Buffer.from(secret, 'utf8'));
    expect(ciphertext).not.toContain('sk-test');
    const plaintext = await protector.decrypt(ciphertext);
    expect(plaintext.toString('utf8')).toBe(secret);
  });

  it('does not decrypt tampered ciphertext', async () => {
    const protector = new DpapiProtector();
    const ciphertext = await protector.encrypt(Buffer.from('secret', 'utf8'));
    const tampered = `${ciphertext.slice(0, -4)}AAAA`;
    await expect(protector.decrypt(tampered)).rejects.toMatchObject({ code: 'VAULT_DECRYPT_FAILED' });
  });
});
