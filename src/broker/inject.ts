import type { CredentialConfig } from './types.js';

export function injectCredential(
  headers: Record<string, string | string[] | undefined>,
  credential: CredentialConfig,
): void {
  if (credential.inject.mode === 'force') {
    const name = credential.inject.header.toLowerCase();
    deleteHeader(headers, name);
    headers[name] = `${credential.inject.scheme ?? ''}${credential.value}`;
    return;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const replaced = value.map((item) => item.split(credential.placeholder).join(credential.value));
      if (replaced.some((item, index) => item !== value[index])) headers[name] = replaced;
      continue;
    }
    if (value.includes(credential.placeholder)) {
      headers[name] = value.split(credential.placeholder).join(credential.value);
    }
  }
}

export function sanitizeInboundHeaders(
  headers: Record<string, string | string[] | undefined>,
  targetHost: string,
): Record<string, string | string[] | undefined> {
  const output: Record<string, string | string[] | undefined> = {};
  const blocked = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
  ]);
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined) continue;
    if (blocked.has(name) || name.startsWith('x-cove-')) continue;
    output[name] = value;
  }
  output.host = targetHost;
  return output;
}

export function sanitizeResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const output: Record<string, string | string[] | undefined> = {};
  const blocked = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]);
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (blocked.has(name)) continue;
    output[name] = value;
  }
  return output;
}

export function deleteHeader(headers: Record<string, string | string[] | undefined>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}
