/**
 * Housekeeping for the skills files under `~/.trail` (design 1.3, 2): at most
 * once an hour per machine, old run sheets (7 days), session files (30 days),
 * receipts (1 day), held items shown more than 24 hours ago, and probe
 * results older than 10 minutes. Re-exported from `skill-session.ts`.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { pruneRunSheets } from './run-sheets.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Files in `dir` (not folders) whose mtime is older than `ms`, removed. */
function dropOld(dir: string, ms: number, now: Date, keep: (name: string) => boolean = () => false): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (keep(name)) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && now.getTime() - st.mtimeMs > ms) rmSync(p, { force: true });
    } catch { /* gone already */ }
  }
}

/** Held items shown more than 24 h ago (held/<name>/held.json `shownAt`). */
function dropShownHeld(dir: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const held = readJsonSafe<{ shownAt?: unknown }>(join(dir, name, 'held.json'));
    const shown = typeof held?.shownAt === 'string' ? Date.parse(held.shownAt) : NaN;
    if (!Number.isNaN(shown) && now.getTime() - shown > DAY) {
      try { rmSync(join(dir, name), { recursive: true, force: true }); } catch { /* next time */ }
    }
  }
}

/** state/probes.json entries `{ at }` older than 10 minutes, under `entries` or at the top level. */
function dropOldProbes(path: string, now: Date): void {
  const raw = readJsonSafe<Record<string, unknown>>(path);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const box = raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries) ? (raw.entries as Record<string, unknown>) : raw;
  let changed = false;
  for (const [k, v] of Object.entries(box)) {
    const at = v && typeof v === 'object' ? Date.parse(String((v as { at?: unknown }).at)) : NaN;
    if (!Number.isNaN(at) && now.getTime() - at > 10 * 60_000) {
      delete box[k];
      changed = true;
    }
  }
  if (changed) writePrivate(path, JSON.stringify(raw));
}

/** At most once an hour (state/housekeeping.json): pruneRunSheets; sessions/*.json and their .gate.json and
 *  .post.jsonl (and crash leftovers beside them) older than 30 days; receipts older than 1 day; held items shown more than 24 h ago;
 *  expired state/probes.json entries. */
export function housekeeping(now: Date = new Date(), env?: NodeJS.ProcessEnv): void {
  const mark = trailPath(env, 'state', 'housekeeping.json');
  const last = readJsonSafe<{ at?: unknown }>(mark);
  const lastAt = typeof last?.at === 'string' ? Date.parse(last.at) : NaN;
  if (!Number.isNaN(lastAt) && now.getTime() - lastAt < HOUR && now.getTime() >= lastAt) return;
  // One process does it; another one meanwhile skips it.
  withLock(mark, () => {
    writePrivate(mark, JSON.stringify({ at: now.toISOString() }));
    pruneRunSheets(now, env);
    // Every file: a session's state, gate and marks, and what a crash left beside them (.lock, .steal, .stale, .tmp).
    dropOld(trailPath(env, 'sessions'), 30 * DAY, now);
    dropOld(trailPath(env, 'receipts'), DAY, now, (n) => !n.endsWith('.json'));
    dropShownHeld(trailPath(env, 'held'), now);
    dropOldProbes(trailPath(env, 'state', 'probes.json'), now);
  }, 0);
}
