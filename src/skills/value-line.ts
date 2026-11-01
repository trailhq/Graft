/**
 * The weekly value line (design 4.14, P19 to P21): what the skills and the
 * guardrail did in this repo last week, from what this machine kept and
 * nothing else. Uses come from the ledger `use` lines of the skills that
 * apply here (the last 64 KB of each ledger, at most 5 skills, most used
 * first), "before it" from the run each skill came from, and the guardrail
 * stops and wall fixes from `state/value.json`, which Stop adds to per local
 * day. The line says failed commands, not failed pushes: the ledger keeps a
 * count of failed commands per use, not their kind (P19).
 *
 * Said once in 7 days per repo (`valueDue`), never in the first 7 days after
 * skills turned on (there is no week yet, P21), at a startup or resume of an
 * interactive top-level session (`startValue`), and always on top of
 * `trail skills`. `trail skills offers off` doesn't silence it (a count, not
 * an offer); `trail skills off` does.
 *
 * `value.json` holds counts, local days and repo keys only. Every write is a
 * 50 ms lock try (D117): a busy lock drops the count, never waits. Nothing is
 * written through a linked state folder, and a FIFO or link at the file is
 * read as empty, never waited on.
 */
import { closeSync, fstatSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Host } from '../trace/host.js';
import { openPlain, readPlain } from '../init/plain-file.js';
import { flatLine } from '../notes/flatten.js';
import { trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { FROM_TRAIL } from './directive-words.js';
import { hostFacts } from './host-facts.js';
import { ledgerPath } from './ledger.js';
import { isLinked } from './own-folder.js';
import { localDate, readSettings } from './settings.js';
import { readSkillsState } from './state.js';
import { listSkills } from './store.js';

/** The words of the line and of the context that carries it (0 rule 6: the words test reads them by value). */
export const VALUE_COPY = {
  head: 'Last week in this repo, on this machine:',
  ran: 'ran',
  withFailed: 'with',
  failedCommand: 'failed command',
  before: 'the run it came from had',
  inAll: 'in all',
  guardrail: 'the timeout learning stopped',
  command: 'command',
  knownError: 'known error',
  cameWithIts: 'came with its fix',
  cameWithTheir: 'came with their fix',
  noticePrefix: 'trail:',
  contextHead: 'Its weekly count for this repo, for the person:',
  contextTail: 'Tell them once at the start of your first reply, in one line, then go on with what they asked.',
} as const;

/** The longest line (4.14). */
export const VALUE_MAX = 240;
const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const KEEP_DAYS = 14;
const MAX_SKILLS = 5;
const LEDGER_TAIL = 64 * 1024;
const VALUE_MAX_BYTES = 128 * 1024;
const MAX_REPOS = 50;
const COUNT_MAX = 1_000_000;
/** D117: a hook's bookkeeping lock try; a busy lock drops the count. */
export const VALUE_LOCK_MS = 50;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A repo key as Trail makes them (`github.com/acme/shop`, `local/home-dev-shop`): never a sentence. */
const REPO_KEY = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/;

interface DayCounts { g: number; w: number }
interface RepoValue { saidAt: string | null; days: Record<string, DayCounts> }
interface ValueFile { v: 1; repos: Record<string, RepoValue> }

/** One skill's week here: uses, uses whose check passed, failed commands summed, and the run it came from. */
export interface SkillWeek { id: string; name: string; uses: number; checked: number; failed: number; before: { commands: number; failed: number } | null }
export interface ValueCounts { skills: SkillWeek[]; guardrailStops: number; wallFixes: number }

export function valuePath(env?: NodeJS.ProcessEnv): string {
  return trailPath(env, 'state', 'value.json');
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, COUNT_MAX) : 0);
const keyOf = (repoKey: unknown): string | null => {
  const k = typeof repoKey === 'string' ? repoKey.toLowerCase() : '';
  return k.length <= 200 && REPO_KEY.test(k) && !k.split('/').some((p) => p === '.' || p === '..') ? k : null;
};

/** The local day `n` days before `now`'s (noon, so a daylight-saving change can't skip or repeat a day). */
function dayBack(now: Date, n: number): string {
  return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12));
}
/** The 7 local days ending today. */
const inWeek = (d: string, now: Date) => d >= dayBack(now, WEEK_DAYS - 1) && d <= localDate(now);

/** value.json as read: known fields of the right shape only; anything else (a planted word included) is dropped. */
function readValue(env?: NodeJS.ProcessEnv): ValueFile {
  const out: ValueFile = { v: 1, repos: {} };
  let raw: unknown;
  try {
    const text = readPlain(valuePath(env), VALUE_MAX_BYTES);
    raw = text === null ? null : JSON.parse(text);
  } catch {
    return out;
  }
  if (!isMap(raw) || !isMap(raw.repos)) return out;
  for (const [k, v] of Object.entries(raw.repos)) {
    const key = keyOf(k);
    if (!key || key !== k || !isMap(v)) continue;
    const days: Record<string, DayCounts> = {};
    if (isMap(v.days)) {
      for (const [d, c] of Object.entries(v.days)) if (DAY.test(d) && isMap(c)) days[d] = { g: count(c.g), w: count(c.w) };
    }
    out.repos[key] = { saidAt: typeof v.saidAt === 'string' && DAY.test(v.saidAt) ? v.saidAt : null, days };
  }
  return out;
}

/** 14 local days per repo, at most 50 repos (the ones busy most lately). */
function prune(f: ValueFile, now: Date): void {
  const oldest = dayBack(now, KEEP_DAYS - 1);
  for (const r of Object.values(f.repos)) for (const d of Object.keys(r.days)) if (d < oldest) delete r.days[d];
  const last = (r: RepoValue) => [r.saidAt ?? '', ...Object.keys(r.days)].reduce((m, d) => (d > m ? d : m), '');
  const keys = Object.keys(f.repos);
  if (keys.length <= MAX_REPOS) return;
  for (const k of keys.sort((a, b) => last(f.repos[b]!).localeCompare(last(f.repos[a]!))).slice(MAX_REPOS)) delete f.repos[k];
}

/** One locked rewrite under a 50 ms try. False when busy, linked, it threw, or `fn` said false: nothing changed. */
function updateValue(env: NodeJS.ProcessEnv | undefined, now: Date, fn: (f: ValueFile) => boolean | void): boolean {
  const path = valuePath(env);
  try {
    if (isLinked(dirname(path))) return false;
    const done = withLock(path, () => {
      const f = readValue(env);
      if (fn(f) === false) return false;
      prune(f, now);
      writePrivate(path, `${JSON.stringify(f)}\n`);
      return true;
    }, VALUE_LOCK_MS);
    return done.ok && done.value;
  } catch {
    return false;
  }
}

/**
 * Stop (3.5): adds this Stop's guardrail stops and wall fixes to today's counts for the repo. Counts only: anything
 * but a non-negative whole number is 0, a repo key that isn't one is refused, and 0 and 0 writes nothing.
 */
export function noteValue(repoKey: string, d: { guardrailStops?: number; wallFixes?: number }, env?: NodeJS.ProcessEnv, now: Date = new Date()): void {
  const key = keyOf(repoKey);
  const g = count(d?.guardrailStops);
  const w = count(d?.wallFixes);
  if (!key || (!g && !w)) return;
  const today = localDate(now);
  updateValue(env, now, (f) => {
    const r = (f.repos[key] ??= { saidAt: null, days: {} });
    const c = (r.days[today] ??= { g: 0, w: 0 });
    c.g = Math.min(COUNT_MAX, c.g + g);
    c.w = Math.min(COUNT_MAX, c.w + w);
  });
}

/**
 * The week is due again: never said, said 7 local days back or more, or "said" more than 7 days ahead of today (the
 * clock was wrong then; a day or two ahead is another time zone and still this week's).
 */
const dueSince = (said: string | null, now: Date) => said === null || said <= dayBack(now, WEEK_DAYS) || said > dayBack(now, -WEEK_DAYS);

/**
 * Records that the line went out for the repo today, only while the week is still due: the check and the mark are one
 * locked step, so of sessions that start together and all read "due", one marks it (review). False when busy,
 * refused, or already said this week (the caller then says nothing).
 */
export function markValueSaid(repoKey: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): boolean {
  const key = keyOf(repoKey);
  if (!key) return false;
  return updateValue(env, now, (f) => {
    const r = (f.repos[key] ??= { saidAt: null, days: {} });
    if (!dueSince(r.saidAt, now)) return false;
    r.saidAt = localDate(now);
    return true;
  });
}

/** Skills on, and on for 7 days or more (P21: there is no week to count before that). */
export function valueWeek(env?: NodeJS.ProcessEnv, now: Date = new Date()): boolean {
  const s = readSettings(env);
  const on = s.onSince === null ? NaN : Date.parse(s.onSince);
  return s.skills === 'on' && !Number.isNaN(on) && now.getTime() - on >= WEEK_DAYS * DAY_MS;
}

/** Once in 7 days per repo, after the first week (4.14). */
export function valueDue(repoKey: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): boolean {
  const key = keyOf(repoKey);
  if (!key || !valueWeek(env, now)) return false;
  return dueSince(readValue(env).repos[key]?.saidAt ?? null, now);
}

/** The ledger's last 64 KB as lines (the first, cut, line dropped), from a plain file only; [] otherwise. */
function ledgerTail(skillId: string, env?: NodeJS.ProcessEnv): string[] {
  let fd = -1;
  try {
    fd = openPlain(ledgerPath(skillId, env));
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - LEDGER_TAIL);
    const buf = Buffer.alloc(size - from);
    const got = readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8', 0, got).split('\n');
    return from > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** A skill's uses in these repos in the week: count, checked, failed commands summed. */
function weekOf(skillId: string, keys: Set<string>, now: Date, env?: NodeJS.ProcessEnv): Pick<SkillWeek, 'uses' | 'checked' | 'failed'> {
  const out = { uses: 0, checked: 0, failed: 0 };
  // A use line written twice (a flush that ran again after its state write failed) is one use (review).
  const seen = new Set<string>();
  for (const raw of ledgerTail(skillId, env)) {
    if (!raw.includes('"use"')) continue;
    let l: Record<string, unknown>;
    try { l = JSON.parse(raw); } catch { continue; }
    if (!isMap(l) || l.event !== 'use' || typeof l.at !== 'string' || typeof l.repo !== 'string' || !keys.has(l.repo.toLowerCase())) continue;
    const at = new Date(l.at);
    if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() || !inWeek(localDate(at), now)) continue;
    if (typeof l.useId === 'string' && l.useId) {
      if (seen.has(l.useId)) continue;
      seen.add(l.useId);
    }
    out.uses++;
    if (l.check === 'passed') out.checked++;
    out.failed = Math.min(COUNT_MAX, out.failed + count(l.failed));
  }
  return out;
}

/** The week's counts for these repos (4.14): nothing but the ledgers and value.json. */
export function valueCounts(repoKeys: string[], env?: NodeJS.ProcessEnv, now: Date = new Date()): ValueCounts {
  const keys = new Set(repoKeys.map(keyOf).filter((k): k is string => k !== null));
  const out: ValueCounts = { skills: [], guardrailStops: 0, wallFixes: 0 };
  if (!keys.size) return out;
  const state = readSkillsState(env).skills;
  const refs = listSkills({ repoKeys: [...keys], checkout: '', env })
    .filter((r) => r.scope === 'personal')
    .sort((a, b) => (state[b.id]?.uses ?? 0) - (state[a.id]?.uses ?? 0) || a.name.localeCompare(b.name))
    .slice(0, MAX_SKILLS);
  for (const ref of refs) {
    const w = weekOf(ref.id, keys, now, env);
    if (!w.uses) continue;
    const src = state[ref.id]?.source ?? null;
    out.skills.push({ id: ref.id, name: ref.name, ...w, before: src ? { commands: src.commands, failed: src.failed } : null });
  }
  // Stable: skills with as many uses this week keep the most-used-first order.
  out.skills.sort((a, b) => b.uses - a.uses);
  const f = readValue(env);
  for (const k of keys) {
    for (const [d, c] of Object.entries(f.repos[k]?.days ?? {})) {
      if (!inWeek(d, now)) continue;
      out.guardrailStops = Math.min(COUNT_MAX, out.guardrailStops + c.g);
      out.wallFixes = Math.min(COUNT_MAX, out.wallFixes + c.w);
    }
  }
  return out;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * D134: one run says its failed commands beside the run the skill came from; more runs say the sum as a sum ("ran 3
 * times, 6 failed commands in all"), with no single run's count beside it to read as worse than it was.
 */
function skillPart(s: SkillWeek): string {
  const C = VALUE_COPY;
  const head = `${flatLine(s.name, 60)} ${C.ran} ${plural(s.uses, 'time')}`;
  if (s.uses > 1) return `${head}, ${plural(s.failed, C.failedCommand)} ${C.inAll}`;
  const before = s.before && s.before.failed > 0 ? ` (${C.before} ${s.before.failed})` : '';
  return `${head} ${C.withFailed} ${plural(s.failed, C.failedCommand)}${before}`;
}

/**
 * The line from the counts (4.14): parts at 0 left out, null when every part is 0. Cut to 240 characters at whole
 * parts, never inside one, so no number is cut short: the most used skill, the guardrail and the fixes come first,
 * then the other skills; what fits is said in the line's own order.
 */
export function valueWords(c: ValueCounts): string | null {
  const C = VALUE_COPY;
  const skills = c.skills.filter((s) => s.uses > 0).map(skillPart);
  const guard = c.guardrailStops > 0 ? `${C.guardrail} ${plural(c.guardrailStops, C.command)}` : null;
  const walls = c.wallFixes > 0 ? `${plural(c.wallFixes, C.knownError)} ${c.wallFixes === 1 ? C.cameWithIts : C.cameWithTheir}` : null;
  const ordered = [...skills, guard, walls].filter((p): p is string => p !== null);
  if (!ordered.length) return null;
  const byWeight = [skills[0], guard, walls, ...skills.slice(1)].filter((p): p is string => !!p);
  const render = (parts: string[]) => `${C.head} ${parts.join('; ')}.`;
  const kept = new Set<string>();
  for (const p of byWeight) {
    const next = ordered.filter((x) => kept.has(x) || x === p);
    if (render(next).length <= VALUE_MAX) kept.add(p);
  }
  return kept.size ? render(ordered.filter((x) => kept.has(x))) : null;
}

/** 4.14: the line for these repos, or null when there is nothing to say. */
export function valueLine(repoKeys: string[], env?: NodeJS.ProcessEnv, now: Date = new Date()): string | null {
  return valueWords(valueCounts(repoKeys, env, now));
}

/**
 * The line as SessionStart context where the host shows no start notice (P20, D107's shape): who it is from, that it
 * is a count for the person, and when to tell them. One line; the quoted line can't close the quote early.
 */
export function valueContext(line: string): string {
  const q = flatLine(line, VALUE_MAX + 20).replace(/"/g, "'").replace(/\[(?:trail|graft|trail-code)\]/gi, '');
  return `[trail] ${FROM_TRAIL} ${VALUE_COPY.contextHead} "${q}" ${VALUE_COPY.contextTail}`;
}

export interface StartValueCtx { source: string; learn: boolean; subagent: boolean; host: Host; repoKey: string }
export interface StartValue { channel: 'context' | 'notice'; context?: string; notice?: string }

/**
 * 3.1 step 3: at a startup or resume, in a session where learning runs (interactive, top level, tier A) and in a
 * repo, when the week is due and there is something to say: the line goes out once (marked said first; a busy lock
 * says nothing). A notice where the host shows SessionStart notices, else context. Never throws.
 */
export function startValue(ctx: StartValueCtx, env?: NodeJS.ProcessEnv, now: Date = new Date()): StartValue | null {
  try {
    if ((ctx.source !== 'startup' && ctx.source !== 'resume') || !ctx.learn || ctx.subagent || !ctx.repoKey) return null;
    if (!valueDue(ctx.repoKey, env, now)) return null;
    const line = valueLine([ctx.repoKey], env, now);
    if (!line || !markValueSaid(ctx.repoKey, env, now)) return null;
    return hostFacts(env, ctx.host).startNotice
      ? { channel: 'notice', notice: `${VALUE_COPY.noticePrefix} ${line}` }
      : { channel: 'context', context: valueContext(line) };
  } catch {
    return null;
  }
}

/** Stop: the timeout guardrail's sure-fail denies this Stop counted (`guardrailCounts`' telemetry), for `noteValue`. The line names that guardrail, so no other class counts. */
export function guardrailStopsIn(sent: ReadonlyArray<readonly [string, Record<string, string>]>): number {
  return sent.filter(([e, p]) => e === 'guardrail' && p?.class === 'no-timeout' && p?.outcome === 'sure-fail').length;
}
