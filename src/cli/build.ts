import { existsSync } from 'node:fs';
import path from 'node:path';
import { CoveError } from '../core/errors.js';
import { packageRoot } from './context.js';
import type { CliContext } from './context.js';

export async function buildImages(ctx: CliContext): Promise<void> {
  const root = packageRoot();
  const brokerBundle = path.join(root, 'dist', 'broker.cjs');
  if (!existsSync(brokerBundle)) {
    throw new CoveError('IMAGE_MISSING', '缺少 broker 构建产物', {
      hint: '在 Cove 仓库运行 `pnpm build` 后再执行 `cove build`',
    });
  }
  const sandboxDockerfile = path.join(root, 'docker', 'sandbox.Dockerfile');
  const brokerDockerfile = path.join(root, 'docker', 'broker.Dockerfile');
  if (!existsSync(sandboxDockerfile) || !existsSync(brokerDockerfile)) {
    throw new CoveError('IMAGE_MISSING', '找不到 Dockerfile', { hint: '确认安装目录完整' });
  }
  await ctx.docker.build(ctx.config.images.broker, brokerDockerfile, root);
  const sandboxArgs: Record<string, string> = {
    CLAUDE_CODE_VERSION: '2.1.310',
    CODEX_VERSION: '0.164.0',
    DSH_VERSION: '0.2.1-rc.2',
  };
  if (process.env.COVE_APT_MIRROR !== undefined && process.env.COVE_APT_MIRROR.length > 0) {
    sandboxArgs.APT_MIRROR = process.env.COVE_APT_MIRROR;
  }
  await ctx.docker.build(ctx.config.images.sandbox, sandboxDockerfile, root, sandboxArgs);
}
