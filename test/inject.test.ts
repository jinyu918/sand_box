import { describe, expect, it } from 'vitest';
import { injectCredential, sanitizeInboundHeaders, sanitizeResponseHeaders } from '../src/broker/inject.js';
import type { CredentialConfig } from '../src/broker/types.js';

const credential: CredentialConfig = {
  id: 'github',
  value: 'ghp_real_secret',
  placeholder: 'cove_placeholder_1234567890',
  hosts: ['api.githubcopilot.com'],
  inject: { header: 'authorization', mode: 'placeholder', scheme: 'Bearer ' },
};

describe('credential injection', () => {
  it('replaces placeholders inside header values', () => {
    const headers = { authorization: 'Bearer cove_placeholder_1234567890', accept: 'application/json' };
    injectCredential(headers, credential);
    expect(headers.authorization).toBe('Bearer ghp_real_secret');
    expect(headers.accept).toBe('application/json');
  });

  it('does not inject when no placeholder is present', () => {
    const headers = { authorization: 'Bearer unrelated' };
    injectCredential(headers, credential);
    expect(headers.authorization).toBe('Bearer unrelated');
  });

  it('force-injects and replaces any client-supplied header', () => {
    const force: CredentialConfig = {
      id: 'anthropic',
      value: 'sk-ant-real',
      placeholder: 'sk-ant-placeholder-1234',
      hosts: ['api.anthropic.com'],
      inject: { header: 'x-api-key', mode: 'force' },
    };
    const headers: Record<string, string> = { 'X-Api-Key': 'attacker', authorization: 'Bearer x' };
    injectCredential(headers, force);
    expect(headers['x-api-key']).toBe('sk-ant-real');
    expect(headers['X-Api-Key']).toBeUndefined();
    expect(headers.authorization).toBe('Bearer x');
  });

  it('adds a scheme for force mode', () => {
    const force: CredentialConfig = {
      id: 'openai',
      value: 'sk-real',
      placeholder: 'sk-placeholder-1234',
      hosts: ['api.openai.com'],
      inject: { header: 'authorization', mode: 'force', scheme: 'Bearer ' },
    };
    const headers: Record<string, string> = {};
    injectCredential(headers, force);
    expect(headers.authorization).toBe('Bearer sk-real');
  });

  it('strips hop-by-hop and internal headers', () => {
    const headers = sanitizeInboundHeaders(
      {
        host: 'wrong.example',
        connection: 'keep-alive',
        'proxy-authorization': 'Basic x',
        'x-cove-token': 'secret',
        accept: 'text/plain',
        'content-length': '10',
      },
      'api.example.com',
    );
    expect(headers.host).toBe('api.example.com');
    expect(headers.accept).toBe('text/plain');
    expect(headers['proxy-authorization']).toBeUndefined();
    expect(headers['x-cove-token']).toBeUndefined();
    expect(headers.connection).toBeUndefined();
  });

  it('strips hop-by-hop response headers', () => {
    expect(
      sanitizeResponseHeaders({ connection: 'close', 'transfer-encoding': 'chunked', 'content-type': 'text/plain' }),
    ).toEqual({ 'content-type': 'text/plain' });
  });
});
