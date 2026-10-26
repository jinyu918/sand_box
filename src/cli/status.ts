import { listSessions } from '../session/store.js';
import type { CliContext } from './context.js';
import { out } from './prompt.js';

export async function showStatus(ctx: CliContext): Promise<void> {
  const sessions = await listSessions(ctx.paths);
  if (sessions.length === 0) {
    out('还没有 Cove 会话。运行 `cove run claude` 开始。');
    return;
  }
  const header = ['ID', '状态', 'Agent', '项目', '创建时间'];
  const rows = sessions.map((session) => [
    session.id.slice(0, 8),
    session.state,
    session.agent,
    session.project.length > 46 ? `…${session.project.slice(-45)}` : session.project,
    session.createdAt,
  ]);
  printTable(header, rows);
}

export function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((cell, index) =>
    Math.min(60, Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0))),
  );
  const render = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ');
  out(render(header));
  out(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of rows) out(render(row));
}
