import { CoveError } from '../core/errors.js';
import { hostMatches, normalizeHost, normalizeMethod, normalizeRequestPath, pathMatchesPrefix } from '../core/net.js';
import type { BrokerConfig, CredentialConfig, PolicyDecision, PolicyRule } from './types.js';

export class PolicyEngine {
  private readonly rules: PolicyRule[];
  private readonly credentials: Map<string, CredentialConfig>;

  constructor(config: Pick<BrokerConfig, 'policy' | 'credentials'>) {
    this.rules = [...config.policy];
    this.credentials = new Map(config.credentials.map((credential) => [credential.id, credential]));
    for (const rule of this.rules) {
      if (rule.credential !== undefined && !this.credentials.has(rule.credential)) {
        throw new CoveError('CONFIG_INVALID', `策略 ${rule.id} 引用了不存在的凭据 ${rule.credential}`);
      }
    }
  }

  evaluate(host: string, method: string, requestPath: string): PolicyDecision {
    let normalizedHost: string;
    try {
      normalizedHost = normalizeHost(host);
    } catch {
      return { allowed: false, reason: 'invalid_host' };
    }
    const normalizedMethod = normalizeMethod(method);
    const normalizedPath = normalizeRequestPath(requestPath);
    const candidates = this.rules.filter((rule) => hostMatches(rule.host, normalizedHost));
    if (candidates.length === 0) {
      return { allowed: false, reason: 'host_not_allowed' };
    }
    for (const rule of candidates) {
      if (!methodAllowed(rule.methods, normalizedMethod)) continue;
      if (!pathMatchesPrefix(normalizedPath, rule.paths)) continue;
      const credential = rule.credential === undefined ? undefined : this.credentials.get(rule.credential);
      return { allowed: true, rule, ...(credential === undefined ? {} : { credential }) };
    }
    return { allowed: false, reason: 'method_or_path_not_allowed' };
  }

  canResolve(host: string): boolean {
    try {
      const normalizedHost = normalizeHost(host);
      return this.rules.some((rule) => hostMatches(rule.host, normalizedHost));
    } catch {
      return false;
    }
  }

  credential(id: string): CredentialConfig | undefined {
    return this.credentials.get(id);
  }

  credentialsList(): CredentialConfig[] {
    return [...this.credentials.values()];
  }

  /** Returns a credential whose placeholder appears in headers/url but is not authorized for the host. */
  findPlaceholderLeak(host: string, headers: Record<string, string | string[] | undefined>, url: string): CredentialConfig | undefined {
    for (const credential of this.credentials.values()) {
      const authorized = credential.hosts.some((allowed) => {
        try {
          return hostMatches(allowed, normalizeHost(host));
        } catch {
          return false;
        }
      });
      if (authorized) continue;
      if (url.includes(credential.placeholder)) return credential;
      for (const value of Object.values(headers)) {
        const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
        if (values.some((item) => item.includes(credential.placeholder))) return credential;
      }
    }
    return undefined;
  }

  placeholderInUrl(url: string): boolean {
    return this.credentialsList().some((credential) => url.includes(credential.placeholder));
  }

  placeholderInBody(body: Buffer): boolean {
    return this.credentialsList().some((credential) => body.includes(Buffer.from(credential.placeholder, 'utf8')));
  }

  authorizeReverse(route: { methods: string[]; paths?: string[] }, method: string, requestPath: string): boolean {
    return methodAllowed(route.methods, normalizeMethod(method)) && pathMatchesPrefix(normalizeRequestPath(requestPath), route.paths);
  }
}

export function methodAllowed(allowed: readonly string[], method: string): boolean {
  if (allowed.includes(method)) return true;
  return method === 'HEAD' && allowed.includes('GET');
}
