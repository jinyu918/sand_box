import { CoveError } from '../core/errors.js';
import { normalizeHost, normalizeMethod, normalizeRequestPath } from '../core/net.js';
import { isSecretId } from '../core/tokens.js';
import type { BrokerConfig, CredentialConfig, PolicyRule, ReverseRoute } from './types.js';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_BYTES = 10 * 1024 * 1024;

export function parseBrokerConfig(raw: unknown): BrokerConfig {
  if (!isRecord(raw)) throw configError('broker config must be an object');
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  if (!/^[a-f0-9-]{8,64}$/u.test(sessionId)) throw configError('invalid sessionId');
  const auditPath = typeof raw.auditPath === 'string' && raw.auditPath.startsWith('/') ? raw.auditPath : '';
  if (auditPath.length === 0) throw configError('invalid auditPath');
  const ca = isRecord(raw.ca) ? raw.ca : {};
  if (typeof ca.certPem !== 'string' || typeof ca.keyPem !== 'string' || !ca.certPem.includes('CERTIFICATE') || !ca.keyPem.includes('PRIVATE KEY')) {
    throw configError('invalid CA material');
  }
  const credentialsRaw = Array.isArray(raw.credentials) ? raw.credentials : [];
  const credentials = credentialsRaw.map(validateCredential);
  const credentialIds = new Set<string>();
  const placeholders = new Set<string>();
  for (const credential of credentials) {
    if (credentialIds.has(credential.id)) throw configError(`duplicate credential ${credential.id}`);
    if (placeholders.has(credential.placeholder)) throw configError('duplicate placeholder');
    credentialIds.add(credential.id);
    placeholders.add(credential.placeholder);
    if (credential.value.length === 0) throw configError('empty credential value');
    if (credential.placeholder === credential.value) throw configError('placeholder must differ from value');
  }

  const policyRaw = Array.isArray(raw.policy) ? raw.policy : [];
  const policy = policyRaw.map(validateRule);
  for (const rule of policy) {
    if (rule.credential !== undefined && !credentialIds.has(rule.credential)) {
      throw configError(`policy ${rule.id} references unknown credential`);
    }
  }

  const routesRaw = Array.isArray(raw.reverseRoutes) ? raw.reverseRoutes : [];
  const reverseRoutes = routesRaw.map(validateRoute);
  for (const route of reverseRoutes) {
    if (!credentialIds.has(route.credential)) throw configError(`route ${route.id} references unknown credential`);
    const upstream = new URL(route.upstream);
    if (upstream.protocol !== 'https:') throw configError('reverse upstream must be https');
  }

  const limits = isRecord(raw.limits) ? raw.limits : {};
  const bodyBytes = numberLimit(limits.bodyBytes, MAX_BODY_BYTES, 1024, 64 * 1024 * 1024);
  const auditBytes = numberLimit(limits.auditBytes, MAX_AUDIT_BYTES, 1024 * 1024, 100 * 1024 * 1024);
  const allowLoopback = raw.allowLoopback === true;
  const upstreamCaPem = typeof raw.upstreamCaPem === 'string' ? raw.upstreamCaPem : undefined;

  return {
    sessionId,
    auditPath,
    ca: { certPem: ca.certPem, keyPem: ca.keyPem },
    policy,
    credentials,
    reverseRoutes,
    limits: { bodyBytes, auditBytes },
    ...(allowLoopback ? { allowLoopback: true } : {}),
    ...(upstreamCaPem === undefined ? {} : { upstreamCaPem }),
  };
}

function validateCredential(raw: unknown): CredentialConfig {
  if (!isRecord(raw)) throw configError('invalid credential');
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!isSecretId(id)) throw configError('invalid credential id');
  const value = typeof raw.value === 'string' ? raw.value : '';
  const placeholder = typeof raw.placeholder === 'string' ? raw.placeholder : '';
  if (placeholder.length < 16 || !/^[A-Za-z0-9_-]+$/u.test(placeholder)) throw configError('invalid placeholder');
  const hosts = Array.isArray(raw.hosts) ? raw.hosts.map((host) => normalizeHost(String(host))) : [];
  if (hosts.length === 0) throw configError('credential hosts required');
  const injectRaw = isRecord(raw.inject) ? raw.inject : {};
  const header = typeof injectRaw.header === 'string' ? injectRaw.header.toLowerCase() : '';
  if (!/^[a-z0-9-]+$/u.test(header)) throw configError('invalid injection header');
  const mode = injectRaw.mode;
  if (mode !== 'force' && mode !== 'placeholder') throw configError('invalid injection mode');
  const scheme = typeof injectRaw.scheme === 'string' ? injectRaw.scheme : undefined;
  if (scheme !== undefined && /[\r\n]/u.test(scheme)) throw configError('invalid injection scheme');
  return {
    id,
    value,
    placeholder,
    hosts,
    inject: { header, mode, ...(scheme === undefined ? {} : { scheme }) },
  };
}

function validateRule(raw: unknown): PolicyRule {
  if (!isRecord(raw)) throw configError('invalid policy rule');
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) throw configError('invalid policy id');
  const host = normalizeHost(typeof raw.host === 'string' ? raw.host : '');
  const methods = Array.isArray(raw.methods) ? raw.methods.map((method) => normalizeMethod(String(method))) : [];
  if (methods.length === 0) throw configError('policy methods required');
  const paths = Array.isArray(raw.paths) ? raw.paths.map((value) => normalizeRequestPath(String(value))) : undefined;
  const credential = typeof raw.credential === 'string' ? raw.credential : undefined;
  return { id, host, methods, ...(paths === undefined ? {} : { paths }), ...(credential === undefined ? {} : { credential }) };
}

function validateRoute(raw: unknown): ReverseRoute {
  if (!isRecord(raw)) throw configError('invalid reverse route');
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) throw configError('invalid route id');
  const prefix = typeof raw.prefix === 'string' ? raw.prefix : '';
  if (!/^\/[a-z0-9-]{1,32}$/u.test(prefix)) throw configError('invalid route prefix');
  const upstream = typeof raw.upstream === 'string' ? raw.upstream : '';
  try {
    const parsed = new URL(upstream);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('bad');
  } catch {
    throw configError('invalid upstream');
  }
  const credential = typeof raw.credential === 'string' ? raw.credential : '';
  const methods = Array.isArray(raw.methods) ? raw.methods.map((method) => normalizeMethod(String(method))) : [];
  if (methods.length === 0) throw configError('route methods required');
  const paths = Array.isArray(raw.paths) ? raw.paths.map((value) => normalizeRequestPath(String(value))) : undefined;
  return {
    id,
    prefix,
    upstream,
    credential,
    methods,
    ...(paths === undefined ? {} : { paths }),
  };
}

function numberLimit(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configError(message: string): CoveError {
  return new CoveError('CONFIG_INVALID', `Broker 配置无效: ${message}`);
}
