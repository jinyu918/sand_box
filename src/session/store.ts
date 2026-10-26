import { readdir, rm } from 'node:fs/promises';
import { CoveError } from '../core/errors.js';
import { ensureDir, readJsonFile, writeJsonAtomic } from '../core/fs.js';
import type { CovePaths } from '../core/paths.js';
import { sessionPaths } from '../core/paths.js';
import type { AgentId } from '../agents/profiles.js';

export type SessionState = 'starting' | 'running' | 'stopped' | 'failed';

export interface SessionRecord {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  state: SessionState;
  project: string;
  agent: AgentId;
  container: string;
  broker: string;
  network: string;
  homeVolume: string;
  webPort: number | null;
  secretIds: string[];
  mcp: string[];
}

export async function createSessionRecord(
  paths: CovePaths,
  input: {
    id: string;
    project: string;
    agent: AgentId;
    secretIds: string[];
    mcp: string[];
  },
): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const record: SessionRecord = {
    version: 1,
    id: input.id,
    createdAt: now,
    updatedAt: now,
    state: 'starting',
    project: input.project,
    agent: input.agent,
    container: `cove-sb-${input.id}`,
    broker: `cove-br-${input.id}`,
    network: `cove-net-${input.id}`,
    homeVolume: `cove-home-${input.id}`,
    webPort: null,
    secretIds: input.secretIds,
    mcp: input.mcp,
  };
  const session = sessionPaths(paths, input.id);
  await ensureDir(session.dir, 0o700);
  await ensureDir(session.configDir, 0o700);
  await ensureDir(session.auditDir, 0o700);
  await writeJsonAtomic(session.sessionFile, record);
  return record;
}

export async function updateSession(
  paths: CovePaths,
  record: SessionRecord,
  patch: Partial<Pick<SessionRecord, 'state' | 'webPort'>>,
): Promise<SessionRecord> {
  const updated: SessionRecord = {
    ...record,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(sessionPaths(paths, record.id).sessionFile, updated);
  return updated;
}

export async function resolveSessionId(paths: CovePaths, idOrPrefix: string): Promise<string> {
  const trimmed = idOrPrefix.trim();
  if (!/^[a-f0-9-]{4,64}$/u.test(trimmed)) {
    throw new CoveError('SESSION_NOT_FOUND', `会话 ID 无效: ${idOrPrefix}`);
  }
  const sessions = await listSessions(paths);
  const exact = sessions.find((session) => session.id === trimmed);
  if (exact !== undefined) return exact.id;
  const matches = sessions.filter((session) => session.id.startsWith(trimmed));
  if (matches.length === 1) return matches[0]?.id ?? trimmed;
  if (matches.length > 1) {
    throw new CoveError('SESSION_NOT_FOUND', `会话前缀不唯一: ${idOrPrefix}`, {
      hint: '输入更长的会话 ID 前缀',
    });
  }
  return trimmed;
}

export async function loadSession(paths: CovePaths, id: string): Promise<SessionRecord> {
  if (!/^[a-f0-9-]{8,64}$/u.test(id)) {
    throw new CoveError('SESSION_NOT_FOUND', '会话 ID 无效');
  }
  const session = sessionPaths(paths, id);
  const raw = await readJsonFile<unknown>(session.sessionFile, null);
  if (raw === null || typeof raw !== 'object') {
    throw new CoveError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
  }
  return raw as SessionRecord;
}

export async function listSessions(paths: CovePaths): Promise<SessionRecord[]> {
  const entries = await readdir(paths.sessionsDir, { withFileTypes: true }).catch(() => []);
  const sessions: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      sessions.push(await loadSession(paths, entry.name));
    } catch {
      // Ignore malformed or partially-created session directories.
    }
  }
  return sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function removeSessionConfig(paths: CovePaths, id: string): Promise<void> {
  await rm(sessionPaths(paths, id).configDir, { recursive: true, force: true });
}
