import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CertificateIssuer, generateCaMaterial } from '../../src/broker/ca.js';
import { DockerRuntime } from '../../src/docker/runtime.js';
import { ProcessRunner } from '../../src/docker/runner.js';
import type { BrokerConfig } from '../../src/broker/types.js';

const runner = new ProcessRunner();
const docker = new DockerRuntime(runner);
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const internalNet = `cove-it-${suffix}-in`;
const egressNet = `cove-it-${suffix}-eg`;
const brokerName = `cove-it-${suffix}-broker`;
const upstreamName = `cove-it-${suffix}-upstream`;
const upstreamImage = 'cove-test-upstream:0.1.0';
const brokerImage = 'cove-broker:0.1.0';
let root: string;
let available = false;

async function dockerRun(args: string[], timeoutMs = 60_000) {
  return await runner.exec('docker', args, { timeoutMs });
}

async function dockerOk(): Promise<boolean> {
  const result = await dockerRun(['info', '--format', '{{.ServerVersion}}'], 15_000);
  return result.code === 0;
}

beforeAll(async () => {
  available = await dockerOk();
  if (!available && process.env.COVE_SKIP_DOCKER !== '1') {
    throw new Error('Docker is required for the Cove integration suite; set COVE_SKIP_DOCKER=1 to skip explicitly');
  }
  if (!available) return;
  root = await mkdtemp(path.join(tmpdir(), 'cove-it-'));
  if ((await dockerRun(['image', 'inspect', brokerImage], 15_000)).code !== 0) {
    const built = await dockerRun(['build', '-t', brokerImage, '-f', 'docker/broker.Dockerfile', '.'], 300_000);
    if (built.code !== 0) throw new Error(built.stderr);
  }
  if ((await dockerRun(['image', 'inspect', upstreamImage], 15_000)).code !== 0) {
    const built = await dockerRun(['build', '-t', upstreamImage, 'docker/test-upstream'], 180_000);
    if (built.code !== 0) throw new Error(built.stderr);
  }
}, 360_000);

afterAll(async () => {
  if (!available) return;
  await dockerRun(['rm', '-f', brokerName, upstreamName], 30_000);
  await dockerRun(['network', 'rm', internalNet, egressNet], 30_000);
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.env.COVE_SKIP_DOCKER === '1')('broker + sandbox integration', () => {
  it('routes only allowed DNS, injects credentials, and audits without secrets', async () => {
    if (!available) {
      throw new Error('Docker is required for the Cove integration suite');
    }
    expect(root).toBeTruthy();
    const certDir = path.join(root, 'certs');
    const configDir = path.join(root, 'config');
    const auditDir = path.join(root, 'audit');
    await mkdir(certDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(auditDir, { recursive: true });

    const brokerCa = generateCaMaterial();
    const upstreamCa = generateCaMaterial();
    const upstreamLeaf = new CertificateIssuer(upstreamCa).issue('upstream.test');
    await writeFile(path.join(certDir, 'upstream.crt'), upstreamLeaf.certPem, 'utf8');
    await writeFile(path.join(certDir, 'upstream.key'), upstreamLeaf.keyPem, 'utf8');
    await writeFile(path.join(certDir, 'broker-ca.pem'), brokerCa.certPem, 'utf8');

    await dockerRun(['network', 'create', '--internal', internalNet]);
    await dockerRun(['network', 'create', egressNet]);
    const upstream = await dockerRun([
      'run',
      '-d',
      '--rm',
      '--name',
      upstreamName,
      '--network',
      egressNet,
      '--network-alias',
      'upstream.test',
      '-v',
      `${certDir}:/certs:ro`,
      '-e',
      'TLS_CERT=/certs/upstream.crt',
      '-e',
      'TLS_KEY=/certs/upstream.key',
      upstreamImage,
    ]);
    expect(upstream.code, upstream.stderr).toBe(0);
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      const logs = await dockerRun(['logs', upstreamName], 10_000);
      if (logs.stdout.includes('test-upstream ready')) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(ready).toBe(true);

    const sessionId = randomUUID();
    const secret = 'demo-real-secret-value';
    const placeholder = 'cove_demo_placeholder_123456';
    const otherPlaceholder = 'cove_other_placeholder_123456';
    const config: BrokerConfig = {
      sessionId,
      auditPath: '/audit/audit.jsonl',
      ca: brokerCa,
      policy: [
        { id: 'upstream', host: 'upstream.test', methods: ['GET', 'POST'], credential: 'demo' },
      ],
      credentials: [
        {
          id: 'demo',
          value: secret,
          placeholder,
          hosts: ['upstream.test'],
          inject: { header: 'authorization', mode: 'placeholder' },
        },
        {
          id: 'other',
          value: 'other-real-secret',
          placeholder: otherPlaceholder,
          hosts: ['other.test'],
          inject: { header: 'authorization', mode: 'placeholder' },
        },
        {
          id: 'reverse-demo',
          value: secret,
          placeholder: 'cove_reverse_placeholder_123456',
          hosts: ['upstream.test'],
          inject: { header: 'authorization', mode: 'force', scheme: 'Bearer ' },
        },
      ],
      reverseRoutes: [
        {
          id: 'demo-reverse',
          prefix: '/anthropic',
          upstream: 'https://upstream.test',
          credential: 'reverse-demo',
          methods: ['POST'],
          paths: ['/v1/'],
        },
      ],
      limits: { bodyBytes: 1024 * 1024, auditBytes: 1024 * 1024 },
      allowLoopback: true,
      upstreamCaPem: upstreamCa.certPem,
    };
    const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');

    await docker.startBroker({
      sessionId,
      name: brokerName,
      image: brokerImage,
      network: internalNet,
      configBase64: encoded,
      auditDir,
    });
    try {
      await docker.waitBrokerHealthy(brokerName);
    } catch (error) {
      console.error('broker logs:', await docker.logs(brokerName));
      throw error;
    }
    await docker.connectBridge(brokerName);
    await dockerRun(['network', 'connect', egressNet, brokerName]);
    const brokerIp = await docker.containerIp(brokerName, internalNet);
    expect(brokerIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);

    const networks = JSON.parse(
      (await dockerRun(['inspect', '--format', '{{json .NetworkSettings.Networks}}', brokerName])).stdout,
    ) as Record<string, { IPAddress?: string }>;
    const bridgeIp = networks.bridge?.IPAddress;
    expect(bridgeIp).toBeTruthy();
    const bridgeProbe = await dockerRun([
      'run',
      '--rm',
      '--network',
      'bridge',
      '--entrypoint',
      'node',
      brokerImage,
      '-e',
      `fetch('http://${bridgeIp}:8080/anthropic/v1/messages',{method:'POST'}).then(r=>console.log('REACHABLE '+r.status)).catch(()=>console.log('BLOCKED'))`,
    ], 30_000);
    expect(bridgeProbe.stdout).toContain('BLOCKED');

    const script = `
      (async () => {
        const base = { headers: { authorization: 'Bearer ${placeholder}' } };
        const ok = await fetch('https://upstream.test/hello?x=1', base);
        console.log(JSON.stringify({ kind: 'ok', status: ok.status, body: await ok.json() }));
        const leak = await fetch('https://upstream.test/leak', { headers: { authorization: 'Bearer ${otherPlaceholder}' } });
        console.log(JSON.stringify({ kind: 'leak', status: leak.status }));
        const reverse = await fetch('http://broker:8080/anthropic/v1/messages?x=1', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"hello":"world"}',
        });
        console.log(JSON.stringify({ kind: 'reverse', status: reverse.status, body: await reverse.json() }));
        const bodyLeak = await fetch('https://upstream.test/body', {
          method: 'POST',
          headers: { authorization: 'Bearer ${placeholder}', 'content-type': 'application/json' },
          body: '{"token":"${placeholder}"}',
        });
        console.log(JSON.stringify({ kind: 'body', status: bodyLeak.status }));
        try {
          const direct = await fetch('https://example.com/', { signal: AbortSignal.timeout(4000) });
          console.log(JSON.stringify({ kind: 'direct', status: direct.status }));
        } catch (error) {
          console.log(JSON.stringify({ kind: 'direct', error: true }));
        }
      })().catch((error) => { console.log(JSON.stringify({ kind: 'error', message: String(error) })); process.exit(3); });
    `;
    const sandbox = await dockerRun([
      'run',
      '--rm',
      '--network',
      internalNet,
      '--dns',
      brokerIp,
      '-v',
      `${certDir}:/certs:ro`,
      '-e',
      'NODE_EXTRA_CA_CERTS=/certs/broker-ca.pem',
      '--entrypoint',
      'node',
      brokerImage,
      '-e',
      script,
    ], 60_000);
    const lines = sandbox.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const ok = lines.find((line) => line.kind === 'ok');
    expect(ok?.status).toBe(200);
    const body = ok?.body as { authorization?: string; path?: string } | undefined;
    expect(body?.authorization).toBe(`Bearer ${secret}`);
    expect(body?.path).toBe('/hello?x=1');
    expect(lines.find((line) => line.kind === 'leak')?.status).toBe(403);
    expect(lines.find((line) => line.kind === 'direct')?.error).toBe(true);
    const reverse = lines.find((line) => line.kind === 'reverse');
    expect(reverse?.status).toBe(200);
    const reverseBody = reverse?.body as { authorization?: string; path?: string; body?: string } | undefined;
    expect(reverseBody?.authorization).toBe(`Bearer ${secret}`);
    expect(reverseBody?.path).toBe('/v1/messages?x=1');
    expect(reverseBody?.body).toBe('{"hello":"world"}');
    expect(lines.find((line) => line.kind === 'body')?.status).toBe(400);

    const audit = await readFile(path.join(auditDir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"action":"allow"');
    expect(audit).toContain('"reason":"placeholder_leak_attempt"');
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain(placeholder);
    expect(audit).not.toContain('authorization');
  }, 120_000);
});
