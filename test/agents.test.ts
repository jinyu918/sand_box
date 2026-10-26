import { describe, expect, it } from 'vitest';
import { buildAgentLaunch } from '../src/agents/profiles.js';

const placeholders = new Map([
  ['anthropic', 'sk-ant-cove_ph'],
  ['openai', 'sk-cove_ph'],
  ['deepseek', 'cove-deepseek_ph'],
]);

describe('agent launch', () => {
  it('configures Claude Code with a placeholder and broker base URL', () => {
    const launch = buildAgentLaunch('claude', { args: ['--resume'], placeholders });
    expect(launch.command).toEqual([
      'claude',
      '--mcp-config',
      '/cove/config/claude-mcp.json',
      '--strict-mcp-config',
      '--resume',
    ]);
    expect(launch.env.ANTHROPIC_API_KEY).toBe('sk-ant-cove_ph');
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://broker:8080/anthropic');
    expect(launch.env.NODE_EXTRA_CA_CERTS).toBe('/cove/config/ca-bundle.pem');
    expect(launch.mode).toBe('tty');
  });

  it('configures Codex with CODEX_HOME and a placeholder', () => {
    const launch = buildAgentLaunch('codex', { args: [], placeholders });
    expect(launch.command).toEqual(['codex']);
    expect(launch.env.OPENAI_API_KEY).toBe('sk-cove_ph');
    expect(launch.env.CODEX_HOME).toBe('/home/agent/.codex');
  });

  it('configures DSH web with loopback publishing metadata', () => {
    const launch = buildAgentLaunch('dsh', {
      args: [],
      placeholders,
      dsh: { port: 7788, publicUrl: 'http://127.0.0.1:4567', trustedHost: '127.0.0.1:4567' },
    });
    expect(launch.mode).toBe('dsh-web');
    expect(launch.env.DEEPSEEK_API_KEY).toBe('cove-deepseek_ph');
    expect(launch.env.DEEPSEEK_BASE_URL).toBe('http://broker:8080/deepseek');
    expect(launch.env.COVE_DSH_PORT).toBe('7788');
  });

  it('fails when the required placeholder is absent', () => {
    expect(() => buildAgentLaunch('claude', { args: [], placeholders: new Map() })).toThrow();
  });
});
