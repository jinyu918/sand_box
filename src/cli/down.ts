import { listSessions, loadSession, removeSessionConfig, updateSession } from '../session/store.js';
import { CoveError } from '../core/errors.js';
import type { CliContext } from './context.js';
import { out } from './prompt.js';

export async function downSession(ctx: CliContext, id: string): Promise<void> {
  const session = await loadSession(ctx.paths, id);
  await ctx.docker.stopAndRemove(session.container);
  await ctx.docker.stopAndRemove(session.broker);
  await ctx.docker.removeNetwork(session.network);
  await ctx.docker.removeVolume(session.homeVolume);
  await removeSessionConfig(ctx.paths, session.id);
  await updateSession(ctx.paths, session, { state: 'stopped' });
  out(`已停止会话 ${session.id}`);
}

export async function downAll(ctx: CliContext): Promise<void> {
  const sessions = await listSessions(ctx.paths);
  const active = sessions.filter(
    (session) => session.state === 'running' || session.state === 'starting' || session.state === 'failed',
  );
  if (active.length === 0) {
    out('没有需要清理的会话');
    return;
  }
  for (const session of active) {
    await downSession(ctx, session.id).catch((error) => {
      if (error instanceof CoveError) throw error;
      throw new CoveError('DOCKER_FAILED', `清理会话失败: ${session.id}`, {
        hint: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
