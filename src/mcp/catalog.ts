import { CoveError } from '../core/errors.js';

export type McpTransport =
  | {
      type: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    };

export interface McpSecretSpec {
  id: string;
  label: string;
  helpUrl: string;
  hosts: string[];
  envName?: string;
  header?: string;
  scheme?: string;
}

export interface McpPreset {
  id: string;
  title: string;
  description: string;
  category: 'developer' | 'search' | 'files';
  risk: 'read' | 'write';
  transport: McpTransport;
  hosts: string[];
  methods: string[];
  secret?: McpSecretSpec;
  docsUrl: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'github',
    title: 'GitHub',
    description: '读取仓库、Issue、PR，并可执行 token 允许的写操作。建议使用 fine-grained PAT。',
    category: 'developer',
    risk: 'write',
    transport: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer {{secret:github}}' },
    },
    hosts: ['api.githubcopilot.com'],
    methods: ['GET', 'POST'],
    secret: {
      id: 'github',
      label: 'GitHub fine-grained PAT',
      helpUrl: 'https://github.com/settings/personal-access-tokens',
      hosts: ['api.githubcopilot.com'],
      header: 'authorization',
      scheme: 'Bearer ',
    },
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'brave',
    title: 'Brave Search',
    description: '通过 Brave Search API 进行网页搜索。',
    category: 'search',
    risk: 'read',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server@2.1.4'],
      env: { BRAVE_API_KEY: '{{secret:brave}}' },
    },
    hosts: ['api.search.brave.com'],
    methods: ['GET', 'POST'],
    secret: {
      id: 'brave',
      label: 'Brave Search API key',
      helpUrl: 'https://api.search.brave.com/app/keys',
      hosts: ['api.search.brave.com'],
      envName: 'BRAVE_API_KEY',
    },
    docsUrl: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'tavily',
    title: 'Tavily',
    description: '面向 Agent 的网页搜索与内容提取。',
    category: 'search',
    risk: 'read',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'tavily-mcp@0.2.22'],
      env: { TAVILY_API_KEY: '{{secret:tavily}}' },
    },
    hosts: ['api.tavily.com'],
    methods: ['GET', 'POST'],
    secret: {
      id: 'tavily',
      label: 'Tavily API key',
      helpUrl: 'https://app.tavily.com/home',
      hosts: ['api.tavily.com'],
      envName: 'TAVILY_API_KEY',
    },
    docsUrl: 'https://github.com/tavily-ai/tavily-mcp',
  },
  {
    id: 'exa',
    title: 'Exa',
    description: '语义搜索与网页内容获取。',
    category: 'search',
    risk: 'read',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'exa-mcp-server@3.4.2'],
      env: { EXA_API_KEY: '{{secret:exa}}' },
    },
    hosts: ['api.exa.ai'],
    methods: ['GET', 'POST'],
    secret: {
      id: 'exa',
      label: 'Exa API key',
      helpUrl: 'https://dashboard.exa.ai/api-keys',
      hosts: ['api.exa.ai'],
      envName: 'EXA_API_KEY',
    },
    docsUrl: 'https://github.com/exa-labs/exa-mcp-server',
  },
  {
    id: 'firecrawl',
    title: 'Firecrawl',
    description: '网页抓取、爬取与结构化提取。',
    category: 'search',
    risk: 'read',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp@3.34.1'],
      env: { FIRECRAWL_API_KEY: '{{secret:firecrawl}}' },
    },
    hosts: ['api.firecrawl.dev'],
    methods: ['GET', 'POST'],
    secret: {
      id: 'firecrawl',
      label: 'Firecrawl API key',
      helpUrl: 'https://www.firecrawl.dev/app/api-keys',
      hosts: ['api.firecrawl.dev'],
      envName: 'FIRECRAWL_API_KEY',
    },
    docsUrl: 'https://github.com/firecrawl/firecrawl-mcp-server',
  },
  {
    id: 'context7',
    title: 'Context7',
    description: '按版本检索库文档，减少过时 API 幻觉。',
    category: 'developer',
    risk: 'read',
    transport: {
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
    },
    hosts: ['mcp.context7.com'],
    methods: ['GET', 'POST'],
    docsUrl: 'https://github.com/upstash/context7',
  },
  {
    id: 'filesystem',
    title: 'Filesystem',
    description: '在 /workspace 内读写文件。无需任何密钥。',
    category: 'files',
    risk: 'write',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2.0.1', '/workspace'],
    },
    hosts: [],
    methods: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
] as const;

export function findPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}

export function requirePreset(id: string): McpPreset {
  const preset = findPreset(id);
  if (preset === undefined) {
    throw new CoveError('MCP_UNKNOWN', `未知的 MCP preset: ${id}`, {
      hint: `可用 preset: ${MCP_PRESETS.map((item) => item.id).join(', ')}`,
    });
  }
  return preset;
}
