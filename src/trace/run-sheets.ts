/**
 * Run sheets (`~/.trail/runs/<run-id>.json`, design 2.4): what one finished
 * run did, as compile copies it. Written for every closed run with at least
 * one step call, checked or not, so "save this" can name a run that is no
 * longer the newest. `runs/index.json` lists them, newest last, so the
 * previous run of the same job is found by reading one sheet, never by
 * scanning the folder. Sheets are deleted 7 days after they were last
 * written.
 *
 * A sheet holds commands that ran (secret-checked at fold time), counts and
 * labels; never what the person typed. Re-exported from `runs.ts`, where the
 * design names these functions.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';
import type { RunSheet, RunState } from './types.js';
import type { CheckedVerdict } from './runs.js';

const RUN_ID = /^r-\d{4}-[0-9a-f]{4,8}$/;
const MAX_ROWS = 500;
const KEEP_MS = 7 * 24 * 3600 * 1000;

export interface RunIndexRow { id: string; session: string; repoKey: string; job: RunSheet['job']; checked: boolean; startedAt: string }
interface RunIndex { v: 1; rows: RunIndexRow[] }

function runsDir(env?: NodeJS.ProcessEnv): string {
  return trailPath(env, 'runs');
}

function indexPath(env?: NodeJS.ProcessEnv): string {
  return join(runsDir(env), 'index.json');
}

/** Throws on an id that isn't a run id: it comes from the agent's command line. */
export function runSheetPath(id: string, env?: NodeJS.ProcessEnv): string {
  if (!RUN_ID.test(String(id))) throw new Error(`trail: not a run id: ${String(id).slice(0, 40)}`);
  return join(runsDir(env), `${id}.json`);
}

function readIndex(env?: NodeJS.ProcessEnv): RunIndex {
  const raw = readJsonSafe<RunIndex>(indexPath(env));
  const rows = raw && Array.isArray(raw.rows) ? raw.rows.filter((r) => r && typeof r.id === 'string' && RUN_ID.test(r.id)) : [];
  return { v: 1, rows };
}

function writeIndex(index: RunIndex, env?: NodeJS.ProcessEnv): void {
  writePrivate(indexPath(env), JSON.stringify({ v: 1, rows: index.rows.slice(-MAX_ROWS) }));
}

/** Locked read-modify-write of the index; a timed-out lock leaves it as it was (the sheet is still on disk). */
function updateIndex(env: NodeJS.ProcessEnv | undefined, change: (rows: RunIndexRow[]) => RunIndexRow[]): void {
  withLock(indexPath(env), () => {
    const index = readIndex(env);
    writeIndex({ v: 1, rows: change(index.rows) }, env);
  });
}

/** Writes runs/<id>.json and its row in runs/index.json (locked). Sets run.sheet and run.checkIndex. */
export function writeRunSheet(run: RunState, v: CheckedVerdict, meta: { host: string; tier: RunSheet['tier']; sessionHash: string; helpers: string[] }, env?: NodeJS.ProcessEnv): RunSheet {
  const path = runSheetPath(run.id, env);
  const checked = v.checked && v.checkIndex !== null;
  const sheet: RunSheet = {
    v: 1,
    id: run.id,
    session: meta.sessionHash,
    repoKey: run.repoKey,
    ...(run.checkout ? { checkout: run.checkout } : {}),
    branch: run.branch,
    host: meta.host,
    tier: meta.tier,
    epoch: run.epoch,
    startedAt: run.startedAt,
    endedAt: run.lastAt,
    job: run.job,
    jobWords: [...run.jobWords],
    sharedWords: [...run.sharedWords],
    promptParams: { ...run.promptParams },
    // A call in another repo than the run's keeps no folder: compile refuses it as outside the repo.
    calls: run.calls.map((c) => (c.key === run.repoKey ? { ...c } : { ...c, cwd: null })),
    checkIndex: checked ? v.checkIndex : null,
    checked,
    end: v.end,
    counts: { commands: run.commands, failed: run.failedCount, toolCalls: run.toolCalls, edits: run.edits },
    helpers: [...meta.helpers],
    skillId: run.skillId ?? null,
    ...(run.carriedFrom ? { carriedFrom: run.carriedFrom } : {}),
  };
  writePrivate(path, JSON.stringify(sheet));
  const row: RunIndexRow = { id: run.id, session: meta.sessionHash, repoKey: run.repoKey, job: run.job, checked, startedAt: run.startedAt };
  updateIndex(env, (rows) => [...rows.filter((r) => r.id !== run.id), row]);
  run.sheet = checked ? 'checked' : 'draft';
  run.checkIndex = sheet.checkIndex;
  return sheet;
}

function validSheet(v: unknown, id: string): v is RunSheet {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const s = v as RunSheet;
  return s.v === 1 && s.id === id && typeof s.repoKey === 'string' && Array.isArray(s.calls) && typeof s.startedAt === 'string';
}

export function readRunSheet(id: string, env?: NodeJS.ProcessEnv): RunSheet | null {
  if (!RUN_ID.test(String(id))) return null;
  const v = readJsonSafe<unknown>(runSheetPath(id, env));
  return validSheet(v, id) ? v : null;
}

/** Deletes run sheets older than 7 days (mtime) and their index rows. */
export function pruneRunSheets(now: Date = new Date(), env?: NodeJS.ProcessEnv): number {
  let names: string[];
  try {
    names = readdirSync(runsDir(env));
  } catch {
    return 0;
  }
  let gone = 0;
  const cutoff = now.getTime() - KEEP_MS;
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (name === id || !RUN_ID.test(id)) continue;
    const path = join(runsDir(env), name);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      rmSync(path, { force: true });
      gone++;
    } catch { /* gone already */ }
  }
  updateIndex(env, (rows) => rows.filter((r) => {
    try {
      return statSync(runSheetPath(r.id, env)).isFile();
    } catch {
      return false;
    }
  }));
  return gone;
}

/** The newest other checked sheet with the same repoKey and job, started before this one, found through
 *  runs/index.json (one sheet read, never a folder scan). The Stop offer, the gate and the CLI all call it. */
export function findPriorSheet(sheet: RunSheet, env?: NodeJS.ProcessEnv): RunSheet | null {
  if (sheet.job === null) return null;
  const rows = readIndex(env).rows;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.id === sheet.id || !r.checked || r.repoKey !== sheet.repoKey || r.job !== sheet.job || !(Date.parse(r.startedAt) < Date.parse(sheet.startedAt))) continue;
    const prior = readRunSheet(r.id, env);
    return prior && prior.checked ? prior : null;
  }
  return null;
}
