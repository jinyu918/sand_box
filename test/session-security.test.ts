import { describe, expect, it } from 'vitest';
import { requirePreset } from '../src/mcp/catalog.js';
import { buildSessionSecurity } from '../src/session/security.js';
import { validateProjectConfig } from '../src/core/config.js';

const project = validateProjectConfig({ version: 1 });

describe('session security', () => {
  it('builds Claude provider rules, reverse route and credential', () => {
    const security = buildSessionSecurity({
      agent: 'claude',
      secrets: new Map([['anthropic', { value: 'sk-ant-real', placeholder: 'sk-ant-cove_placeholder' }]]),
      mcp: [],
      project,
    });
    expect(security.credentials).toEqual([
      {
        id: 'anthropic',
        value: 'sk-ant-real',
        placeholder: 'sk-ant-cove_placeholder',
        hosts: ['api.anthropic.com'],
        inject: { header: 'x-api-key', mode: 'force', scheme: '' },
      },
    ]);
    expect(security.policy).toContainEqual({
      id: 'agent-anthropic',
      host: 'api.anthropic.com',
      methods: ['GET', 'POST'],
      paths: ['/v1/'],
      credential: 'anthropic',
    });
    expect(security.reverseRoutes[0]).toMatchObject({
      prefix: '/anthropic',
      upstream: 'https://api.anthropic.com',
      credential: 'anthropic',
    });
  });

  it('adds MCP host rules and placeholder credentials', () => {
    const security = buildSessionSecurity({
      agent: 'shell',
      secrets: new Map([['github', { value: 'ghp_real', placeholder: 'cove-github_placeholder' }]]),
      mcp: [{ preset: requirePreset('github') }],
      project,
    });
    expect(security.policy).toContainEqual({
      id: 'mcp-github-api-githubcopilot-com',
      host: 'api.githubcopilot.com',
      methods: ['GET', 'POST'],
      credential: 'github',
    });
    expect(security.credentials[0]).toMatchObject({
      id: 'github',
      value: 'ghp_real',
      placeholder: 'cove-github_placeholder',
      inject: { header: 'authorization', mode: 'placeholder' },
    });
  });

  it('fails closed when a required secret is missing', () => {
    expect(() =>
      buildSessionSecurity({
        agent: 'codex',
        secrets: new Map(),
        mcp: [],
        project,
      }),
    ).toThrowError(/openai/);
  });

  it('includes project allow rules', () => {
    const config = validateProjectConfig({
      version: 1,
      egress: { extraHosts: [{ id: 'internal', host: 'api.internal.example', methods: ['GET'], paths: ['/v1'] }] },
    });
    const security = buildSessionSecurity({ agent: 'shell', secrets: new Map(), mcp: [], project: config });
    expect(security.policy).toContainEqual({
      id: 'project-internal',
      host: 'api.internal.example',
      methods: ['GET'],
      paths: ['/v1'],
    });
  });

  it('does not include a provider route for shell', () => {
    const security = buildSessionSecurity({ agent: 'shell', secrets: new Map(), mcp: [], project });
    expect(security.reverseRoutes).toEqual([]);
  });
});
