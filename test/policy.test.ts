import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/broker/policy.js';
import type { BrokerConfig } from '../src/broker/types.js';

const config: Pick<BrokerConfig, 'policy' | 'credentials'> = {
  policy: [
    { id: 'anthropic', host: 'api.anthropic.com', methods: ['GET', 'POST'], paths: ['/v1/'], credential: 'anthropic' },
    { id: 'npm', host: 'registry.npmjs.org', methods: ['GET'] },
    { id: 'wild', host: '*.example.com', methods: ['GET'] },
  ],
  credentials: [
    {
      id: 'anthropic',
      value: 'sk-real',
      placeholder: 'sk-ant-cove_placeholder',
      hosts: ['api.anthropic.com'],
      inject: { header: 'x-api-key', mode: 'force' },
    },
  ],
};

describe('PolicyEngine', () => {
  it('allows a matching host/method/path and returns the credential', () => {
    const decision = new PolicyEngine(config).evaluate('api.anthropic.com', 'POST', '/v1/messages?beta=true');
    expect(decision.allowed).toBe(true);
    expect(decision.rule?.id).toBe('anthropic');
    expect(decision.credential?.id).toBe('anthropic');
  });

  it('denies unknown hosts, methods and paths', () => {
    const policy = new PolicyEngine(config);
    expect(policy.evaluate('evil.example.net', 'GET', '/').allowed).toBe(false);
    expect(policy.evaluate('api.anthropic.com', 'DELETE', '/v1/messages').allowed).toBe(false);
    expect(policy.evaluate('api.anthropic.com', 'GET', '/admin').allowed).toBe(false);
  });

  it('allows HEAD when GET is allowed', () => {
    expect(new PolicyEngine(config).evaluate('registry.npmjs.org', 'HEAD', '/pkg').allowed).toBe(true);
  });

  it('matches wildcard subdomains but not the apex', () => {
    const policy = new PolicyEngine(config);
    expect(policy.evaluate('a.example.com', 'GET', '/').allowed).toBe(true);
    expect(policy.evaluate('a.b.example.com', 'GET', '/').allowed).toBe(true);
    expect(policy.evaluate('example.com', 'GET', '/').allowed).toBe(false);
  });

  it('detects placeholders sent to an unauthorized host', () => {
    const policy = new PolicyEngine(config);
    const leak = policy.findPlaceholderLeak(
      'evil.example.net',
      { authorization: 'Bearer sk-ant-cove_placeholder' },
      '/',
    );
    expect(leak?.id).toBe('anthropic');
    expect(
      policy.findPlaceholderLeak('api.anthropic.com', { authorization: 'Bearer sk-ant-cove_placeholder' }, '/'),
    ).toBeUndefined();
  });

  it('reports placeholder use in a URL', () => {
    const policy = new PolicyEngine(config);
    expect(policy.placeholderInUrl('/?token=sk-ant-cove_placeholder')).toBe(true);
    expect(policy.placeholderInUrl('/?token=other')).toBe(false);
  });

  it('rejects a policy that references an unknown credential', () => {
    expect(
      () =>
        new PolicyEngine({
          policy: [{ id: 'bad', host: 'api.example.com', methods: ['GET'], credential: 'missing' }],
          credentials: [],
        }),
    ).toThrow();
  });
});
