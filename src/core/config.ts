import { CoveError } from './errors.js';
import { readJsonFile, writeJsonAtomic } from './fs.js';
import { normalizeHost, normalizeMethod, normalizeRequestPath } from './net.js';
import type { CovePaths } from './paths.js';

export interface ResourceConfig {
  cpus: number;
  memory: string;
  pids: number;
}

export interface GlobalConfig {
  version: 1;
  images: { broker: string; sandbox: string };
  resources: ResourceConfig;
  ui: { port: number };
  sessionRetentionDays: number;
}

export interface EgressExtraHost {
  id: string;
  host: string;
  methods: string[];
  paths?: string[];
}

export interface ProjectConfig {
  version: 1;
  name?: string;
  security: { allowProjectSecretFiles: boolean };
  egress: { extraHosts: EgressExtraHost[] };
  resources?: ResourceConfig;
}

export interface McpSelection {
  preset: string;
  enabled: boolean;
  secretId?: string;
}

export interface McpState {
  version: 1;
  servers: McpSelection[];
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  version: 1,
  images: {
    broker: 'cove-broker:0.1.0',
    sandbox: 'cove-sandbox:0.1.0',
  },
  resources: { cpus: 2, memory: '4g', pids: 512 },
  ui: { port: 7777 },
  sessionRetentionDays: 14,
};

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: 1,
  security: { allowProjectSecretFiles: false },
  egress: { extraHosts: [] },
};

export const DEFAULT_MCP_STATE: McpState = { version: 1, servers: [] };

export async function loadGlobalConfig(paths: CovePaths): Promise<GlobalConfig> {
  const raw = await readJsonFile<unknown>(paths.configFile, DEFAULT_GLOBAL_CONFIG);
  return validateGlobalConfig(raw);
}

export async function saveGlobalConfig(paths: CovePaths, config: GlobalConfig): Promise<void> {
  await writeJsonAtomic(paths.configFile, validateGlobalConfig(config));
}

export function validateGlobalConfig(raw: unknown): GlobalConfig {
  if (!isRecord(raw)) throw invalidConfig('全局配置必须是 JSON 对象');
  if (raw.version !== 1) throw invalidConfig('不支持的全局配置版本');
  const images = isRecord(raw.images) ? raw.images : {};
  const resources = isRecord(raw.resources) ? raw.resources : {};
  const ui = isRecord(raw.ui) ? raw.ui : {};
  return {
    version: 1,
    images: {
      broker: imageName(images.broker, DEFAULT_GLOBAL_CONFIG.images.broker),
      sandbox: imageName(images.sandbox, DEFAULT_GLOBAL_CONFIG.images.sandbox),
    },
    resources: validateResources(resources),
    ui: {
      port: integerInRange(ui.port, DEFAULT_GLOBAL_CONFIG.ui.port, 1024, 65535, 'ui.port'),
    },
    sessionRetentionDays: integerInRange(
      raw.sessionRetentionDays,
      DEFAULT_GLOBAL_CONFIG.sessionRetentionDays,
      1,
      365,
      'sessionRetentionDays',
    ),
  };
}

export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  const raw = await readJsonFile<unknown>(projectDir + '/.cove/project.json', DEFAULT_PROJECT_CONFIG);
  return validateProjectConfig(raw);
}

export function validateProjectConfig(raw: unknown): ProjectConfig {
  if (!isRecord(raw)) throw invalidConfig('项目配置必须是 JSON 对象');
  if (raw.version !== 1) throw invalidConfig('不支持的项目配置版本');
  const security = isRecord(raw.security) ? raw.security : {};
  const egress = isRecord(raw.egress) ? raw.egress : {};
  const extraHostsRaw = Array.isArray(egress.extraHosts) ? egress.extraHosts : [];
  const extraHosts = extraHostsRaw.map((entry, index) => validateExtraHost(entry, index));
  const ids = new Set<string>();
  for (const entry of extraHosts) {
    if (ids.has(entry.id)) throw invalidConfig(`egress.extraHosts[].id 重复: ${entry.id}`);
    ids.add(entry.id);
  }
  const resources = isRecord(raw.resources) ? validateResources(raw.resources, true) : undefined;
  return {
    version: 1,
    ...(typeof raw.name === 'string' && raw.name.trim().length > 0 ? { name: raw.name.trim().slice(0, 120) } : {}),
    security: {
      allowProjectSecretFiles: security.allowProjectSecretFiles === true,
    },
    egress: { extraHosts },
    ...(resources === undefined ? {} : { resources }),
  };
}

export async function loadMcpState(paths: CovePaths): Promise<McpState> {
  const raw = await readJsonFile<unknown>(paths.mcpFile, DEFAULT_MCP_STATE);
  return validateMcpState(raw);
}

export async function saveMcpState(paths: CovePaths, state: McpState): Promise<void> {
  await writeJsonAtomic(paths.mcpFile, validateMcpState(state));
}

export function validateMcpState(raw: unknown): McpState {
  if (!isRecord(raw)) throw invalidConfig('MCP 配置必须是 JSON 对象');
  if (raw.version !== 1) throw invalidConfig('不支持的 MCP 配置版本');
  const serversRaw = Array.isArray(raw.servers) ? raw.servers : [];
  const servers: McpSelection[] = [];
  const seen = new Set<string>();
  for (const entry of serversRaw) {
    if (!isRecord(entry) || typeof entry.preset !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(entry.preset)) {
      throw invalidConfig('MCP 条目格式无效');
    }
    if (seen.has(entry.preset)) throw invalidConfig(`MCP preset 重复: ${entry.preset}`);
    seen.add(entry.preset);
    const secretId = entry.secretId;
    if (secretId !== undefined && (typeof secretId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(secretId))) {
      throw invalidConfig(`MCP 条目 secretId 无效: ${entry.preset}`);
    }
    servers.push({
      preset: entry.preset,
      enabled: entry.enabled !== false,
      ...(secretId === undefined ? {} : { secretId }),
    });
  }
  return { version: 1, servers };
}

function validateExtraHost(raw: unknown, index: number): EgressExtraHost {
  if (!isRecord(raw)) throw invalidConfig(`egress.extraHosts[${index}] 必须是对象`);
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) throw invalidConfig(`egress.extraHosts[${index}].id 无效`);
  const host = normalizeHost(typeof raw.host === 'string' ? raw.host : '');
  const methodsRaw = Array.isArray(raw.methods) ? raw.methods : ['GET'];
  const methods = methodsRaw.map((method) => normalizeMethod(String(method)));
  if (methods.length === 0 || methods.some((method) => !/^[A-Z]+$/u.test(method))) {
    throw invalidConfig(`egress.extraHosts[${index}].methods 无效`);
  }
  const paths = Array.isArray(raw.paths)
    ? raw.paths.map((value) => normalizeRequestPath(String(value)))
    : undefined;
  return { id, host, methods, ...(paths === undefined ? {} : { paths }) };
}

function validateResources(raw: Record<string, unknown>, partial = false): ResourceConfig {
  const defaults = DEFAULT_GLOBAL_CONFIG.resources;
  const cpus = numberInRange(raw.cpus, defaults.cpus, 0.25, 32, 'resources.cpus');
  const memory = memoryString(raw.memory, defaults.memory);
  const pids = integerInRange(raw.pids, defaults.pids, 64, 8192, 'resources.pids');
  if (partial && raw.cpus === undefined && raw.memory === undefined && raw.pids === undefined) {
    return defaults;
  }
  return { cpus, memory, pids };
}

function imageName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._/:@-]{0,199}$/u.test(value)) {
    throw invalidConfig('images 配置无效');
  }
  return value;
}

function memoryString(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,5}[mg]$/u.test(value)) {
    throw invalidConfig('resources.memory 必须形如 4g 或 512m');
  }
  return value;
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidConfig(`${field} 必须是 ${min}..${max} 的整数`);
  }
  return value;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalidConfig(`${field} 必须在 ${min}..${max} 之间`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidConfig(message: string): CoveError {
  return new CoveError('CONFIG_INVALID', message, { hint: '检查 ~/.cove/config.json 或 .cove/project.json 的格式' });
}
