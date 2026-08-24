/**
 * Claude Code session state. The shared `graft/.cache/` pieces (the statusline's
 * `Stats` snapshot and the build lock) live in `../util/state.js` so the graph's
 * pre-query auto-refresh can take the same lock; they are re-exported here so
 * every existing import path keeps working.
 */
import { join } from 'node:path';
import { cacheDir, readJson, writeJsonAtomic } from '../util/state.js';

export {
  LOCK_STALE_MS,
  acquireLock,
  acquireLockIn,
  releaseLockIn,
  cacheDir,
  emptyStats,
  patchStats,
  readStats,
  releaseLock,
  resolveContextDir,
  writeJsonAtomic,
  writeStats,
} from '../util/state.js';
export type { Stats } from '../util/state.js';

export interface SessionState {
  lastQuery: string | null;
  perAgentQuery: Record<string, string>;
  graftReads: number; sourceReads: number;
  /** Cumulative tokens saved this session via `ask --source` retrieval (est.). */
  savedTokens: number;
  /** Pointers the prompt hook already injected this session (novelty gate:
   * a hit whose pointer was shown once is never re-injected). Optional so
   * session files written before this field still parse. */
  injectedPointers?: string[];
  /** Weak-match nudges spent this session, capped so the line stays signal.
   * Optional for the same backwards-compatibility reason as above. */
  nudges?: number;
  /** Set once this session has been rolled up into a `session_summary`
   * telemetry event, so a resumed or long-lived session is counted once.
   * A flag rather than deleting the file: the file still holds `lastQuery` and
   * `injectedPointers`, which a resumed session needs. */
  summarized?: boolean;
}

function emptySession(): SessionState {
  return { lastQuery: null, perAgentQuery: {}, graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [], nudges: 0 };
}

function sessionPath(d: string, id: string): string { return join(cacheDir(d), 'session', `${id}.json`); }

export function readSession(d: string, id: string): SessionState {
  return readJson<SessionState>(sessionPath(d, id)) ?? emptySession();
}
export function writeSession(d: string, id: string, s: SessionState): void {
  writeJsonAtomic(sessionPath(d, id), s);
}
