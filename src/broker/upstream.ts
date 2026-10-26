import dns from 'node:dns/promises';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { isPrivateAddress, normalizeHost } from '../core/net.js';

export class UpstreamError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UpstreamError';
    this.code = code;
  }
}

export interface OpenUpstreamOptions {
  host: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  allowLoopback: boolean;
  ca?: string;
}

export interface UpstreamResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
}

export async function openUpstream(options: OpenUpstreamOptions): Promise<UpstreamResponse> {
  const host = normalizeHost(options.host);
  const requestPath = options.path.startsWith('/') ? options.path : '/';
  const addresses = await dns.lookup(host, { family: 4, all: true }).catch((error) => {
    throw new UpstreamError('dns_failed', `DNS lookup failed for ${host}`, { cause: error });
  });
  const usable = addresses.filter((entry) => options.allowLoopback || !isPrivateAddress(entry.address));
  if (usable.length === 0) {
    throw new UpstreamError('private_address', 'Upstream resolved to a private or reserved address');
  }
  const address = usable[0]?.address;
  if (address === undefined) throw new UpstreamError('dns_failed', 'No upstream address');

  const headers: Record<string, string | string[] | undefined> = { ...options.headers, host };
  if (options.method !== 'GET' && options.method !== 'HEAD') {
    headers['content-length'] = String(options.body.length);
  }

  return await new Promise<UpstreamResponse>((resolve, reject) => {
    const request = https.request(
      {
        protocol: 'https:',
        host: address,
        port: 443,
        servername: host,
        method: options.method,
        path: requestPath,
        headers,
        rejectUnauthorized: true,
        agent: false,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      },
      (response) => {
        resolve({
          statusCode: response.statusCode ?? 502,
          headers: response.headers,
          stream: response,
        });
      },
    );
    request.setTimeout(60_000, () => {
      request.destroy(new UpstreamError('timeout', 'Upstream request timed out'));
    });
    request.on('error', (error) => {
      reject(new UpstreamError('upstream_failed', 'Upstream request failed', { cause: error }));
    });
    request.end(options.body);
  });
}
