import { access } from 'node:fs/promises';
import { inspectCa } from '../broker/ca.js';
import { listSessions } from '../session/store.js';
import { fail, ok, out, warn, heading } from './prompt.js';
import type { CliContext } from './context.js';

export interface DoctorResult {
  ok: boolean;
  failures: string[];
}

export async function runDoctor(ctx: CliContext): Promise<DoctorResult> {
  heading('Cove doctor');
  const failures: string[] = [];
  const check = async (label: string, action: () => Promise<string | void>): Promise<void> => {
    try {
      const detail = await action();
      ok(detail === undefined ? label : `${label} — ${detail}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(label);
      fail(`${label} — ${message}`);
    }
  };

  await check('Docker Desktop', async () => {
    const info = await ctx.docker.info();
    return `${info.serverVersion} (${info.os}/${info.arch})`;
  });

  await check('全局配置', async () => {
    const exists = await access(ctx.paths.configFile).then(() => true).catch(() => false);
    if (!exists) throw new Error('尚未运行 `cove setup`');
    return ctx.paths.configFile;
  });

  await check('保险箱', async () => {
    const secrets = await ctx.vault.list();
    return `${secrets.length} 个密钥`;
  });

  await check('本地 CA', async () => {
    const result = await inspectCa(ctx.paths, ctx.vault);
    if (!result.ok) throw new Error(result.reason ?? 'CA 不可用');
    return '可读';
  });

  for (const [label, image] of [
    ['broker 镜像', ctx.config.images.broker],
    ['sandbox 镜像', ctx.config.images.sandbox],
  ] as const) {
    await check(label, async () => {
      if (!(await ctx.docker.imageExists(image))) {
        throw new Error(`缺少 ${image}；运行 \`cove build\``);
      }
      return image;
    });
  }

  await check('残留会话', async () => {
    const sessions = await listSessions(ctx.paths);
    const active = sessions.filter((session) => session.state === 'running' || session.state === 'starting');
    if (active.length > 0) {
      warn(`发现 ${active.length} 个未清理会话；如已退出可运行 \`cove down --all\``);
    }
    return `${sessions.length} 条记录`;
  });

  out('');
  if (failures.length === 0) {
    ok('所有检查通过');
    return { ok: true, failures };
  }
  fail(`${failures.length} 项检查失败`);
  return { ok: false, failures };
}
