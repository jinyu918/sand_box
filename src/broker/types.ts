export interface CredentialInject {
  header: string;
  mode: 'force' | 'placeholder';
  scheme?: string;
}

export interface CredentialConfig {
  id: string;
  value: string;
  placeholder: string;
  hosts: string[];
  inject: CredentialInject;
}

export interface PolicyRule {
  id: string;
  host: string;
  methods: string[];
  paths?: string[];
  credential?: string;
}

export interface ReverseRoute {
  id: string;
  prefix: string;
  upstream: string;
  credential: string;
  methods: string[];
  paths?: string[];
}

export interface BrokerLimits {
  bodyBytes: number;
  auditBytes: number;
}

export interface BrokerConfig {
  sessionId: string;
  auditPath: string;
  ca: { certPem: string; keyPem: string };
  policy: PolicyRule[];
  credentials: CredentialConfig[];
  reverseRoutes: ReverseRoute[];
  limits: BrokerLimits;
  allowLoopback?: boolean;
  upstreamCaPem?: string;
}

export type AuditKind = 'http' | 'dns' | 'start' | 'stop' | 'security';

export interface AuditEvent {
  ts: string;
  session: string;
  kind: AuditKind;
  host: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  bytes: number;
  credential: string;
  rule: string;
  action: 'allow' | 'deny' | 'error';
  reason: string;
}

export interface PolicyDecision {
  allowed: boolean;
  rule?: PolicyRule;
  credential?: CredentialConfig;
  reason?: string;
}

export interface InboundRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
