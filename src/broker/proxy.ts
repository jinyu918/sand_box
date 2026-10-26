import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactText, sanitizeLogValue } from '../core/redact.js';
import { normalizeRequestPath } from '../core/net.js';
import type { AuditLogger } from './audit.js';
import { injectCredential, sanitizeInboundHeaders, sanitizeResponseHeaders } from './inject.js';
import { methodAllowed, PolicyEngine } from './policy.js';
import type { AuditEvent, BrokerConfig, CredentialConfig, PolicyRule, ReverseRoute } from './types.js';
import { openUpstream, UpstreamError } from './upstream.js';

class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
  }
}

export class ProxyHandler {
  private readonly config: BrokerConfig;
  private readonly policy: PolicyEngine;
  private readonly audit: AuditLogger;

  constructor(config: BrokerConfig, policy: PolicyEngine, audit: AuditLogger) {
    this.config = config;
    this.policy = policy;
    this.audit = audit;
  }

  async handleTransparent(req: IncomingMessage, res: ServerResponse, targetHost: string): Promise<void> {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const parsedUrl = parseRequestUrl(req.url);
    const requestPath = parsedUrl.pathname;
    const query = parsedUrl.search;
    const hostHeader = normalizeHostHeader(req.headers.host);
    if (hostHeader === undefined || hostHeader !== targetHost) {
      this.deny(res, started, targetHost, method, requestPath, 400, '', 'host_mismatch');
      return;
    }
    const leak = this.policy.findPlaceholderLeak(targetHost, req.headers, req.url ?? '');
    if (leak !== undefined) {
      this.deny(res, started, targetHost, method, requestPath, 403, leak.id, 'placeholder_leak_attempt');
      return;
    }
    if (this.policy.placeholderInUrl(req.url ?? '')) {
      this.deny(res, started, targetHost, method, requestPath, 400, '', 'placeholder_in_url');
      return;
    }
    const decision = this.policy.evaluate(targetHost, method, requestPath);
    if (!decision.allowed || decision.rule === undefined) {
      this.deny(res, started, targetHost, method, requestPath, 403, '', decision.reason ?? 'policy_denied');
      return;
    }
    const headers = sanitizeInboundHeaders(req.headers, targetHost);
    if (decision.credential !== undefined) injectCredential(headers, decision.credential);
    await this.forward(req, res, {
      started,
      host: targetHost,
      method,
      requestPath,
      query,
      rule: decision.rule,
      credential: decision.credential,
      headers,
    });
  }

  async handleReverse(req: IncomingMessage, res: ServerResponse, route: ReverseRoute): Promise<void> {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const parsedUrl = parseRequestUrl(req.url);
    const fullPath = parsedUrl.pathname;
    const query = parsedUrl.search;
    const remaining = stripPrefix(fullPath, route.prefix);
    if (remaining === undefined) {
      this.deny(res, started, upstreamHost(route), method, fullPath, 404, route.credential, 'route_not_found');
      return;
    }
    if (!methodAllowed(route.methods, method) || !this.policy.authorizeReverse(route, method, remaining)) {
      this.deny(res, started, upstreamHost(route), method, remaining, 403, route.credential, 'reverse_method_or_path_not_allowed');
      return;
    }
    const credential = this.policy.credential(route.credential);
    if (credential === undefined) {
      this.deny(res, started, upstreamHost(route), method, remaining, 503, route.credential, 'credential_missing');
      return;
    }
    const host = upstreamHost(route);
    const leak = this.policy.findPlaceholderLeak(host, req.headers, req.url ?? '');
    if (leak !== undefined) {
      this.deny(res, started, host, method, remaining, 403, leak.id, 'placeholder_leak_attempt');
      return;
    }
    if (this.policy.placeholderInUrl(req.url ?? '')) {
      this.deny(res, started, host, method, remaining, 400, credential.id, 'placeholder_in_url');
      return;
    }
    const headers = sanitizeInboundHeaders(req.headers, host);
    injectCredential(headers, credential);
    await this.forward(req, res, {
      started,
      host,
      method,
      requestPath: joinUpstreamPath(route.upstream, remaining),
      query,
      rule: { id: route.id, host, methods: route.methods, credential: route.credential },
      credential,
      headers,
    });
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    context: {
      started: number;
      host: string;
      method: string;
      requestPath: string;
      query: string;
      rule: PolicyRule;
      credential: CredentialConfig | undefined;
      headers: Record<string, string | string[] | undefined>;
    },
  ): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req, this.config.limits.bodyBytes);
    } catch (error) {
      const requestError = toRequestError(error);
      this.deny(res, context.started, context.host, context.method, context.requestPath, requestError.status, '', requestError.code);
      return;
    }

    try {
      const upstream = await openUpstream({
        host: context.host,
        method: context.method,
        path: `${context.requestPath}${context.query}`,
        headers: context.headers,
        body,
        allowLoopback: this.config.allowLoopback === true,
        ...(this.config.upstreamCaPem === undefined ? {} : { ca: this.config.upstreamCaPem }),
      });
      res.writeHead(upstream.statusCode, sanitizeResponseHeaders(upstream.headers));
      let bytes = 0;
      let audited = false;
      const finishAudit = (action: AuditEvent['action'], reason: string): void => {
        if (audited) return;
        audited = true;
        this.writeAudit({
          started: context.started,
          host: context.host,
          method: context.method,
          path: context.requestPath,
          status: upstream.statusCode,
          bytes,
          credential: context.credential?.id ?? '',
          rule: context.rule.id,
          action,
          reason,
        });
      };
      upstream.stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      upstream.stream.on('error', () => {
        finishAudit('error', 'upstream_stream_error');
        res.destroy();
      });
      res.on('finish', () => {
        finishAudit(upstream.statusCode >= 500 ? 'error' : 'allow', upstream.statusCode >= 500 ? 'upstream_status' : '');
      });
      res.on('close', () => {
        if (!res.writableFinished) {
          finishAudit('error', 'client_aborted');
          upstream.stream.destroy();
        }
      });
      upstream.stream.pipe(res);
    } catch (error) {
      const upstreamError = error instanceof UpstreamError ? error : new UpstreamError('upstream_failed', 'Upstream failed');
      const status = upstreamError.code === 'private_address' ? 502 : upstreamError.code === 'timeout' ? 504 : 502;
      this.deny(res, context.started, context.host, context.method, context.requestPath, status, context.credential?.id ?? '', upstreamError.code);
    }
  }

  private deny(
    res: ServerResponse,
    started: number,
    host: string,
    method: string,
    requestPath: string,
    status: number,
    credential: string,
    reason: string,
  ): void {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: reason }));
    } else {
      res.destroy();
    }
    this.writeAudit({
      started,
      host,
      method,
      path: requestPath,
      status,
      bytes: 0,
      credential,
      rule: '',
      action: 'deny',
      reason,
    });
  }

  private writeAudit(input: {
    started: number;
    host: string;
    method: string;
    path: string;
    status: number;
    bytes: number;
    credential: string;
    rule: string;
    action: AuditEvent['action'];
    reason: string;
  }): void {
    const sensitive = this.policy.credentialsList().flatMap((credential) => [credential.placeholder, credential.value]);
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      session: this.config.sessionId,
      kind: 'http',
      host: sanitizeLogValue(redactText(input.host, sensitive), 253),
      method: sanitizeLogValue(input.method, 16),
      path: sanitizeLogValue(redactText(input.path, sensitive), 512),
      status: input.status,
      ms: Date.now() - input.started,
      bytes: input.bytes,
      credential: sanitizeLogValue(input.credential, 64),
      rule: sanitizeLogValue(input.rule, 64),
      action: input.action,
      reason: sanitizeLogValue(input.reason, 120),
    };
    this.audit.write(event);
  }
}

function normalizeHostHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = header.trim().toLowerCase();
  const withoutPort = value.startsWith('[') ? value : value.replace(/:\d+$/u, '');
  return withoutPort.replace(/\.$/u, '');
}

function stripPrefix(fullPath: string, prefix: string): string | undefined {
  if (fullPath === prefix) return '/';
  if (!fullPath.startsWith(`${prefix}/`)) return undefined;
  const remaining = fullPath.slice(prefix.length);
  return remaining.length === 0 ? '/' : remaining;
}

function upstreamHost(route: ReverseRoute): string {
  return new URL(route.upstream).hostname;
}

function joinUpstreamPath(upstream: string, remaining: string): string {
  const base = new URL(upstream).pathname.replace(/\/+$/u, '');
  const suffix = remaining.startsWith('/') ? remaining : `/${remaining}`;
  return `${base}${suffix}` || '/';
}

function parseRequestUrl(raw: string | undefined): { pathname: string; search: string } {
  try {
    const parsed = new URL(raw ?? '/', 'https://cove.invalid');
    return { pathname: normalizeRequestPath(parsed.pathname), search: parsed.search };
  } catch {
    throw new RequestError(400, 'invalid_url', 'Invalid request target');
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const lengthHeader = req.headers['content-length'];
  if (lengthHeader !== undefined) {
    const length = Number(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader);
    if (Number.isFinite(length) && length > limit) {
      throw new RequestError(413, 'body_too_large', 'Request body too large');
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw new RequestError(413, 'body_too_large', 'Request body too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function toRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  return new RequestError(400, 'bad_request', 'Could not read request body');
}
