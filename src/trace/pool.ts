/**
 * The pool (design 2.3): for one repo, the days each job came back, kept in
 * `~/.trail/repos/<key>/pool.json` beside phase 0's repo folder. A day is a
 * session-day: the local date a run started on and the session's hash, with
 * whether that run cost much (5+ tool calls or a failure). Job words from a
 * fixed vocabulary and days only: no prompt text, no commands.
 *
 * Only jobs that can reach moment 2 are counted (release, ship, tests,
 * report). A job is due an offer on its 3rd session-day in the last 45 days
 * counting today (the 4th under the governor), at least 2 of them costly.
 * Days older than that are dropped on every write.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { localDate, readSettings } from '../skills/settings.js';
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { OFFER_FAMILIES } from './jobs.js';
import type { JobClass, JobMatch } from './types.js';

export interface PoolDay { d: string; s: string; costly: boolean }            // local date, session hash
export interface PoolEntry { words: string[]; days: PoolDay[]; lastGoodRun: string | null; lastSeen: string; shownAtInit: boolean }
export interface PoolFile { v: 1; jobs: Partial<Record<JobClass, PoolEntry>> }
export interface RepeatVerdict { ok: boolean; sessionDays: number; dates: number; costlyDays: number; need: number }

/** The window: today and the 44 days before it. */
const WINDOW_DAYS = 45;
const MAX_WORDS = 12;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The first local date inside the 45-day window that ends today. */
function windowStart(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (WINDOW_DAYS - 1), 12);
  return localDate(d);
}

const offerJob = (job: string): job is JobClass => Object.prototype.hasOwnProperty.call(OFFER_FAMILIES, job);

/** join(trailHome, 'repos', ...repoKey.split('/'), 'pool.json'): the same folder as repoPlace(..).dir. */
export function poolPath(repoKey: string, env?: NodeJS.ProcessEnv): string {
  const parts = String(repoKey).split('/').filter((p) => p && p !== '.' && p !== '..');
  return trailPath(env, 'repos', ...parts, 'pool.json');
}

function cleanEntry(v: unknown): PoolEntry | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const e = v as Partial<PoolEntry>;
  const days = Array.isArray(e.days)
    ? e.days.filter((d): d is PoolDay => !!d && typeof d.d === 'string' && DATE.test(d.d) && typeof d.s === 'string').map((d) => ({ d: d.d, s: d.s, costly: d.costly === true }))
    : [];
  return {
    words: Array.isArray(e.words) ? e.words.filter((w): w is string => typeof w === 'string').slice(0, MAX_WORDS) : [],
    days,
    lastGoodRun: typeof e.lastGoodRun === 'string' ? e.lastGoodRun : null,
    lastSeen: typeof e.lastSeen === 'string' ? e.lastSeen : days.map((d) => d.d).sort().at(-1) ?? '',
    shownAtInit: e.shownAtInit === true,
  };
}

function parsePool(raw: unknown): PoolFile {
  const jobs: PoolFile['jobs'] = {};
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { jobs?: unknown }) : {};
  if (r.jobs && typeof r.jobs === 'object' && !Array.isArray(r.jobs)) {
    for (const [job, v] of Object.entries(r.jobs as Record<string, unknown>)) {
      const e = cleanEntry(v);
      if (e && offerJob(job)) jobs[job] = e;
    }
  }
  return { v: 1, jobs };
}

export function readPool(repoKey: string, env?: NodeJS.ProcessEnv): PoolFile {
  return parsePool(readJsonSafe<unknown>(poolPath(repoKey, env)));
}

/** Adds or updates the (d, s) day for a job (costly OR-ed), prunes days older than 45 and entries unseen for 45 days. Locked; null when the lock timed out. */
export function notePoolDay(repoKey: string, m: JobMatch, day: PoolDay, goodRun: string | null, env?: NodeJS.ProcessEnv, now: Date = new Date()): PoolEntry | null {
  if (!offerJob(m.job) || !DATE.test(day.d)) return null;
  const path = poolPath(repoKey, env);
  const from = windowStart(now);
  const done = withLock(path, () => {
    const raw = readJsonSafe<unknown>(path);
    const keep = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const pool = parsePool(raw);
    const e: PoolEntry = pool.jobs[m.job] ?? { words: [], days: [], lastGoodRun: null, lastSeen: day.d, shownAtInit: false };
    for (const w of m.words) if (e.words.length < MAX_WORDS && !e.words.includes(w)) e.words.push(w);
    const same = e.days.find((x) => x.d === day.d && x.s === day.s);
    if (same) same.costly = same.costly || day.costly;
    else e.days.push({ d: day.d, s: day.s, costly: day.costly });
    e.days.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    if (goodRun) e.lastGoodRun = goodRun;
    if (day.d > e.lastSeen) e.lastSeen = day.d;
    pool.jobs[m.job] = e;
    for (const [job, entry] of Object.entries(pool.jobs) as Array<[JobClass, PoolEntry]>) {
      entry.days = entry.days.filter((x) => x.d >= from);
      if (!entry.days.length || entry.lastSeen < from) delete pool.jobs[job];
    }
    writePrivate(path, JSON.stringify({ ...keep, v: 1, jobs: pool.jobs }));
    return pool.jobs[m.job] ?? null;
  });
  return done.ok ? done.value : null;
}

/** 3rd session-day in 45 days (4th when extraDay), at least 2 of them costly. */
export function repeatedEnough(e: PoolEntry, extraDay: boolean, now: Date = new Date()): RepeatVerdict {
  const from = windowStart(now);
  const today = localDate(now);
  const days = e.days.filter((x) => x.d >= from && x.d <= today);
  const sessionDays = new Set(days.map((x) => `${x.d}|${x.s}`)).size;
  const costlyDays = new Set(days.filter((x) => x.costly).map((x) => `${x.d}|${x.s}`)).size;
  const dates = new Set(days.map((x) => x.d)).size;
  const need = extraDay ? 4 : 3;
  return { ok: sessionDays >= need && costlyDays >= 2, sessionDays, dates, costlyDays, need };
}

/** The governor from the settings cache (4.13 step 7): 3 or more answers lately, fewer than 1 in 3 a yes. */
function governorOn(env?: NodeJS.ProcessEnv): boolean {
  const nine = readSettings(env).lastNine;
  return nine.length >= 3 && nine.filter((a) => a === 'yes').length * 3 < nine.length;
}

/** Every pool.json under `dir`, as repo keys (the folders between `repos/` and the file). */
function poolKeys(root: string, dir: string, depth: number, out: string[]): void {
  if (depth > 6) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (name === 'pool.json') out.push(relative(root, dir).split(sep).join('/'));
    else if (!name.startsWith('.')) {
      try {
        if (statSync(p).isDirectory()) poolKeys(root, p, depth + 1, out);
      } catch { /* gone */ }
    }
  }
}

/** Every job counted in the last 45 days, every repo, for `trail skills` (2.10). */
export function watching(env?: NodeJS.ProcessEnv, now: Date = new Date()): Array<{ repoKey: string; job: JobClass; sessionDays: number; costlyDays: number; need: number }> {
  const root = trailPath(env, 'repos');
  const keys: string[] = [];
  poolKeys(root, root, 0, keys);
  const extra = keys.length ? governorOn(env) : false;
  const out: Array<{ repoKey: string; job: JobClass; sessionDays: number; costlyDays: number; need: number }> = [];
  for (const repoKey of keys.filter(Boolean)) {
    for (const [job, e] of Object.entries(readPool(repoKey, env).jobs) as Array<[JobClass, PoolEntry]>) {
      const v = repeatedEnough(e, extra, now);
      if (v.sessionDays > 0) out.push({ repoKey, job, sessionDays: v.sessionDays, costlyDays: v.costlyDays, need: v.need });
    }
  }
  return out;
}
