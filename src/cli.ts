#!/usr/bin/env node
import { Command } from 'commander';
import { loadMcpState, saveMcpState } from './core/config.js';
import { CoveError, describeError } from './core/errors.js';
import { buildImages } from './cli/build.js';
import { loadCliContext, VERSION } from './cli/context.js';
import { runSetup } from './cli/setup.js';
import { runDoctor } from './cli/doctor.js';
import { readAudit } from './cli/audit.js';
import { downAll, downSession } from './cli/down.js';
import { printTable, showStatus } from './cli/status.js';
import { heading, out, promptHidden, readStdin } from './cli/prompt.js';
import { knownSecret } from './cli/providers.js';
import { startUiServer } from './ui/server.js';
import { MCP_PRESETS, requirePreset } from './mcp/catalog.js';
import { isAgentId, AGENTS } from './agents/profiles.js';
import { runSession } from './session/lifecycle.js';
import { resolveSessionId } from './session/store.js';

const program = new Command();
program
  .name('cove')
  .description('给 AI Agent 的桌面安全舱：工作区隔离、出网收口、凭据不落地')
  .version(VERSION, '-v, --version')
  .showHelpAfterError();

program
  .command('setup')
  .description('初始化保险箱、本地 CA、配置与镜像')
  .option('--build', '构建 broker 与 sandbox 镜像', false)
  .action(async (options: { build: boolean }) => {
    const ctx = await loadCliContext();
    await runSetup(ctx, { build: options.build });
  });

program
  .command('doctor')
  .description('检查 Docker、保险箱、CA、镜像与会话状态')
  .action(async () => {
    const ctx = await loadCliContext();
    const result = await runDoctor(ctx);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('build')
  .description('构建 broker 与 sandbox 镜像')
  .action(async () => {
    const ctx = await loadCliContext();
    await buildImages(ctx);
  });

program
  .command('run')
  .description('在沙箱内运行 Agent（claude / codex / dsh / shell）')
  .argument('[agent]', 'Agent ID', 'claude')
  .argument('[args...]', '透传给 Agent 的参数（放在 -- 之后）')
  .option('--project <path>', '项目目录', process.cwd())
  .option('--allow-project-secrets', '允许项目内的 .env/私钥等文件进入沙箱', false)
  .option('--trust-project-config', '信任项目 .cove/project.json 的额外出网规则', false)
  .option('--no-open', 'DSH 启动后不自动打开浏览器')
  .option('--no-tty', '不分配 TTY（用于脚本/CI）')
  .action(async (agentArg: string, args: string[], options: { project: string; allowProjectSecrets: boolean; trustProjectConfig: boolean; open: boolean; tty: boolean }) => {
    if (!isAgentId(agentArg)) {
      throw new CoveError('AGENT_UNKNOWN', `未知的 Agent: ${agentArg}`, {
        hint: `可用: ${AGENTS.map((item) => item.id).join(', ')}`,
      });
    }
    const ctx = await loadCliContext();
    const result = await runSession(ctx, {
      projectDir: options.project,
      agent: agentArg,
      args,
      allowProjectSecrets: options.allowProjectSecrets,
      trustProjectConfig: options.trustProjectConfig,
      open: options.open,
      tty: options.tty,
    });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });

program
  .command('status')
  .description('列出本机会话')
  .action(async () => {
    const ctx = await loadCliContext();
    await showStatus(ctx);
  });

program
  .command('down')
  .description('停止并清理会话')
  .argument('[id]', '会话 ID（前 8 位即可）')
  .option('--all', '清理所有运行中的会话', false)
  .action(async (id: string | undefined, options: { all: boolean }) => {
    const ctx = await loadCliContext();
    if (options.all) {
      await downAll(ctx);
      return;
    }
    if (id === undefined) {
      throw new CoveError('SESSION_NOT_FOUND', '请指定会话 ID，或使用 --all');
    }
    await downSession(ctx, await resolveSessionId(ctx.paths, id));
  });

program
  .command('audit')
  .description('查看脱敏出网审计')
  .argument('[id]', '会话 ID')
  .option('--json', '输出 JSON', false)
  .option('--limit <number>', '最多显示条数', '50')
  .action(async (id: string | undefined, options: { json: boolean; limit: string }) => {
    const ctx = await loadCliContext();
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 50));
    const events = await readAudit(ctx.paths, id, limit);
    if (options.json) {
      out(JSON.stringify(events, null, 2));
      return;
    }
    if (events.length === 0) {
      out('还没有审计记录。');
      return;
    }
    const rows = events.map((event) => [
      new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false }),
      event.action,
      event.method || '—',
      event.host || '—',
      event.path || '—',
      String(event.status || '—'),
      event.credential || '—',
      `${event.ms}ms`,
    ]);
    printTable(['时间', '动作', '方法', '主机', '路径', '状态', '凭据', '耗时'], rows);
  });

const secret = program.command('secret').description('管理宿主侧密钥');
secret
  .command('set')
  .description('保存或轮换密钥')
  .argument('<id>', '密钥 ID，例如 anthropic')
  .option('--stdin', '从标准输入读取密钥', false)
  .option('--label <label>', '显示名称')
  .option('--hosts <hosts>', '允许注入的主机，逗号分隔')
  .action(async (id: string, options: { stdin: boolean; label?: string; hosts?: string }) => {
    const ctx = await loadCliContext();
    const known = knownSecret(id);
    const hosts = parseHosts(options.hosts) ?? known?.hosts;
    if (hosts === undefined || hosts.length === 0) {
      throw new CoveError('SECRET_INVALID', `自定义密钥 ${id} 必须用 --hosts 声明允许主机`, {
        hint: '例如 --hosts api.example.com',
      });
    }
    if (known?.helpUrl) out(`获取密钥: ${known.helpUrl}`);
    const value = options.stdin ? await readStdin() : await promptHidden(`密钥值（不回显）: `);
    if (value.length === 0) throw new CoveError('SECRET_INVALID', '密钥不能为空');
    const metadata = await ctx.vault.set(id, value, {
      ...(options.label === undefined ? (known === undefined ? {} : { label: known.label }) : { label: options.label }),
      hosts,
    });
    out(`已保存 ${metadata.id}（${metadata.hosts.join(', ')}）`);
  });

secret
  .command('list')
  .description('列出密钥元数据（不显示值）')
  .action(async () => {
    const ctx = await loadCliContext();
    const secrets = await ctx.vault.list();
    if (secrets.length === 0) {
      out('还没有密钥。运行 `cove secret set anthropic`。');
      return;
    }
    printTable(
      ['ID', '名称', '允许主机', '更新时间'],
      secrets.map((item) => [item.id, item.label, item.hosts.join(', '), item.updatedAt]),
    );
  });

secret
  .command('remove')
  .description('删除密钥')
  .argument('<id>')
  .action(async (id: string) => {
    const ctx = await loadCliContext();
    const removed = await ctx.vault.remove(id);
    out(removed ? `已删除 ${id}` : `未找到 ${id}`);
  });

const mcp = program.command('mcp').description('管理 MCP preset');
mcp
  .command('add')
  .description('接入 MCP（密钥只保存在宿主）')
  .argument('<preset>')
  .option('--secret-stdin', '从标准输入读取 MCP Token', false)
  .action(async (presetId: string, options: { secretStdin: boolean }) => {
    if (['postgres', 'mysql', 'redis', 'sqlite'].includes(presetId)) {
      throw new CoveError('MCP_UNSUPPORTED', `${presetId} 需要原始 TCP 连接，v0.1 不支持`, {
        hint: 'v0.1 只支持 HTTPS 型 MCP；原始 TCP MCP 不会被静默降级',
      });
    }
    const preset = requirePreset(presetId);
    const ctx = await loadCliContext();
    const state = await loadMcpState(ctx.paths);
    if (state.servers.some((server) => server.preset === presetId)) {
      out(`${preset.title} 已接入。`);
      return;
    }
    let secretId: string | undefined;
    if (preset.secret !== undefined) {
      secretId = preset.secret.id;
      if (!(await ctx.vault.has(secretId))) {
        if (preset.secret.helpUrl) out(`获取 Token: ${preset.secret.helpUrl}`);
        const value = options.secretStdin ? await readStdin() : await promptHidden(`${preset.secret.label}（不回显）: `);
        if (value.length === 0) throw new CoveError('SECRET_INVALID', 'Token 不能为空');
        await ctx.vault.set(secretId, value, {
          label: preset.secret.label,
          hosts: preset.secret.hosts,
        });
        out(`已保存 ${secretId}（${preset.secret.hosts.join(', ')}）`);
      }
    }
    state.servers.push({ preset: presetId, enabled: true, ...(secretId === undefined ? {} : { secretId }) });
    await saveMcpState(ctx.paths, state);
    out(`${preset.title} 已接入。下次运行 Agent 时自动生成配置。`);
  });

mcp
  .command('list')
  .description('列出 MCP 与密钥状态')
  .action(async () => {
    const ctx = await loadCliContext();
    const state = await loadMcpState(ctx.paths);
    const rows: string[][] = [];
    for (const preset of MCP_PRESETS) {
      const entry = state.servers.find((server) => server.preset === preset.id);
      const configured = preset.secret === undefined ? '无需密钥' : (await ctx.vault.has(preset.secret.id)) ? '已保存' : '缺失';
      rows.push([preset.id, preset.title, preset.transport.type, entry?.enabled === true ? '已接入' : '未接入', configured]);
    }
    printTable(['ID', '名称', '传输', '状态', 'Token'], rows);
  });

mcp
  .command('remove')
  .description('断开 MCP（不删除密钥）')
  .argument('<preset>')
  .action(async (presetId: string) => {
    const ctx = await loadCliContext();
    const state = await loadMcpState(ctx.paths);
    const next = state.servers.filter((server) => server.preset !== presetId);
    await saveMcpState(ctx.paths, { ...state, servers: next });
    out(next.length === state.servers.length ? `未接入 ${presetId}` : `已断开 ${presetId}`);
  });

program
  .command('ui')
  .description('启动本地控制台（仅 127.0.0.1）')
  .option('--port <number>', '端口', String(7777))
  .option('--no-open', '不自动打开浏览器')
  .action(async (options: { port: string; open: boolean }) => {
    const ctx = await loadCliContext();
    const port = Number(options.port);
    const server = await startUiServer(ctx, { port: Number.isFinite(port) ? port : 7777, open: options.open });
    heading('Cove 控制台');
    out(server.url);
    out('按 Ctrl-C 关闭。');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    await server.close();
  });

program.addHelpText(
  'after',
  `\n示例:\n  cove setup\n  cove secret set anthropic\n  cove mcp add github\n  cove run claude\n  cove run dsh\n  cove audit\n`,
);

void program.parseAsync(process.argv).catch((error: unknown) => {
  const detail = describeError(error);
  process.stderr.write(`\n\u001b[31merror:\u001b[0m ${detail.message}\n`);
  if (detail.hint) process.stderr.write(`  \u001b[33mwhy/fix:\u001b[0m ${detail.hint}\n`);
  if (process.env.COVE_DEBUG === '1' && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = error instanceof CoveError ? error.exitCode : 1;
});

function parseHosts(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const hosts = value.split(',').map((host) => host.trim()).filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}
