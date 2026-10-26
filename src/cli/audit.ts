import { readFile } from 'node:fs/promises';
import { sessionPaths } from '../core/paths.js';
import { listSessions } from '../session/store.js';
import type { CovePaths } from '../core/paths.js';
import type { AuditEvent } from '../broker/types.js';

export async function readAudit(paths: CovePaths, id?: string, limit = 50): Promise<AuditEvent[]> {
  const sessions = await listSessions(paths);
  const session = id === undefined ? sessions[0] : sessions.find((item) => item.id === id);
  if (session === undefined) return [];
  const file = sessionPaths(paths, session.id).auditFile;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // Ignore a partially-written final line.
    }
  }
  return events.slice(-limit);
}
