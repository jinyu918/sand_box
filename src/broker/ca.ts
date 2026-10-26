import { access } from 'node:fs/promises';
import forge from 'node-forge';
import { CoveError } from '../core/errors.js';
import { writeFileAtomic } from '../core/fs.js';
import { normalizeHost } from '../core/net.js';
import type { CovePaths } from '../core/paths.js';
import type { Vault } from '../vault/vault.js';

export interface CaMaterial {
  certPem: string;
  keyPem: string;
}

export interface IssuedCertificate {
  certPem: string;
  keyPem: string;
  expiresAt: number;
}

const CA_COMMON_NAME = 'Cove Local CA';
const LEAF_DAYS = 7;
const CA_DAYS = 3650;

export async function inspectCa(paths: CovePaths, vault: Vault): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (!(await exists(paths.caCertFile))) return { ok: false, reason: 'CA 证书不存在' };
    const { readFile } = await import('node:fs/promises');
    const certPem = await readFile(paths.caCertFile, 'utf8');
    const keyPem = await vault.getSystem('ca-key');
    validateCaPair(certPem, keyPem);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadOrCreateCa(paths: CovePaths, vault: Vault): Promise<CaMaterial> {
  const certExists = await exists(paths.caCertFile);
  if (certExists) {
    let keyPem: string;
    try {
      keyPem = await vault.getSystem('ca-key');
    } catch (error) {
      throw new CoveError('VAULT_UNAVAILABLE', '本地 CA 证书存在，但私钥无法读取', {
        hint: '运行 `cove setup` 重新生成 CA；旧 CA 签发的证书将失效',
        cause: error,
      });
    }
    const certPem = await import('node:fs/promises').then((fs) => fs.readFile(paths.caCertFile, 'utf8'));
    validateCaPair(certPem, keyPem);
    return { certPem, keyPem };
  }

  const material = generateCaMaterial();
  await vault.setSystem('ca-key', material.keyPem);
  await writeFileAtomic(paths.caCertFile, material.certPem, 0o644);
  return material;
}

export function generateCaMaterial(): CaMaterial {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * 24 * 60 * 60 * 1000);
  const attributes = [
    { name: 'commonName', value: CA_COMMON_NAME },
    { name: 'organizationName', value: 'Cove' },
  ];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyCertSign: true,
      cRLSign: true,
      critical: true,
    },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export class CertificateIssuer {
  private readonly caCert: forge.pki.Certificate;
  private readonly caKey: forge.pki.rsa.PrivateKey;
  private readonly cache = new Map<string, IssuedCertificate>();

  constructor(material: CaMaterial) {
    this.caCert = forge.pki.certificateFromPem(material.certPem);
    this.caKey = forge.pki.privateKeyFromPem(material.keyPem) as forge.pki.rsa.PrivateKey;
  }

  issue(host: string): IssuedCertificate {
    const name = normalizeHost(host);
    const cached = this.cache.get(name);
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) {
      return cached;
    }
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
    cert.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
    const expiresAt = Date.now() + LEAF_DAYS * 24 * 60 * 60 * 1000;
    cert.validity.notAfter = new Date(expiresAt);
    cert.setSubject([
      { name: 'commonName', value: name },
      { name: 'organizationName', value: 'Cove' },
    ]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: name }] },
      { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());
    const issued: IssuedCertificate = {
      certPem: `${forge.pki.certificateToPem(cert)}${forge.pki.certificateToPem(this.caCert)}`,
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
      expiresAt,
    };
    this.cache.set(name, issued);
    return issued;
  }
}

function validateCaPair(certPem: string, keyPem: string): void {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const key = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
    if (!publicKey || !key) throw new Error('missing key material');
    if (!publicKey.n.equals(key.n) || !publicKey.e.equals(key.e)) {
      throw new CoveError('VAULT_UNAVAILABLE', '本地 CA 证书与私钥不匹配', {
        hint: '运行 `cove setup` 重新生成 CA；旧 CA 签发的证书将失效',
      });
    }
    if (cert.validity.notAfter.getTime() < Date.now()) {
      throw new CoveError('VAULT_UNAVAILABLE', '本地 CA 已过期', {
        hint: '运行 `cove setup` 重新生成 CA',
      });
    }
  } catch (error) {
    if (error instanceof CoveError) throw error;
    throw new CoveError('VAULT_UNAVAILABLE', '本地 CA 证书或私钥格式无效', {
      hint: '运行 `cove setup` 重新生成 CA',
      cause: error,
    });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
