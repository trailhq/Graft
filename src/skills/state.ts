/**
 * `~/.trail/state/skills.json` (design 2.2, spec 6): what changes often
 * about each skill, per person, keyed by the skill id, for every scope:
 * status, where it came from, uses and checked uses, when it last worked,
 * the hash of the file as Trail last wrote it, and the failed step of the
 * last two uses. The SKILL.md holds only what describes the skill.
 *
 * Status moves (4.8, spec 13): a candidate becomes active on its first use
 * whose check passed; two uses in a row that failed at the same step, or
 * that the person corrected, make it needs-fix (never injected; the index
 * says why), and it goes back to what it was when its SKILL.md is changed by
 * hand. A failed ready probe never counts against it. Every move is a ledger
 * `status` line, written after the state file.
 *
 * Every write is a locked read-modify-write; a lock that can't be had in
 * time changes nothing. Keys a later version adds are kept.
 */
import { readFileSync, statSync } from 'node:fs';
import type { LedgerUse, SkillState, SkillStatus, SkillsStateFile } from './types.js';
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { appendLedger, readLedger } from './ledger.js';
import { localDate } from './settings.js';
import { parseSkillMd, skillHash } from './skillmd.js';
import { isLinked } from './own-folder.js';
import { dirname } from 'node:path';

const STATUSES = new Set<SkillStatus>(['candidate', 'active', 'needs-fix', 'retired']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Nov 2', in local time. */
const monthDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'an earlier day' : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

export function skillsStatePath(env?: NodeJS.ProcessEnv): string {
  return trailPath(env, 'state', 'skills.json');
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOr = <T>(v: unknown, d: T): string | T => (typeof v === 'string' ? v : d);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** An entry as read: null when it isn't one; missing newer fields get their defaults; unknown keys stay. */
function entryOf(v: unknown): SkillState | null {
  if (!isMap(v) || typeof v.name !== 'string' || !STATUSES.has(v.status as SkillStatus)) return null;
  const src = isMap(v.source) && typeof v.source.at === 'string' ? { commands: num(v.source.commands), failed: num(v.source.failed), at: v.source.at } : null;
  const fails = Array.isArray(v.lastFails)
    ? v.lastFails.filter((f): f is { step: number; at: string } => isMap(f) && typeof f.step === 'number' && typeof f.at === 'string').slice(-2)
    : [];
  const { fixHash, ...rest } = v;
  return {
    ...rest,
    ...(typeof fixHash === 'string' ? { fixHash } : {}),
    name: v.name,
    scope: v.scope === 'repo' || v.scope === 'team' ? v.scope : 'personal',
    status: v.status as SkillStatus,
    from: v.from === 'init' || v.from === 'repeated' || v.from === 'repaired' ? v.from : 'asked',
    runId: strOr(v.runId, null),
    addedAt: strOr(v.addedAt, ''),
    lastWorked: strOr(v.lastWorked, null),
    lastUsedAt: strOr(v.lastUsedAt, null),
    lastUsedRepo: strOr(v.lastUsedRepo, null),
    uses: num(v.uses),
    checkedUses: num(v.checkedUses),
    hash: strOr(v.hash, ''),
    source: src,
    lastFails: fails.map((f) => ({ step: f.step, at: f.at })),
    promoteOffers: isMap(v.promoteOffers) ? (v.promoteOffers as SkillState['promoteOffers']) : {},
  } as SkillState;
}

function fileOf(raw: unknown): SkillsStateFile {
  const skills: Record<string, SkillState> = {};
  if (isMap(raw) && isMap(raw.skills)) {
    for (const [id, v] of Object.entries(raw.skills)) {
      const e = entryOf(v);
      if (e) skills[id] = e;
    }
  }
  return { v: 1, skills };
}

export function readSkillsState(env?: NodeJS.ProcessEnv): SkillsStateFile {
  return fileOf(readJsonSafe<unknown>(skillsStatePath(env)));
}

export function getSkillState(id: string, env?: NodeJS.ProcessEnv): SkillState | null {
  return readSkillsState(env).skills[id] ?? null;
}

/**
 * Locked read-modify-write of one entry. Return undefined from fn to delete. undefined also when the lock timed out,
 * or when the state folder is a link (never written through, own-folder.ts): nothing changed either way.
 */
export function updateSkillState(id: string, fn: (s: SkillState | undefined) => SkillState | undefined, env?: NodeJS.ProcessEnv): SkillState | undefined {
  const path = skillsStatePath(env);
  if (isLinked(dirname(path))) return undefined;
  const done = withLock(path, () => {
    const raw = readJsonSafe<unknown>(path);
    const keep = isMap(raw) ? raw : {};
    const file = fileOf(raw);
    const had = file.skills[id];
    const next = fn(had === undefined ? undefined : structuredClone(had));
    if (next === undefined) {
      if (had === undefined) return undefined;
      delete file.skills[id];
    } else file.skills[id] = next;
    writePrivate(path, `${JSON.stringify({ ...keep, v: 1, skills: file.skills }, null, 2)}\n`);
    return next;
  });
  return done.ok ? done.value : undefined;
}

type StatusLine = { at: string; from: SkillStatus; to: SkillStatus; reason: 'checked-use' | 'failed-twice' | 'forget' | 'restore' };

/** updateSkillState, then the ledger status lines fn collected, only once the state is written. */
function change(id: string, env: NodeJS.ProcessEnv | undefined, fn: (s: SkillState, moves: StatusLine[]) => SkillState | undefined): SkillState | undefined {
  const moves: StatusLine[] = [];
  const next = updateSkillState(id, (s) => (s ? fn(s, moves) : undefined), env);
  if (next) for (const m of moves) {
    try { appendLedger(id, { event: 'status', skill: id, ...m }, env); } catch { /* the state is the truth; the ledger is its record */ }
  }
  return next;
}

/**
 * The hash of the personal skill's SKILL.md as it is now (`skills/<name>/SKILL.md`, a regular file of at most
 * 64 KB that is still this skill's), or undefined. D65: kept when the skill is marked needs-fix, so a hand edit
 * made before the failures is not taken for a fix.
 */
function fileHashOf(id: string, name: string, env?: NodeJS.ProcessEnv): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes('..')) return undefined; // one folder name only
  try {
    const file = trailPath(env, 'skills', name, 'SKILL.md');
    const st = statSync(file);
    if (!st.isFile() || st.size > 64 * 1024) return undefined;
    const text = readFileSync(file, 'utf8');
    return parseSkillMd(text, name)?.meta.trail === id ? skillHash(text) : undefined;
  } catch {
    return undefined;
  }
}

/** To needs-fix from candidate or active, keeping what it was and the file's hash right now. */
function markNeedsFix(id: string, s: SkillState, why: string, at: string, moves: StatusLine[], env?: NodeJS.ProcessEnv): void {
  if (s.status !== 'candidate' && s.status !== 'active') return;
  moves.push({ at, from: s.status, to: 'needs-fix', reason: 'failed-twice' });
  s.prevStatus = s.status;
  s.status = 'needs-fix';
  s.statusWhy = why;
  const now = fileHashOf(id, s.name, env);
  if (now) s.fixHash = now;
  else delete s.fixHash;
}

/**
 * 4.8, after the caller wrote the ledger `use` line: uses, lastUsedAt/Repo; a passed check counts as a checked use,
 * sets lastWorked (local date) and makes a candidate active; the failed step joins lastFails (the last two), and two
 * at the same step make it needs-fix; a use with no failed step empties lastFails. Ready probes never count.
 */
export function recordUse(id: string, use: LedgerUse, env?: NodeJS.ProcessEnv): SkillState | undefined {
  return change(id, env, (s, moves) => {
    s.uses += 1;
    s.lastUsedAt = use.at;
    s.lastUsedRepo = use.repo;
    if (use.check === 'passed') {
      s.checkedUses += 1;
      s.lastWorked = localDate(use.at);
      if (s.status === 'candidate') {
        moves.push({ at: use.at, from: 'candidate', to: 'active', reason: 'checked-use' });
        s.status = 'active';
      }
    }
    if (use.failedStep === null) s.lastFails = [];
    else {
      s.lastFails = [...s.lastFails, { step: use.failedStep, at: use.at }].slice(-2);
      const [a, b] = s.lastFails;
      if (a && b && a.step === b.step) markNeedsFix(id, s, `step ${b.step} failed on ${monthDay(a.at)} and ${monthDay(b.at)}`, use.at, moves, env);
    }
    return s;
  });
}

/**
 * The person corrected a use within 2 prompts (3.2 step 5): one ledger `corrected` line per use, and when the use
 * right before or after it in the ledger was corrected too, needs-fix (spec 13: two uses in a row corrected).
 * The ledger is read and the line written under the state lock, so two hooks correcting neighbouring uses at once
 * each see the other's line. undefined when the skill has no state or no such use, or the ledger can't be written.
 */
export function recordCorrected(id: string, useId: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): SkillState | undefined {
  const at = now.toISOString();
  let found = false;
  const next = change(id, env, (s, moves) => {
    const lines = readLedger(id, env);
    const uses = lines.filter((l): l is LedgerUse => l.event === 'use');
    const i = uses.findIndex((u) => u.useId === useId);
    if (i < 0) return s;
    const corrected = new Set(lines.flatMap((l) => (l.event === 'corrected' ? [l.useId] : [])));
    if (!corrected.has(useId)) {
      try {
        appendLedger(id, { at, event: 'corrected', skill: id, useId }, env);
      } catch {
        return s;
      }
      corrected.add(useId);
    }
    found = true;
    const pair = [uses[i - 1], uses[i + 1]].find((u) => u && corrected.has(u.useId));
    if (pair) {
      const [a, b] = Date.parse(pair.at) < Date.parse(uses[i]!.at) ? [pair, uses[i]!] : [uses[i]!, pair];
      markNeedsFix(id, s, `corrected after its use on ${monthDay(a.at)} and ${monthDay(b.at)}`, at, moves, env);
    }
    return s;
  });
  return found ? next : undefined;
}

/**
 * A needs-fix skill whose SKILL.md changed by hand after it was marked (its hash is not the one kept at the mark,
 * `fixHash`, D65; the hash Trail wrote when no mark hash was kept) was fixed: it goes back to what it was (4.8;
 * candidate when that is unknown), with its failures forgotten. An edit made before the failures is not a fix, so
 * it can't bring the skill back read after read. `hash` stays the one Trail wrote (spec 6: hand edits are phase 2's
 * to propose a diff for). Any other status is left alone.
 */
export function handEdited(id: string, fileHash: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): SkillState | undefined {
  // Checked before the lock (most reads change nothing) and again under it.
  const edited = (e: SkillState) => e.status === 'needs-fix' && fileHash !== (e.fixHash ?? e.hash);
  const s = getSkillState(id, env);
  if (!s || !edited(s)) return s ?? undefined;
  return change(id, env, (e, moves) => {
    if (!edited(e)) return e;
    const back = e.prevStatus && e.prevStatus !== 'needs-fix' && e.prevStatus !== 'retired' ? e.prevStatus : 'candidate';
    moves.push({ at: now.toISOString(), from: 'needs-fix', to: back, reason: 'restore' });
    e.status = back;
    e.lastFails = [];
    delete e.statusWhy;
    delete e.prevStatus;
    delete e.fixHash;
    return e;
  });
}

/** The skill used most recently in any of repoKeys, with when (for the check cue). A retired skill never answers. */
export function lastUsedIn(repoKeys: string[], env?: NodeJS.ProcessEnv): { id: string; at: string } | null {
  const keys = new Set(repoKeys.map((k) => k.toLowerCase()));
  let best: { id: string; at: string } | null = null;
  for (const [id, s] of Object.entries(readSkillsState(env).skills)) {
    if (s.status === 'retired' || !s.lastUsedAt || !s.lastUsedRepo || !keys.has(s.lastUsedRepo.toLowerCase())) continue;
    if (!best || Date.parse(s.lastUsedAt) > Date.parse(best.at)) best = { id, at: s.lastUsedAt };
  }
  return best;
}
