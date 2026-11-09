/**
 * `~/.trail/settings.json`: learned skills on or off (on by default), offers
 * on or off (everywhere or per repo), pauses after two nos, skills a person
 * turned off, and the governor's cache. On by default changes no consent:
 * nothing is kept or changed without the person's typed yes at each offer and
 * update, and a step that can't be undone still asks first.
 *
 * Who may change what is fixed: only the person's own commands (the setters,
 * imported only by `skills/cli-skills.ts`) turn skills and offers on or off;
 * only the offer bookkeeping (`skills/offers.ts`) writes pauses and the
 * governor. `trail init`, upgrades and `trail connect` never write this file.
 * A test pins who imports what.
 *
 * A missing or broken file reads as the defaults. Keys a later version adds
 * are kept on every write.
 */
import type { TrailSkillSettings } from './types.js';
import { isTestHome } from './host-facts.js';
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';

export { isTestHome, labInteractive } from './host-facts.js';

export const DEFAULT_SETTINGS: TrailSkillSettings = Object.freeze({
  v: 1, skills: 'on', onSince: null, offers: 'on', offersOffAt: null, offRepos: Object.freeze([]) as unknown as string[],
  pausedUntil: Object.freeze({}) as Record<string, string>, skillsOff: Object.freeze([]) as unknown as string[],
  lastNine: Object.freeze([]) as unknown as Array<'yes' | 'no' | 'none'>, governorSaidAt: null,
} as TrailSkillSettings);

/** How long a person's command waits for the file; a hook's bookkeeping waits less. */
const PERSON_WAIT_MS = 1000;
const HOOK_WAIT_MS = 200;
const ANSWERS = new Set(['yes', 'no', 'none']);

function settingsPath(env?: NodeJS.ProcessEnv): string {
  return trailPath(env, 'settings.json');
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The known fields of whatever was on disk, each its default when missing or of the wrong shape. */
function fromRaw(raw: unknown): TrailSkillSettings {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const paused: Record<string, string> = {};
  if (r.pausedUntil && typeof r.pausedUntil === 'object' && !Array.isArray(r.pausedUntil)) {
    for (const [k, v] of Object.entries(r.pausedUntil as Record<string, unknown>)) if (typeof v === 'string') paused[k] = v;
  }
  return {
    v: 1,
    // On unless the person turned skills off (`trail skills off`).
    skills: r.skills === 'off' ? 'off' : 'on',
    onSince: strOrNull(r.onSince),
    offers: r.offers === 'off' ? 'off' : 'on',
    offersOffAt: strOrNull(r.offersOffAt),
    offRepos: strings(r.offRepos),
    pausedUntil: paused,
    skillsOff: strings(r.skillsOff),
    lastNine: (Array.isArray(r.lastNine) ? r.lastNine : []).filter((a): a is 'yes' | 'no' | 'none' => ANSWERS.has(a as string)).slice(-9),
    governorSaidAt: strOrNull(r.governorSaidAt),
  };
}

/** Defaults on a missing or bad file; unknown keys are kept on every write. */
export function readSettings(env?: NodeJS.ProcessEnv): TrailSkillSettings {
  return fromRaw(readJsonSafe<unknown>(settingsPath(env)));
}

/** Read, change, write back under the file's lock, keeping keys this version doesn't know. */
function update(env: NodeJS.ProcessEnv | undefined, change: (s: TrailSkillSettings) => void, waitMs: number): TrailSkillSettings {
  const path = settingsPath(env);
  const done = withLock(path, () => {
    const raw = readJsonSafe<unknown>(path);
    const keep = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const s = fromRaw(raw);
    change(s);
    writePrivate(path, `${JSON.stringify({ ...keep, ...s }, null, 2)}\n`);
    return s;
  }, waitMs);
  if (!done.ok) throw new Error('trail: the skills settings are busy (another trail command is writing them). Try again.');
  return done.value;
}

/** TRAIL_TEST_NOW (ISO) in a test home only; else new Date(). */
export function trailNow(env: NodeJS.ProcessEnv = process.env): Date {
  const fixed = env.TRAIL_TEST_NOW;
  if (fixed && isTestHome(env)) {
    const d = new Date(fixed);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** The local calendar date `YYYY-MM-DD` of a time: days (pauses, session-days, last worked) are the person's days. */
export function localDate(at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// Person-only setters. Only src/skills/cli-skills.ts imports these (a static test, G0).

/** onSince = now when it turns on. */
export function setSkills(on: boolean, env?: NodeJS.ProcessEnv, now: Date = new Date()): TrailSkillSettings {
  return update(env, (s) => {
    if (on && (s.skills !== 'on' || s.onSince === null)) s.onSince = now.toISOString();
    s.skills = on ? 'on' : 'off';
  }, PERSON_WAIT_MS);
}

/** here: adds or removes that repo key in offRepos; a global off sets offersOffAt. */
export function setOffers(on: boolean, here: string | null, env?: NodeJS.ProcessEnv, now: Date = new Date()): TrailSkillSettings {
  return update(env, (s) => {
    if (here !== null) {
      s.offRepos = s.offRepos.filter((k) => k !== here);
      if (!on) s.offRepos.push(here);
      return;
    }
    if (!on && s.offers !== 'off') s.offersOffAt = now.toISOString();
    if (on) s.offersOffAt = null;
    s.offers = on ? 'on' : 'off';
  }, PERSON_WAIT_MS);
}

export function setSkillOff(name: string, off: boolean, env?: NodeJS.ProcessEnv): TrailSkillSettings {
  return update(env, (s) => {
    s.skillsOff = s.skillsOff.filter((n) => n !== name);
    if (off) s.skillsOff.push(name);
  }, PERSON_WAIT_MS);
}

/**
 * Skills are on by default, so `onSince` (the first week's offer cap, the
 * weekly value line) starts at the first session start that finds them on
 * with no date yet. Writes only `onSince`, and only then; never turns
 * anything on or off. Only src/claude/skills-wiring.ts imports it (the same
 * test).
 */
export function noteSkillsStarted(env?: NodeJS.ProcessEnv, now: Date = new Date()): void {
  const s = readSettings(env);
  if (s.skills !== 'on' || s.onSince !== null) return;
  try {
    update(env, (cur) => {
      if (cur.skills === 'on' && cur.onSince === null) cur.onSince = now.toISOString();
    }, HOOK_WAIT_MS);
  } catch {
    /* busy: the next session start tries again */
  }
}

// Bookkeeping writers. Only src/skills/offers.ts imports these (the same test).

export function pauseRepo(repoKey: string, until: Date, env?: NodeJS.ProcessEnv): TrailSkillSettings {
  return update(env, (s) => {
    s.pausedUntil = { ...s.pausedUntil, [repoKey]: localDate(until) };
  }, HOOK_WAIT_MS);
}

export function noteGovernor(lastNine: Array<'yes' | 'no' | 'none'>, saidAt: string | null, env?: NodeJS.ProcessEnv): TrailSkillSettings {
  return update(env, (s) => {
    s.lastNine = lastNine.filter((a) => ANSWERS.has(a)).slice(-9);
    s.governorSaidAt = saidAt;
  }, HOOK_WAIT_MS);
}

export function skillsOn(env?: NodeJS.ProcessEnv): boolean {
  return readSettings(env).skills === 'on';
}

export function offersHere(repoKey: string, now: Date = new Date(), env?: NodeJS.ProcessEnv): { ok: true } | { ok: false; why: 'off' | 'off-here' | 'paused' } {
  const s = readSettings(env);
  if (s.offers === 'off') return { ok: false, why: 'off' };
  if (s.offRepos.includes(repoKey)) return { ok: false, why: 'off-here' };
  const until = s.pausedUntil[repoKey];
  if (until && until > localDate(now)) return { ok: false, why: 'paused' };
  return { ok: true };
}
