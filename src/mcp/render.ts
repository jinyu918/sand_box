import { stringify as tomlStringify } from 'smol-toml';
import { stringify as yamlStringify } from 'yaml';
import { CoveError } from '../core/errors.js';
import type { McpPreset, McpTransport } from './catalog.js';

export interface McpSelection {
  preset: McpPreset;
  secretId?: string;
}

export interface PlaceholderProvider {
  placeholderFor(secretId: string): string;
}

export interface RenderedMcpConfig {
  claudeJson: string;
  codexToml: string;
  dshYaml: string;
}

export function renderMcpConfig(selections: readonly McpSelection[], placeholders: PlaceholderProvider): RenderedMcpConfig {
  return {
    claudeJson: `${JSON.stringify(renderClaude(selections, placeholders), null, 2)}\n`,
    codexToml: renderCodex(selections, placeholders),
    dshYaml: renderDsh(selections, placeholders),
  };
}

export function renderClaude(selections: readonly McpSelection[], placeholders: PlaceholderProvider): {
  mcpServers: Record<string, unknown>;
} {
  const servers: Record<string, unknown> = {};
  for (const selection of selections) {
    const transport = materialize(selection, placeholders);
    if (transport.type === 'http') {
      servers[selection.preset.id] = {
        type: 'http',
        url: transport.url,
        ...(transport.headers === undefined ? {} : { headers: transport.headers }),
      };
    } else {
      servers[selection.preset.id] = {
        command: transport.command,
        args: transport.args,
        ...(transport.env === undefined ? {} : { env: transport.env }),
      };
    }
  }
  return { mcpServers: servers };
}

export function renderCodex(selections: readonly McpSelection[], placeholders: PlaceholderProvider): string {
  const servers: Record<string, unknown> = {};
  for (const selection of selections) {
    const transport = materialize(selection, placeholders);
    if (transport.type === 'http') {
      servers[selection.preset.id] = {
        url: transport.url,
        enabled: true,
        ...(transport.headers === undefined ? {} : { http_headers: transport.headers }),
      };
    } else {
      servers[selection.preset.id] = {
        command: transport.command,
        args: transport.args,
        enabled: true,
        ...(transport.env === undefined ? {} : { env: transport.env }),
      };
    }
  }
  return tomlStringify({
    model_provider: 'cove',
    preferred_auth_method: 'apikey',
    sandbox_mode: 'danger-full-access',
    approval_policy: 'never',
    model_providers: {
      cove: {
        name: 'Cove',
        base_url: 'http://broker:8080/openai/v1',
        env_key: 'OPENAI_API_KEY',
        wire_api: 'responses',
      },
    },
    mcp_servers: servers,
  });
}

export function renderDsh(selections: readonly McpSelection[], placeholders: PlaceholderProvider): string {
  if (selections.length === 0) return '[]\n';
  const entries = selections.map((selection) => {
    const transport = materialize(selection, placeholders);
    const config: Record<string, unknown> = {
      serverName: selection.preset.id,
      ...(transport.type === 'http'
        ? {
            transport: 'streamable-http',
            url: transport.url,
            ...(transport.headers === undefined ? {} : { headers: transport.headers }),
          }
        : {
            transport: 'stdio',
            command: transport.command,
            args: transport.args,
            ...(transport.env === undefined ? {} : { env: transport.env }),
          }),
    };
    return {
      id: `cove-mcp-${selection.preset.id}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config,
    };
  });
  return yamlStringify([{ insert: entries }], { lineWidth: 0 });
}

function materialize(selection: McpSelection, placeholders: PlaceholderProvider): McpTransport {
  const { transport } = selection.preset;
  if (transport.type === 'http') {
    const headers = transport.headers === undefined ? undefined : replaceTemplates(transport.headers, placeholders, selection);
    return { type: 'http', url: transport.url, ...(headers === undefined ? {} : { headers }) };
  }
  const env = transport.env === undefined ? undefined : replaceTemplates(transport.env, placeholders, selection);
  return {
    type: 'stdio',
    command: transport.command,
    args: [...transport.args],
    ...(env === undefined ? {} : { env }),
  };
}

function replaceTemplates(
  input: Record<string, string>,
  placeholders: PlaceholderProvider,
  selection: McpSelection,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = value.replace(/\{\{secret:([a-z0-9._-]+)\}\}/gu, (_match, secretId: string) => {
      if (selection.secretId !== undefined && selection.secretId !== secretId) {
        throw new CoveError('MCP_UNKNOWN', `MCP ${selection.preset.id} 的 secret 引用不一致`);
      }
      return placeholders.placeholderFor(secretId);
    });
  }
  return output;
}
