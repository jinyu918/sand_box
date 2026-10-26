import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CertificateIssuer, generateCaMaterial, loadOrCreateCa } from '../src/broker/ca.js';
import { resolveCovePaths } from '../src/core/paths.js';
import { MemoryProtector } from '../src/vault/dpapi.js';
import { Vault } from '../src/vault/vault.js';

const tempDirs: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'cove-ca-'));
  tempDirs.push(root);
  const paths = resolveCovePaths({ COVE_HOME: root });
  const vault = await Vault.open(paths.vaultFile, new MemoryProtector());
  return { root, paths, vault };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('certificate authority', () => {
  it('creates a CA, encrypts its key, and reloads it', async () => {
    const { paths, vault } = await setup();
    const first = await loadOrCreateCa(paths, vault);
    const second = await loadOrCreateCa(paths, vault);
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);

    const cert = new X509Certificate(first.certPem);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain('Cove Local CA');
    const vaultFile = await readFile(paths.vaultFile, 'utf8');
    expect(vaultFile).not.toContain(first.keyPem);
  });

  it('issues a short-lived leaf with a SAN and a valid CA signature', () => {
    const material = generateCaMaterial();
    const issuer = new CertificateIssuer(material);
    const leaf = issuer.issue('API.Example.com.');
    const leafCert = new X509Certificate(leaf.certPem.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----\n');
    const caCert = new X509Certificate(material.certPem);
    expect(leafCert.subjectAltName).toContain('api.example.com');
    expect(leafCert.ca).toBe(false);
    expect(leafCert.verify(caCert.publicKey)).toBe(true);
    expect(leafCert.checkIssued(caCert)).toBe(true);
    expect(new Date(leafCert.validTo).getTime()).toBeGreaterThan(Date.now());
  });

  it('caches leaves for the same host', () => {
    const issuer = new CertificateIssuer(generateCaMaterial());
    expect(issuer.issue('a.example.com').certPem).toBe(issuer.issue('a.example.com').certPem);
    expect(issuer.issue('a.example.com').keyPem).toBe(issuer.issue('a.example.com').keyPem);
  });
});
