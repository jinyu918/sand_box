import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { requirePreset } from '../src/mcp/catalog.js';
import { renderMcpConfig, type McpSelection } from '../src/mcp/render.js';

const placeholders = new Map([
  ['github', 'cove-github_placeholder_123456'],
  ['brave', 'cove-brave_placeholder_123456'],
]);

const provider = {
  placeholderFor(id: string): string {
    const value = placeholders.get(id);
    if (value === undefined) throw new Error(`missing ${id}`);
    return value;
  },
};

const selections: McpSelection[] = [
  { preset: requirePreset('github') },
  { preset: requirePreset('brave') },
  { preset: requirePreset('filesystem') },
];

describe('MCP config rendering', () => {
  it('renders Claude JSON with placeholders only', () => {
    const output = renderMcpConfig(selections, provider);
    const parsed = JSON.parse(output.claudeJson) as {
      mcpServers: Record<string, { type?: string; command?: string; headers?: Record<string, string>; env?: Record<string, string> }>;
    };
    expect(parsed.mcpServers.github?.type).toBe('http');
    expect(parsed.mcpServers.github?.headers?.Authorization).toBe('Bearer cove-github_placeholder_123456');
    expect(parsed.mcpServers.brave?.env?.BRAVE_API_KEY).toBe('cove-brave_placeholder_123456');
    expect(parsed.mcpServers.filesystem?.command).toBe('npx');
    expect(output.claudeJson).not.toContain('ghp_');
  });

  it('renders Codex TOML with the Cove provider and MCP entries', () => {
    const output = renderMcpConfig(selections, provider);
    const parsed = parseToml(output.codexToml) as {
      model_provider: string;
      model_providers: { cove: { base_url: string; env_key: string } };
      mcp_servers: Record<string, { url?: string; http_headers?: Record<string, string>; env?: Record<string, string> }>;
    };
    expect(parsed.model_provider).toBe('cove');
    expect(parsed.model_providers.cove.base_url).toBe('http://broker:8080/openai/v1');
    expect(parsed.model_providers.cove.env_key).toBe('OPENAI_API_KEY');
    expect(parsed.mcp_servers.github?.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(parsed.mcp_servers.github?.http_headers?.Authorization).toBe('Bearer cove-github_placeholder_123456');
    expect(parsed.mcp_servers.brave?.env?.BRAVE_API_KEY).toBe('cove-brave_placeholder_123456');
  });

  it('renders a DSH insert patch', () => {
    const output = renderMcpConfig(selections, provider);
    const parsed = parseYaml(output.dshYaml) as Array<{
      insert: Array<{ id: string; name: string; config: Record<string, unknown> }>;
    }>;
    expect(parsed[0]?.insert).toHaveLength(3);
    expect(parsed[0]?.insert[0]?.name).toBe('@deepseek-ai/dsh-mcp-client');
    expect(parsed[0]?.insert[0]?.config).toMatchObject({
      serverName: 'github',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer cove-github_placeholder_123456' },
    });
    expect(parsed[0]?.insert[1]?.config).toMatchObject({
      serverName: 'brave',
      transport: 'stdio',
      env: { BRAVE_API_KEY: 'cove-brave_placeholder_123456' },
    });
  });

  it('renders empty configs without MCP', () => {
    const output = renderMcpConfig([], provider);
    expect(JSON.parse(output.claudeJson)).toEqual({ mcpServers: {} });
    expect(output.dshYaml.trim()).toBe('[]');
  });
});
