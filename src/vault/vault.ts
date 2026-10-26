import { CoveError } from '../core/errors.js';
import { isSecretId } from '../core/tokens.js';
import { normalizeHost } from '../core/net.js';
import { readJsonFile, writeJsonAtomic } from '../core/fs.js';

export interface SecretMetadata {
  id: string;
  label: string;
  hosts: string[];
  createdAt: string;
  updatedAt: string;
  system?: boolean;
}

export interface SecretRecord extends SecretMetadata {
  value: string;
}

export interface Protector {
  readonly kind: string;
  encrypt(plaintext: Buffer): Promise<string>;
  decrypt(ciphertext: string): Promise<Buffer>;
}

interface VaultEntry {
  metadata: SecretMetadata;
  ciphertext: string;
}

interface VaultFile {
  version: 1;
  backend: string;
  entries: Record<string, VaultEntry>;
}

const EMPTY_VAULT: VaultFile = { version: 1, backend: '', entries: {} };

export interface SetSecretOptions {
  label?: string;
  hosts?: string[];
}

export class Vault {
  private data: VaultFile;
  private readonly file: string;
  private readonly protector: Protector;

  private constructor(file: string, protector: Protector, data: VaultFile) {
    this.file = file;
    this.protector = protector;
    this.data = data;
  }

  static async open(file: string, protector: Protector): Promise<Vault> {
    const raw = await readJsonFile<unknown>(file, { ...EMPTY_VAULT, backend: protector.kind });
    const data = parseVault(raw, protector.kind);
    const vault = new Vault(file, protector, data);
    if (data.backend !== protector.kind) {
      throw new CoveError('VAULT_UNAVAILABLE', '保险箱后端与当前平台不匹配', {
        hint: 'v0.1 的保险箱仅支持创建它的 Windows 用户；不要跨用户/跨平台复制 vault.json',
      });
    }
    return vault;
  }

  async list(): Promise<SecretMetadata[]> {
    return Object.values(this.data.entries)
      .filter((entry) => entry.metadata.system !== true)
      .map((entry) => cloneMetadata(entry.metadata))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async has(id: string): Promise<boolean> {
    return this.data.entries[id] !== undefined;
  }

  async get(id: string): Promise<SecretRecord> {
    const entry = this.data.entries[id];
    if (entry === undefined || entry.metadata.system === true) {
      throw new CoveError('SECRET_NOT_FOUND', `未找到密钥: ${id}`, {
        hint: `运行 \`cove secret set ${id}\``,
      });
    }
    const value = await this.decryptEntry(entry);
    return { ...cloneMetadata(entry.metadata), value };
  }

  async getSystem(key: string): Promise<string> {
    const id = `system.${key}`;
    const entry = this.data.entries[id];
    if (entry === undefined) {
      throw new CoveError('VAULT_UNAVAILABLE', `保险箱缺少系统密钥: ${key}`, {
        hint: '运行 `cove setup` 重新初始化；若 CA 已存在，请先备份后删除 ~/.cove/ca 再初始化',
      });
    }
    return this.decryptEntry(entry);
  }

  async set(id: string, value: string, options: SetSecretOptions = {}): Promise<SecretMetadata> {
    if (!isSecretId(id)) {
      throw new CoveError('SECRET_INVALID', `密钥 ID 无效: ${JSON.stringify(id)}`, {
        hint: 'ID 只能包含小写字母、数字、点、下划线和连字符，且以字母或数字开头',
      });
    }
    if (id.startsWith('system.')) {
      throw new CoveError('SECRET_INVALID', '不能使用保留的 system. 前缀');
    }
    const existing = this.data.entries[id];
    const hosts = normalizeHosts(options.hosts ?? existing?.metadata.hosts ?? []);
    const now = new Date().toISOString();
    const ciphertext = await this.encryptValue(value);
    const metadata: SecretMetadata = {
      id,
      label: (options.label ?? existing?.metadata.label ?? id).slice(0, 120),
      hosts,
      createdAt: existing?.metadata.createdAt ?? now,
      updatedAt: now,
    };
    this.data.entries[id] = { metadata, ciphertext };
    await this.persist();
    return cloneMetadata(metadata);
  }

  async setSystem(key: string, value: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(key)) {
      throw new CoveError('SECRET_INVALID', '系统密钥名称无效');
    }
    const now = new Date().toISOString();
    const ciphertext = await this.encryptValue(value);
    this.data.entries[`system.${key}`] = {
      metadata: {
        id: `system.${key}`,
        label: `system:${key}`,
        hosts: [],
        createdAt: now,
        updatedAt: now,
        system: true,
      },
      ciphertext,
    };
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    if (id.startsWith('system.')) {
      throw new CoveError('SECRET_INVALID', '不能通过 secret 命令删除系统密钥');
    }
    if (this.data.entries[id] === undefined) return false;
    delete this.data.entries[id];
    await this.persist();
    return true;
  }

  private async encryptValue(value: string): Promise<string> {
    if (value.length === 0) throw new CoveError('SECRET_INVALID', '密钥不能为空');
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) {
      throw new CoveError('SECRET_INVALID', '密钥过大（上限 64 KiB）');
    }
    return this.protector.encrypt(Buffer.from(value, 'utf8'));
  }

  private async decryptEntry(entry: VaultEntry): Promise<string> {
    try {
      const plaintext = await this.protector.decrypt(entry.ciphertext);
      return plaintext.toString('utf8');
    } catch (error) {
      if (error instanceof CoveError) throw error;
      throw new CoveError('VAULT_DECRYPT_FAILED', `无法解密密钥: ${entry.metadata.id}`, {
        hint: '确认当前 Windows 用户与创建保险箱时一致；必要时重新录入密钥',
      });
    }
  }

  private async persist(): Promise<void> {
    this.data.backend = this.protector.kind;
    await writeJsonAtomic(this.file, this.data);
  }
}

function parseVault(raw: unknown, expectedBackend: string): VaultFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw corruptVault();
  }
  const candidate = raw as Partial<VaultFile>;
  if (candidate.version !== 1 || typeof candidate.backend !== 'string' || candidate.entries === null || typeof candidate.entries !== 'object') {
    throw corruptVault();
  }
  const entries: Record<string, VaultEntry> = {};
  for (const [id, entry] of Object.entries(candidate.entries)) {
    if (entry === null || typeof entry !== 'object') throw corruptVault();
    const item = entry as Partial<VaultEntry>;
    if (
      item.metadata === null ||
      typeof item.metadata !== 'object' ||
      typeof item.ciphertext !== 'string' ||
      item.metadata.id !== id ||
      !Array.isArray(item.metadata.hosts)
    ) {
      throw corruptVault();
    }
    entries[id] = {
      metadata: {
        id,
        label: String(item.metadata.label ?? id),
        hosts: item.metadata.hosts.map(String),
        createdAt: String(item.metadata.createdAt ?? ''),
        updatedAt: String(item.metadata.updatedAt ?? ''),
        ...(item.metadata.system === true ? { system: true } : {}),
      },
      ciphertext: item.ciphertext,
    };
  }
  const backend = candidate.backend;
  if (backend !== expectedBackend && backend !== '') {
    throw new CoveError('VAULT_UNAVAILABLE', '保险箱后端与当前平台不匹配', {
      hint: `vault.json 使用 ${backend}，当前平台使用 ${expectedBackend}`,
    });
  }
  return { version: 1, backend, entries };
}

function corruptVault(): CoveError {
  return new CoveError('VAULT_UNAVAILABLE', '保险箱文件损坏或格式不受支持', {
    hint: '从备份恢复 ~/.cove/vault.json；不要手工编辑密文',
  });
}

function normalizeHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  for (const host of hosts) {
    seen.add(normalizeHost(host));
  }
  return [...seen].sort();
}

function cloneMetadata(metadata: SecretMetadata): SecretMetadata {
  return {
    id: metadata.id,
    label: metadata.label,
    hosts: [...metadata.hosts],
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    ...(metadata.system === true ? { system: true } : {}),
  };
}
