import { CoveError } from '../core/errors.js';
import type { ProjectConfig } from '../core/config.js';
import type { AgentId } from '../agents/profiles.js';
import type { McpSelection } from '../mcp/render.js';
import type { CredentialConfig, PolicyRule, ReverseRoute } from '../broker/types.js';

export interface SessionSecret {
  value: string;
  placeholder: string;
}

export interface BuildSecurityInput {
  agent: AgentId;
  secrets: Map<string, SessionSecret>;
  mcp: McpSelection[];
  project: ProjectConfig;
}

export interface SessionSecurity {
  credentials: CredentialConfig[];
  policy: PolicyRule[];
  reverseRoutes: ReverseRoute[];
}

const AGENT_PROVIDERS: Record<Exclude<AgentId, 'dsh' | 'shell'>, AgentProvider> = {
  claude: {
    secretId: 'anthropic',
    host: 'api.anthropic.com',
    paths: ['/v1/'],
    routePrefix: '/anthropic',
    upstream: 'https://api.anthropic.com',
    header: 'x-api-key',
    scheme: '',
  },
  codex: {
    secretId: 'openai',
    host: 'api.openai.com',
    paths: ['/v1/'],
    routePrefix: '/openai',
    upstream: 'https://api.openai.com',
    header: 'authorization',
    scheme: 'Bearer ',
  },
};

interface AgentProvider {
  secretId: string;
  host: string;
  paths: string[];
  routePrefix: string;
  upstream: string;
  header: string;
  scheme: string;
}

const DSH_PROVIDER: AgentProvider = {
  secretId: 'deepseek',
  host: 'api.deepseek.com',
  paths: ['/v1/', '/anthropic/v1/'],
  routePrefix: '/deepseek',
  upstream: 'https://api.deepseek.com/anthropic',
  header: 'x-api-key',
  scheme: '',
};

const PACKAGE_HOSTS: Array<{ id: string; host: string; methods: string[] }> = [
  { id: 'pkg-npm', host: 'registry.npmjs.org', methods: ['GET'] },
  { id: 'pkg-yarn', host: 'registry.yarnpkg.com', methods: ['GET'] },
  { id: 'pkg-pypi', host: 'pypi.org', methods: ['GET'] },
  { id: 'pkg-pypi-files', host: 'files.pythonhosted.org', methods: ['GET'] },
  { id: 'pkg-github', host: 'github.com', methods: ['GET'] },
  { id: 'pkg-github-codeload', host: 'codeload.github.com', methods: ['GET'] },
  { id: 'pkg-github-raw', host: 'raw.githubusercontent.com', methods: ['GET'] },
  { id: 'pkg-github-objects', host: 'objects.githubusercontent.com', methods: ['GET'] },
];

export function buildSessionSecurity(input: BuildSecurityInput): SessionSecurity {
  const rules: PolicyRule[] = PACKAGE_HOSTS.map((entry) => ({
    id: entry.id,
    host: entry.host,
    methods: entry.methods,
  }));
  const credentials = new Map<string, CredentialConfig>();
  const routes: ReverseRoute[] = [];

  const provider = input.agent === 'dsh' ? DSH_PROVIDER : input.agent === 'shell' ? undefined : AGENT_PROVIDERS[input.agent];
  if (provider !== undefined) {
    const secret = requireSecret(input.secrets, provider.secretId, input.agent);
    rules.push({
      id: `agent-${provider.secretId}`,
      host: provider.host,
      methods: ['GET', 'POST'],
      paths: provider.paths,
      credential: provider.secretId,
    });
    credentials.set(provider.secretId, {
      id: provider.secretId,
      value: secret.value,
      placeholder: secret.placeholder,
      hosts: [provider.host],
      inject: { header: provider.header, mode: 'force', scheme: provider.scheme },
    });
    routes.push({
      id: provider.secretId,
      prefix: provider.routePrefix,
      upstream: provider.upstream,
      credential: provider.secretId,
      methods: ['GET', 'POST'],
      paths: ['/v1/'],
    });
  }

  for (const selection of input.mcp) {
    const preset = selection.preset;
    if (preset.secret !== undefined) {
      const secretId = selection.secretId ?? preset.secret.id;
      const secret = requireSecret(input.secrets, secretId, `MCP ${preset.id}`);
      credentials.set(secretId, {
        id: secretId,
        value: secret.value,
        placeholder: secret.placeholder,
        hosts: [...preset.secret.hosts],
        inject: {
          header: preset.secret.header ?? 'authorization',
          mode: 'placeholder',
          ...(preset.secret.scheme === undefined ? {} : { scheme: preset.secret.scheme }),
        },
      });
      for (const host of preset.hosts) {
        rules.push({
          id: `mcp-${preset.id}-${host.replace(/[^a-z0-9]+/gu, '-')}`,
          host,
          methods: [...preset.methods],
          credential: secretId,
        });
      }
    } else {
      for (const host of preset.hosts) {
        rules.push({
          id: `mcp-${preset.id}-${host.replace(/[^a-z0-9]+/gu, '-')}`,
          host,
          methods: [...preset.methods],
        });
      }
    }
  }

  for (const extra of input.project.egress.extraHosts) {
    rules.push({
      id: `project-${extra.id}`,
      host: extra.host,
      methods: [...extra.methods],
      ...(extra.paths === undefined ? {} : { paths: [...extra.paths] }),
    });
  }

  validateUniqueIds(rules, routes);
  return {
    credentials: [...credentials.values()],
    policy: dedupeRules(rules),
    reverseRoutes: routes,
  };
}

function requireSecret(secrets: Map<string, SessionSecret>, id: string, owner: string): SessionSecret {
  const secret = secrets.get(id);
  if (secret === undefined) {
    throw new CoveError('SECRET_NOT_FOUND', `缺少 ${owner} 所需的密钥: ${id}`, {
      hint: `运行 \`cove secret set ${id}\` 后重试`,
    });
  }
  return secret;
}

function validateUniqueIds(rules: PolicyRule[], routes: ReverseRoute[]): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new CoveError('CONFIG_INVALID', `策略 ID 重复: ${rule.id}`);
    ids.add(rule.id);
  }
  const prefixes = new Set<string>();
  for (const route of routes) {
    if (prefixes.has(route.prefix)) throw new CoveError('CONFIG_INVALID', `反向代理前缀重复: ${route.prefix}`);
    prefixes.add(route.prefix);
  }
}

function dedupeRules(rules: PolicyRule[]): PolicyRule[] {
  const seen = new Set<string>();
  const output: PolicyRule[] = [];
  for (const rule of rules) {
    const key = `${rule.host}\0${rule.methods.join(',')}\0${(rule.paths ?? []).join(',')}\0${rule.credential ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(rule);
  }
  return output;
}
