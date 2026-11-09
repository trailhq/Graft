/**
 * `~/.trail/init/<repo-key>.json` v2 (design 2.6): what `trail init` decided
 * in this repo, and the list a relay left waiting.
 *
 * - `runs`: the last 10 inits here, counts and session hashes only.
 * - `pending`: only after a relay (no TTY). Pointers and hashes, never a
 *   command, a SKILL.md, typed words or model text (P4, R24): a skill is its
 *   run's byte range and `skillSha`, a preference its line pointers, and a
 *   preference's name words are written as `[]` (they are the person's
 *   words, rebuilt from the pointer when needed).
 * - `closed` / `deferred`: item ids. `closedV1`: a phase 0 file's quote
 *   hashes, so what was said no to then stays closed (R33).
 * - `handover`: the session that got the list at its start, and its
 *   transcript's size then (3.1 step 10, R22).
 * - `notice`: what the TTY screen kept, for the next SessionStart notice
 *   to name once with its undo (D87, b7 shows it).
 *
 * The file is agent-editable, so it is read strictly: a field of the wrong
 * shape is dropped, unknown fields never come back, and a link or a FIFO at
 * the path reads as no record (plain-file.ts).
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { WALLS } from '../trace/walls.js';
import type { JobClass, WallClass } from '../trace/types.js';
import { trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { readPlain } from './plain-file.js';
import type { InitKind, SkillSource, TypedRef } from './types.js';

export const MAX_RUNS = 10;
const MAX_FILE = 1024 * 1024;
const MAX_PENDING = 20;

export interface InitRun {
  id: string;
  at: string;
  /** Who ran it: the person at a terminal, an agent, or the person's own script (no TTY, not an agent). */
  by: 'person' | 'agent' | 'script';
  /** What it showed: the TTY screen, the relay (agent), or the plain list (script). */
  screen: 'tty' | 'relay' | 'list';
  reads: { sessions: number; days: number; from: string | null; to: string | null; parent: number; read: string[];
    skipped: Array<{ sh: string; why: string }>;
    /** D135 (3): jobs that met moment 2's bar but didn't compile: the job, its session-days, each run's refusal code
     *  (newest first). Codes only, no text. Left out when there are none. */
    uncompiled?: Uncompiled[] };
  /** The model the naming call used, or 'none'. */
  model: string;
  /** Why no model: 'agent', 'plain', 'no-tty', 'off', 'no-skills', or a ClaudeFailure. */
  modelWhy: string | null;
  calls: number;
  tokens: number;
  ms: number;
  shown: string[];
  kept: string[];
  closed: string[];
  deferred: string[];
}

export interface Uncompiled { job: JobClass; days: number; why: string[] }

/** One relayed item, as written: no title, no description, no compiled skill (2.6). */
export interface PendingItem {
  n: number;
  id: string;
  kind: InitKind;
  /** The candidate's key (no typed words: a repo key and job, a wall class, a cluster sha): what a closed skill is said no to by. */
  key: string;
  plainName: string;
  nameWords: string[];
  count: { days: number; from: string; to: string; costly?: number; repos?: number };
  applies: string;
  scope: 'personal' | 'repo';
  typed: boolean;
  ticked: boolean;
  /** `branches`: a ship skill's branch names from its check, for its job phrase when the list is handed over (D112). */
  skill?: { src: SkillSource; branches?: string[] };
  guardrail?: { cls: WallClass; check?: 'no-timeout' };
  pref?: { refs: TypedRef[] };
}

/** D87: one item the TTY screen kept, as the next SessionStart notice names it. No typed words: a preference is its learning id. */
export interface KeptName {
  kind: InitKind;
  /** The skill's or guardrail's name; '' for a preference (the notice reads its words from the learning). */
  name: string;
  /** The skill id or the learning id. */
  id: string;
  /** What `trail forget` takes to undo it. */
  forget: string;
}

export interface InitRecord {
  v: 2;
  repo: string;
  runs: InitRun[];
  pending: PendingItem[];
  pendingFrom: string | null;
  shownAt: string | null;
  handedAt: string | null;
  handover: { session: string; offset: number } | null;
  closed: string[];
  closedV1: string[];
  deferred: string[];
  /** D87: what the last TTY screen kept, until the next SessionStart has named it (b7 sets `shownAt`). */
  notice: { run: string; at: string; items: KeptName[]; shownAt: string | null } | null;
}

export function emptyRecord(repoKey: string): InitRecord {
  return { v: 2, repo: repoKey, runs: [], pending: [], pendingFrom: null, shownAt: null, handedAt: null, handover: null, closed: [], closedV1: [], deferred: [], notice: null };
}

/** `<trail home>/init/<repo key>.json`, one folder per key part (phase 0's place). */
export function initRecordPath(repoKey: string, env?: NodeJS.ProcessEnv): string {
  const parts = repoKey.split('/').filter((p) => p && p !== '.' && p !== '..');
  const last = parts.pop() ?? 'repo';
  return trailPath(env, 'init', ...parts, `${last}.json`);
}

/** 'ir-' + 4 hex. */
export function newRunId(): string {
  return `ir-${randomBytes(2).toString('hex')}`;
}

const ID = /^i-[0-9a-f]{10}$/;
const V1 = /^[0-9a-f]{16}$/;
const SHA = /^[0-9a-f]{64}$/;
const SKILL_SHA = /^[0-9a-f]{64}$/;
const SH = /^[0-9a-f]{12}$/;
const RUN_ID = /^ir-[0-9a-f]{4,16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^(?:[\w.@:/~-]{1,300}\|job:[a-z-]{1,20}|wall:[a-z-]{1,40}|pref:[0-9a-f]{16})$/;
/** review-screen's BRANCH_NAME (kept here so the hook's import closure stays small). */
const BRANCH = /^[\w][\w./-]{0,59}$/;
const KINDS = new Set<InitKind>(['skill', 'guardrail', 'preference', 'review']);
const JOBS: ReadonlySet<string> = new Set<JobClass>(['release', 'ship', 'pr-green', 'sweep', 'run-local', 'report', 'tests']);
/** A refusal code: a word or two joined by hyphens, never text. */
const CODE = /^[a-z]+(?:-[a-z]+){0,3}$/;

/** D135 (3): the uncompiled jobs an edited record may hold, kept only when each is a known job, a count and codes. */
export function uncompiledOf(v: unknown): Uncompiled[] {
  if (!Array.isArray(v)) return [];
  const out: Uncompiled[] = [];
  for (const x of v.slice(0, 20)) {
    const u = obj(x);
    if (!u || typeof u.job !== 'string' || !JOBS.has(u.job) || !int(u.days, 1) || !Array.isArray(u.why)) continue;
    const why = [...new Set(u.why.filter((w): w is string => typeof w === 'string' && w.length <= 40 && CODE.test(w)))].slice(0, 8);
    if (why.length) out.push({ job: u.job as JobClass, days: u.days as number, why });
  }
  return out;
}
const GUARDED = new Map(WALLS.filter((w) => w.guardrail).map((w) => [w.cls, w.guardrail!]));

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 400): v is string => typeof v === 'string' && v.length <= max;
const int = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const strOrNull = (v: unknown): string | null => (str(v) ? v : null);
const ids = (v: unknown, re: RegExp, max = 500): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && re.test(x)))].slice(-max) : []);
const words = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => str(x, 80)).slice(0, 6) : []);

function asRange(v: unknown): { from: number; to: number } | null {
  const r = obj(v);
  return r && int(r.from) && int(r.to) && r.from < r.to ? { from: r.from, to: r.to } : null;
}

function asSource(v: unknown): SkillSource | null {
  const s = obj(v);
  if (!s || !str(s.t, 4096) || !int(s.size) || typeof s.mtimeMs !== 'number' || !Number.isFinite(s.mtimeMs) || !str(s.skillSha) || !SKILL_SHA.test(s.skillSha)) return null;
  const run = asRange(s.run);
  if (!run) return null;
  let prior: SkillSource['prior'] = null;
  if (s.prior !== null && s.prior !== undefined) {
    const p = obj(s.prior);
    const range = asRange(p);
    if (!p || !str(p.t, 4096) || !range) return null;
    prior = { t: p.t, ...range };
  }
  return { t: s.t, size: s.size, mtimeMs: s.mtimeMs, run, prior, skillSha: s.skillSha };
}

function asRef(v: unknown): TypedRef | null {
  const r = obj(v);
  return r && str(r.t, 4096) && int(r.o) && str(r.s) && SHA.test(r.s) ? { t: r.t, o: r.o, s: r.s } : null;
}

function asPending(v: unknown): PendingItem | null {
  const p = obj(v);
  if (!p || !int(p.n, 1) || p.n > 99 || !str(p.id) || !ID.test(p.id) || !KINDS.has(p.kind as InitKind) || !str(p.plainName, 80) || !str(p.applies)) return null;
  if (!str(p.key) || !KEY.test(p.key)) return null;
  const c = obj(p.count);
  if (!c || !int(c.days) || !str(c.from) || !str(c.to) || !DAY.test(c.from) || !DAY.test(c.to)) return null;
  const kind = p.kind as InitKind;
  const out: PendingItem = {
    n: p.n, id: p.id, kind, key: p.key, plainName: p.plainName, nameWords: kind === 'preference' ? [] : words(p.nameWords),
    count: { days: c.days, from: c.from, to: c.to, ...(int(c.costly) ? { costly: c.costly } : {}), ...(int(c.repos) ? { repos: c.repos } : {}) },
    applies: p.applies, scope: p.scope === 'repo' ? 'repo' : 'personal', typed: p.typed === true, ticked: p.ticked === true,
  };
  if (kind === 'skill') {
    const src = asSource(obj(p.skill)?.src);
    if (!src) return null;
    const branches = Array.isArray(obj(p.skill)?.branches) ? (obj(p.skill)!.branches as unknown[]).filter((b): b is string => str(b, 60) && BRANCH.test(b)).slice(0, 3) : [];
    out.skill = { src, ...(branches.length && p.key.endsWith('|job:ship') ? { branches } : {}) };
  } else if (kind === 'guardrail') {
    const g = obj(p.guardrail);
    const cls = g?.cls as WallClass;
    const t = GUARDED.get(cls);
    if (!t) return null;
    out.guardrail = { cls, ...(t.check ? { check: t.check } : {}) };
  } else if (kind === 'preference') {
    const refs = Array.isArray(obj(p.pref)?.refs) ? (obj(p.pref)!.refs as unknown[]).map(asRef) : [];
    if (!refs.length || refs.some((r) => r === null)) return null;
    out.pref = { refs: (refs as TypedRef[]).slice(0, 3) };
  } else {
    // A review finding's words are model text: it is never relayed, so never pending (2.6).
    return null;
  }
  return out;
}

function asRun(v: unknown): InitRun | null {
  const r = obj(v);
  if (!r || !str(r.id) || !RUN_ID.test(r.id) || !str(r.at)) return null;
  if (r.by !== 'person' && r.by !== 'agent' && r.by !== 'script') return null;
  if (r.screen !== 'tty' && r.screen !== 'relay' && r.screen !== 'list') return null;
  const reads = obj(r.reads) ?? {};
  const skipped = Array.isArray(reads.skipped)
    ? reads.skipped.map(obj).filter((s): s is Record<string, unknown> => !!s && str(s.sh) && SH.test(s.sh) && str(s.why, 40)).map((s) => ({ sh: s.sh as string, why: s.why as string })).slice(0, 2000)
    : [];
  return {
    id: r.id, at: r.at, by: r.by, screen: r.screen,
    reads: {
      sessions: int(reads.sessions) ? reads.sessions : 0, days: int(reads.days) ? reads.days : 0,
      from: str(reads.from) && DAY.test(reads.from) ? reads.from : null, to: str(reads.to) && DAY.test(reads.to) ? reads.to : null,
      parent: int(reads.parent) ? reads.parent : 0, read: ids(reads.read, SH, 2000), skipped,
      ...(uncompiledOf(reads.uncompiled).length ? { uncompiled: uncompiledOf(reads.uncompiled) } : {}),
    },
    model: str(r.model, 80) ? r.model : 'none', modelWhy: str(r.modelWhy, 40) ? r.modelWhy : null,
    calls: int(r.calls) ? r.calls : 0, tokens: int(r.tokens) ? r.tokens : 0, ms: int(r.ms) ? r.ms : 0,
    shown: ids(r.shown, ID), kept: ids(r.kept, ID), closed: ids(r.closed, ID), deferred: ids(r.deferred, ID),
  };
}

function asNotice(v: unknown): InitRecord['notice'] {
  const n = obj(v);
  if (!n || !str(n.run) || !RUN_ID.test(n.run) || !str(n.at) || !Array.isArray(n.items)) return null;
  const items: KeptName[] = [];
  for (const x of n.items.slice(0, 20)) {
    const k = obj(x);
    if (!k || !KINDS.has(k.kind as InitKind) || !str(k.name, 80) || !str(k.id, 80) || !str(k.forget, 120)) continue;
    items.push({ kind: k.kind as InitKind, name: k.name, id: k.id, forget: k.forget });
  }
  return { run: n.run, at: n.at, items, shownAt: strOrNull(n.shownAt) };
}

/** A parsed file as a v2 record; a phase 0 (v1) file upgraded (R33). */
export function recordFrom(raw: unknown, repoKey: string): InitRecord {
  const r = obj(raw);
  const out = emptyRecord(repoKey);
  if (!r) return out;
  if (r.v !== 2) {
    // Phase 0: pending items and closed titles can be the person's words, and can't map to v2 ids. Only the closed
    // quote hashes stay, so a preference said no to then stays closed.
    if (Array.isArray(r.closed)) out.closedV1 = [...new Set(r.closed.flatMap((c) => ids(obj(c)?.quotes, V1)))].slice(-500);
    return out;
  }
  out.runs = (Array.isArray(r.runs) ? r.runs.map(asRun).filter((x): x is InitRun => x !== null) : []).slice(-MAX_RUNS);
  const pending = Array.isArray(r.pending) ? r.pending.slice(0, MAX_PENDING).map(asPending).filter((x): x is PendingItem => x !== null) : [];
  // One item per number and per id: a doubled number could point the person's "1" at two things.
  const seenN = new Set<number>();
  const seenId = new Set<string>();
  out.pending = pending.filter((p) => !seenN.has(p.n) && !seenId.has(p.id) && (seenN.add(p.n), seenId.add(p.id), true));
  out.pendingFrom = str(r.pendingFrom) && RUN_ID.test(r.pendingFrom) ? r.pendingFrom : null;
  out.shownAt = strOrNull(r.shownAt);
  out.handedAt = strOrNull(r.handedAt);
  const h = obj(r.handover);
  out.handover = h && str(h.session, 200) && h.session && int(h.offset) ? { session: h.session, offset: h.offset } : null;
  out.closed = ids(r.closed, ID, 2000);
  out.closedV1 = ids(r.closedV1, V1, 2000);
  out.deferred = ids(r.deferred, ID);
  out.notice = asNotice(r.notice);
  return out;
}

/**
 * No link on the way from `init/` to the record's folder (b6 review): a folder link planted there (to a checkout's
 * `.trail/learnings`, say) would carry the record, its lock and its transcript paths into a repo. Missing folders are
 * fine (they are made as plain ones).
 */
function noLinkTo(path: string, env?: NodeJS.ProcessEnv): boolean {
  const root = trailPath(env, 'init');
  const rel = relative(root, dirname(path));
  if (rel.startsWith('..')) return false;
  let at = root;
  for (const part of ['', ...(rel ? rel.split(sep) : [])]) {
    at = part ? join(at, part) : at;
    try {
      const st = lstatSync(at);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

/** The record for `repoKey`, v1 files upgraded; an empty one when there is none, or it can't be read as a plain file. */
export function readInitRecord(repoKey: string, env?: NodeJS.ProcessEnv): InitRecord {
  let raw: unknown = null;
  try {
    if (!noLinkTo(initRecordPath(repoKey, env), env)) return recordFrom(null, repoKey);
    const text = readPlain(initRecordPath(repoKey, env), MAX_FILE);
    raw = text === null ? null : JSON.parse(text);
  } catch {
    raw = null;
  }
  return recordFrom(raw, repoKey);
}

/**
 * A ship skill's branch names for its job phrase when the list is handed over (D112): the ones read back, or those its
 * compiled check names (`refs/heads/<b>`, review-screen's `shipBranchesOf`). Names only, never the check.
 */
function branchesOf(p: PendingItem): { branches?: string[] } {
  if (!p.key.endsWith('|job:ship') || !p.skill) return {};
  const check = (p.skill as { compiled?: { check?: unknown } }).compiled?.check;
  const found = p.skill.branches ?? (typeof check === 'string' ? [...new Set([...check.matchAll(/refs\/heads\/([\w./-]+)/g)].map((m) => m[1]!))] : []);
  const branches = found.filter((b) => BRANCH.test(b)).slice(0, 3);
  return branches.length ? { branches } : {};
}

/** What goes on disk: a preference's name words never do (they are the person's words, 2.6). */
function onDisk(r: InitRecord): InitRecord {
  return {
    ...r, runs: r.runs.slice(-MAX_RUNS),
    pending: r.pending.map((p) => ({
      n: p.n, id: p.id, kind: p.kind, key: p.key, plainName: p.plainName, nameWords: p.kind === 'preference' ? [] : [...p.nameWords], count: { ...p.count },
      applies: p.applies, scope: p.scope, typed: p.typed, ticked: p.ticked,
      ...(p.skill ? { skill: { src: p.skill.src, ...branchesOf(p) } } : {}), ...(p.guardrail ? { guardrail: p.guardrail } : {}), ...(p.pref ? { pref: { refs: p.pref.refs.slice(0, 3) } } : {}),
    })),
  };
}

const LINKED = "trail: a link sits in ~/.trail/init where this repo's init record goes, so Trail won't write through it. Remove the link and run trail init again.";

export function writeInitRecord(repoKey: string, r: InitRecord, env?: NodeJS.ProcessEnv): void {
  if (!noLinkTo(initRecordPath(repoKey, env), env)) throw new Error(LINKED);
  writePrivate(initRecordPath(repoKey, env), `${JSON.stringify(onDisk({ ...r, v: 2, repo: repoKey }), null, 2)}\n`);
}

/** Read, change and write back under the record's lock. Throws when the lock can't be had (another init is writing). */
/** How long a hook waits for the record's lock (b7 review): session start has 400 ms in all; a busy record waits for the next one. */
export const HOOK_RECORD_WAIT_MS = 50;

export function updateInitRecord(repoKey: string, change: (r: InitRecord) => void, env?: NodeJS.ProcessEnv, waitMs = 2000): InitRecord {
  const path = initRecordPath(repoKey, env);
  // Before the lock: taking it makes the folder, which must not happen through a planted link.
  if (!noLinkTo(path, env)) throw new Error(LINKED);
  const done = withLock(path, () => {
    const r = readInitRecord(repoKey, env);
    change(r);
    writeInitRecord(repoKey, r, env);
    return r;
  }, waitMs);
  if (!done.ok) throw new Error("trail: this repo's init record is busy (another trail init or keep is writing it). Try again.");
  return done.value;
}

export function pendingItems(r: InitRecord): InitRecord['pending'] {
  return r.pending;
}

/**
 * Every init record on this machine, with its repo key (from its path): the keep gate's way to the record without
 * resolving the repo (it runs on the hook's path, R11). At most 200 files, 6 folders deep, plain files only.
 */
export function listInitRecords(env?: NodeJS.ProcessEnv): Array<{ repoKey: string; record: InitRecord }> {
  const root = trailPath(env, 'init');
  const out: Array<{ repoKey: string; record: InitRecord }> = [];
  const walk = (dir: string, parts: string[]) => {
    if (parts.length > 6 || out.length >= 200) return;
    let names: import('node:fs').Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (out.length >= 200) return;
      if (d.isDirectory()) walk(join(dir, d.name), [...parts, d.name]);
      else if (d.isFile() && d.name.endsWith('.json')) {
        const repoKey = [...parts, d.name.slice(0, -5)].join('/');
        try {
          const text = readPlain(join(dir, d.name), MAX_FILE);
          if (text !== null) out.push({ repoKey, record: recordFrom(JSON.parse(text), repoKey) });
        } catch { /* not a record */ }
      }
    }
  };
  walk(root, []);
  return out;
}
