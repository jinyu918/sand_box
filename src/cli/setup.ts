import { loadOrCreateCa } from '../broker/ca.js';
import { ensureDir, hardenWindowsAcl } from '../core/fs.js';
import { saveGlobalConfig } from '../core/config.js';
import { buildImages } from './build.js';
import { fail, ok, out, warn, heading } from './prompt.js';
import type { CliContext } from './context.js';

export interface SetupOptions {
  build: boolean;
  autoBuild?: boolean;
}

export async function runSetup(ctx: CliContext, options: SetupOptions): Promise<void> {
  heading('Cove setup');
  await ensureDir(ctx.paths.home, 0o700);
  await ensureDir(ctx.paths.sessionsDir, 0o700);
  await ensureDir(ctx.paths.caDir, 0o700);
  await hardenWindowsAcl(ctx.paths.home, true);

  const info = await ctx.docker.info();
  ok(`Docker Desktop ${info.serverVersion} (${info.os}/${info.arch})`);

  await saveGlobalConfig(ctx.paths, ctx.config);
  ok(`配置 ${ctx.paths.configFile}`);

  await loadOrCreateCa(ctx.paths, ctx.vault);
  ok('本地 CA 与 DPAPI 保险箱就绪');

  const brokerExists = await ctx.docker.imageExists(ctx.config.images.broker);
  const sandboxExists = await ctx.docker.imageExists(ctx.config.images.sandbox);
  if (options.build || (options.autoBuild !== false && (!brokerExists || !sandboxExists))) {
    out('构建镜像（首次可能需要数分钟）...');
    await buildImages(ctx);
    ok('镜像构建完成');
  } else {
    ok('镜像已存在');
  }

  const imagesReady = (await ctx.docker.imageExists(ctx.config.images.broker)) &&
    (await ctx.docker.imageExists(ctx.config.images.sandbox));
  if (!imagesReady) {
    warn('镜像尚未就绪；运行 `cove build` 完成构建');
  }

  heading('下一步');
  const secrets = await ctx.vault.list().catch(() => []);
  if (secrets.length === 0) {
    out('  cove secret set anthropic      # 保存 Anthropic API Key');
  }
  out('  cove mcp add github            # 可选：接入 MCP');
  out('  cd <project> && cove run claude');
  out('  cove ui                        # 打开本地控制台');
  if (secrets.length > 0 && !imagesReady) {
    fail('初始化未完成：镜像缺失');
  }
}
