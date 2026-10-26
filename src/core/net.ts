import net from 'node:net';
import { CoveError } from './errors.js';

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHost(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/\.$/u, '');
  if (host.length === 0 || host.length > 253) {
    throw new CoveError('CONFIG_INVALID', `Invalid host: ${JSON.stringify(raw.slice(0, 80))}`);
  }
  if (net.isIP(host) !== 0) {
    throw new CoveError('CONFIG_INVALID', `IP literals are not allowed: ${host}`);
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new CoveError('CONFIG_INVALID', `Local host names are not allowed: ${host}`);
  }
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) {
    throw new CoveError('CONFIG_INVALID', `Invalid host: ${host}`);
  }
  return host;
}

export function hostMatches(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return false;
}

export function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

export function normalizeRequestPath(rawPath: string): string {
  let pathname: string;
  try {
    pathname = new URL(rawPath, 'https://cove.invalid').pathname;
  } catch {
    throw new CoveError('POLICY_DENIED', 'Invalid request path');
  }
  if (pathname.length === 0) return '/';
  try {
    const decoded = decodeURIComponent(pathname);
    return new URL(decoded, 'https://cove.invalid').pathname || '/';
  } catch {
    return pathname;
  }
}

export function pathMatchesPrefix(pathname: string, prefixes: readonly string[] | undefined): boolean {
  if (prefixes === undefined || prefixes.length === 0) return true;
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80')) return true;
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice('::ffff:'.length));
  }
  return false;
}
