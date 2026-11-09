/**
 * The facts of a Codex rollout file itself (design 4.15, 4.16): where Codex keeps its home, the rollout's first
 * line (`session_meta`), whether it is an import (P39) or a fork (D133), and whether a receipt names this session's
 * own rollout (HC6). Split from codex.ts, which reads the lines. Never throws; never waits on a FIFO.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { CodexMeta } from './types.js';

const META_BYTES = 64 * 1024;
/** CODEX_HOME, else $HOME/.codex. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(env.HOME || homedir(), '.codex');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The rollout's first line's session_meta payload, read with one positioned read of at most 64 KB; null otherwise. */
function metaPayload(rolloutPath: string): Record<string, unknown> | null {
  let fd: number;
  try {
    // Never waits on a FIFO or a device planted where the rollout should be (review): O_NONBLOCK, then a plain file.
    fd = openSync(rolloutPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(META_BYTES);
    const n = readSync(fd, buf, 0, META_BYTES, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl < 0) return null;
    const e = JSON.parse(buf.subarray(0, nl).toString('utf8')) as { type?: unknown; payload?: Record<string, unknown> };
    const p = e?.payload;
    return e?.type === 'session_meta' && p && typeof p === 'object' && !Array.isArray(p) && str(p.id) ? p : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The rollout's first line, read with one positioned read of at most 64 KB; null when it isn't a session_meta line. */
export function codexMeta(rolloutPath: string): CodexMeta | null {
  const p = metaPayload(rolloutPath);
  if (!p) return null;
  try {
    const src = p.source;
    const source = str(src) ?? (src && typeof src === 'object' && !Array.isArray(src) ? Object.keys(src)[0] ?? null : null);
    const hm = p.history_mode;
    return {
      id: p.id as string, originator: str(p.originator), source, cliVersion: str(p.cli_version), cwd: str(p.cwd),
      historyMode: hm === 'legacy' || hm === 'paginated' ? hm : null,
    };
  } catch {
    return null;
  }
}

/**
 * D133, fail closed: a rollout whose session_meta names `forked_from_id` starts with a copy of another session's
 * lines, and Codex lines carry no id that tells the copy from this session's own. A copied typed line whose words the
 * person types again would count, and the copied calls with it (review). So a fork is read as nothing, like an import.
 */
export function isForkedRollout(rolloutPath: string): boolean {
  const f = metaPayload(rolloutPath)?.forked_from_id;
  return f !== undefined && f !== null && f !== '';
}

/** The session id a rollout's file name ends with, or null. */
const nameSession = (path: string) => /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(basename(path))?.[1] ?? null;

/** P39: the rollout is one `external_agent_session_imports.json` lists (by its session id): another host's session. */
export function isImportedRollout(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const id = codexMeta(path)?.id ?? nameSession(path);
    if (!id) return false;
    const file = join(codexHome(env), 'external_agent_session_imports.json');
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 16 * 1024 * 1024) return false;
    const v = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown };
    return Array.isArray(v?.records) && v.records.some((r) => r && typeof r === 'object' && (r as { imported_thread_id?: unknown }).imported_thread_id === id);
  } catch {
    return false;
  }
}

/**
 * 4.16, D82's first half for Codex: the receipt names this session's own rollout where Codex keeps it: a regular
 * file (not a link), under `codexHome(env)/sessions/` through realpath, named `rollout-*-<session>.jsonl`, whose
 * `session_meta.id` is the session (HC6).
 */
export function codexTranscriptOk(r: { transcriptPath: string; session: string }, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const p = r.transcriptPath;
    if (!p || !isAbsolute(p) || !r.session || !lstatSync(p).isFile()) return false;
    if (nameSession(p) !== r.session) return false;
    const root = realpathSync(join(codexHome(env), 'sessions'));
    const file = realpathSync(p);
    if (!file.startsWith(root + sep)) return false;
    return codexMeta(file)?.id === r.session;
  } catch {
    return false;
  }
}
