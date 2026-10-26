import http from 'node:http';
import os from 'node:os';
import { CoveError, describeError } from '../core/errors.js';
import { AuditLogger } from './audit.js';
import { CertificateIssuer } from './ca.js';
import { parseBrokerConfig } from './config.js';
import { DnsServer } from './dns.js';
import { PolicyEngine } from './policy.js';
import { ProxyHandler } from './proxy.js';
import { createTransparentTlsServer, requestHost } from './tls.js';
import type { BrokerConfig, ReverseRoute } from './types.js';

const PROXY_PORT = 8080;
const TLS_PORT = 443;
const HEALTH_PORT = 8081;

async function main(): Promise<void> {
  const encoded = process.env.COVE_BROKER_CONFIG;
  if (encoded === undefined) {
    throw new CoveError('CONFIG_INVALID', 'COVE_BROKER_CONFIG is missing');
  }
  delete process.env.COVE_BROKER_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new CoveError('CONFIG_INVALID', 'COVE_BROKER_CONFIG is not valid base64 JSON');
  }
  const config = parseBrokerConfig(parsed);
  const policy = new PolicyEngine(config);
  const issuer = new CertificateIssuer(config.ca);
  const audit = new AuditLogger(config.auditPath, config.limits.auditBytes);
  const proxy = new ProxyHandler(config, policy, audit);
  const brokerIp = detectBrokerIp();

  const reverseServer = http.createServer((req, res) => {
    void handleReverse(proxy, config, req, res);
  });
  const transparentHttp = http.createServer((req, res) => {
    const host = requestHost(req.socket);
    if (host === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"missing_sni"}');
      return;
    }
    void proxy.handleTransparent(req, res, host).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal"}');
      } else {
        res.destroy();
      }
    });
  });
  const tlsServer = createTransparentTlsServer({ issuer, policy, httpServer: transparentHttp });
  const dnsServer = new DnsServer(policy, brokerIp);
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });

  await listen(reverseServer, PROXY_PORT);
  await listen(tlsServer, TLS_PORT);
  await dnsServer.start();
  await listen(healthServer, HEALTH_PORT, '127.0.0.1');

  audit.write({
    ts: new Date().toISOString(),
    session: config.sessionId,
    kind: 'start',
    host: '',
    method: '',
    path: '',
    status: 0,
    ms: 0,
    bytes: 0,
    credential: '',
    rule: '',
    action: 'allow',
    reason: '',
  });

  process.stdout.write('cove-broker ready\n');
  dropPrivileges();

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    audit.write({
      ts: new Date().toISOString(),
      session: config.sessionId,
      kind: 'stop',
      host: '',
      method: '',
      path: '',
      status: 0,
      ms: 0,
      bytes: 0,
      credential: '',
      rule: '',
      action: 'allow',
      reason: '',
    });
    await Promise.allSettled([
      closeServer(reverseServer),
      closeServer(tlsServer),
      closeServer(healthServer),
      dnsServer.stop(),
    ]);
    await audit.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

async function handleReverse(
  proxy: ProxyHandler,
  config: BrokerConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'https://cove.invalid');
    const route = config.reverseRoutes.find((candidate) => matchesRoute(url.pathname, candidate));
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
      return;
    }
    await proxy.handleReverse(req, res, route);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request' }));
    } else {
      res.destroy();
    }
    const detail = describeError(error);
    process.stderr.write(`cove-broker: reverse error ${detail.code}\n`);
  }
}

function matchesRoute(pathname: string, route: ReverseRoute): boolean {
  return pathname === route.prefix || pathname.startsWith(`${route.prefix}/`);
}

function detectBrokerIp(): string {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) candidates.push(entry.address);
    }
  }
  const address = candidates[0];
  if (address === undefined) {
    throw new CoveError('INTERNAL', 'Broker has no non-loopback IPv4 address');
  }
  return address;
}

function dropPrivileges(): void {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  try {
    if (process.setgid === undefined || process.setuid === undefined) {
      throw new Error('setuid unavailable');
    }
    process.setgid(1000);
    process.setuid(1000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cove-broker: could not drop privileges: ${message.slice(0, 120)}\n`);
    process.exit(1);
  }
}

function listen(server: http.Server | import('node:tls').Server, port: number, host = '0.0.0.0'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}

function closeServer(server: http.Server | import('node:tls').Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

process.on('uncaughtException', (error) => {
  const detail = describeError(error);
  process.stderr.write(`cove-broker: fatal ${detail.code}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const detail = describeError(reason);
  process.stderr.write(`cove-broker: fatal ${detail.code}\n`);
  process.exit(1);
});

void main().catch((error: unknown) => {
  const detail = describeError(error);
  process.stderr.write(`cove-broker: startup failed ${detail.code}\n`);
  process.exit(1);
});
