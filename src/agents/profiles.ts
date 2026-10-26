import { CoveError } from '../core/errors.js';

export type AgentId = 'claude' | 'codex' | 'dsh' | 'shell';

export interface AgentMeta {
  id: AgentId;
  label: string;
  description: string;
  secretId?: string;
  defaultCommand: string[];
}

export interface AgentLaunch {
  command: string[];
  env: Record<string, string>;
  mode: 'tty' | 'dsh-web';
}

export interface BuildLaunchOptions {
  args: string[];
  placeholders: Map<string, string>;
  dsh?: { port: number; publicUrl: string; trustedHost: string };
}

export const AGENTS: readonly AgentMeta[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    description: 'Anthropic 官方终端 Agent',
    secretId: 'anthropic',
    defaultCommand: ['claude', '--mcp-config', '/cove/config/claude-mcp.json', '--strict-mcp-config'],
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex CLI',
    secretId: 'openai',
    defaultCommand: ['codex'],
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    description: 'DSH Web UI（仅本机访问）',
    secretId: 'deepseek',
    defaultCommand: ['dsh'],
  },
  {
    id: 'shell',
    label: 'Shell',
    description: '在沙箱内打开 bash，用于调试',
    defaultCommand: ['bash'],
  },
] as const;

export function isAgentId(value: string): value is AgentId {
  return AGENTS.some((agent) => agent.id === value);
}

export function requireAgent(value: string): AgentMeta {
  const agent = AGENTS.find((item) => item.id === value);
  if (agent === undefined) {
    throw new CoveError('AGENT_UNKNOWN', `未知的 Agent: ${value}`, {
      hint: `可用: ${AGENTS.map((item) => item.id).join(', ')}`,
    });
  }
  return agent;
}

export function buildAgentLaunch(agentId: AgentId, options: BuildLaunchOptions): AgentLaunch {
  const agent = requireAgent(agentId);
  const env = baseEnvironment();
  const command = [...agent.defaultCommand, ...options.args];

  switch (agentId) {
    case 'claude': {
      env.ANTHROPIC_API_KEY = requirePlaceholder(options.placeholders, 'anthropic');
      env.ANTHROPIC_BASE_URL = 'http://broker:8080/anthropic';
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      env.DISABLE_TELEMETRY = '1';
      return { command, env, mode: 'tty' };
    }
    case 'codex': {
      env.OPENAI_API_KEY = requirePlaceholder(options.placeholders, 'openai');
      env.CODEX_HOME = '/home/agent/.codex';
      env.CODEX_DISABLE_TELEMETRY = '1';
      return { command, env, mode: 'tty' };
    }
    case 'dsh': {
      if (options.dsh === undefined) {
        throw new CoveError('AGENT_CONFIG_INVALID', 'DSH 需要 Web 端口配置');
      }
      env.DEEPSEEK_API_KEY = requirePlaceholder(options.placeholders, 'deepseek');
      env.DEEPSEEK_BASE_URL = 'http://broker:8080/deepseek';
      env.COVE_AGENT = 'dsh';
      env.COVE_DSH_PORT = String(options.dsh.port);
      env.COVE_DSH_PUBLIC_URL = options.dsh.publicUrl;
      env.COVE_DSH_TRUSTED_HOST = options.dsh.trustedHost;
      return { command, env, mode: 'dsh-web' };
    }
    case 'shell':
      return { command, env, mode: 'tty' };
  }
}

function baseEnvironment(): Record<string, string> {
  const bundle = '/cove/config/ca-bundle.pem';
  return {
    HOME: '/home/agent',
    DSH_HOME: '/home/agent/.dsh',
    CODEX_HOME: '/home/agent/.codex',
    XDG_CONFIG_HOME: '/home/agent/.config',
    npm_config_cache: '/home/agent/.npm',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    TERM: process.env.TERM ?? 'xterm-256color',
    LANG: 'C.UTF-8',
    NODE_EXTRA_CA_CERTS: bundle,
    SSL_CERT_FILE: bundle,
    REQUESTS_CA_BUNDLE: bundle,
    CURL_CA_BUNDLE: bundle,
    GIT_SSL_CAINFO: bundle,
    PIP_CERT: bundle,
    CODEX_CA_CERTIFICATE: bundle,
  };
}

function requirePlaceholder(placeholders: Map<string, string>, id: string): string {
  const placeholder = placeholders.get(id);
  if (placeholder === undefined) {
    throw new CoveError('AGENT_CONFIG_INVALID', `缺少 ${id} 的占位符`, {
      hint: `先运行 \`cove secret set ${id}\``,
    });
  }
  return placeholder;
}
