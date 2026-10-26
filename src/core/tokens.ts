import { randomBytes, randomUUID } from 'node:crypto';

export function newSessionId(): string {
  return randomUUID();
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function newPlaceholder(prefix = 'cove'): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'cove';
  return `${safePrefix}_${randomBytes(18).toString('base64url')}`;
}

const SECRET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isSecretId(value: string): boolean {
  return SECRET_ID.test(value);
}
