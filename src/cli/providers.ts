import { MCP_PRESETS } from '../mcp/catalog.js';

export interface KnownSecret {
  id: string;
  label: string;
  hosts: string[];
  helpUrl?: string;
}

const BASE: KnownSecret[] = [
  { id: 'anthropic', label: 'Anthropic API Key', hosts: ['api.anthropic.com'], helpUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI API Key', hosts: ['api.openai.com'], helpUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', label: 'DeepSeek API Key', hosts: ['api.deepseek.com'], helpUrl: 'https://platform.deepseek.com/api_keys' },
];

export function knownSecrets(): KnownSecret[] {
  const byId = new Map(BASE.map((secret) => [secret.id, secret]));
  for (const preset of MCP_PRESETS) {
    if (preset.secret === undefined) continue;
    const existing = byId.get(preset.secret.id);
    byId.set(preset.secret.id, {
      id: preset.secret.id,
      label: preset.secret.label,
      hosts: [...new Set([...(existing?.hosts ?? []), ...preset.secret.hosts])],
      helpUrl: preset.secret.helpUrl,
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function knownSecret(id: string): KnownSecret | undefined {
  return knownSecrets().find((secret) => secret.id === id);
}
