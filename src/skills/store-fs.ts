/**
 * The file side of the skill store (store.ts, store-held.ts): private
 * folders that never chmod or write through a link, capped reads, the one
 * store lock, a skill folder written whole, and the state entry and ledger
 * line a new personal skill starts with.
 *
 * A name reaches here from an agent's command line or a person's, so every
 * name is checked to be one folder name before it is joined to a path.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompiledSkill, SkillFrom, SkillRef, SkillState } from './types.js';
import { trailPath, withLock, writePrivate, type Locked } from '../util/private-fs.js';
import { BUILT_IN_NAMES, goodName } from './compile-words.js';
import { appendLedger } from './ledger.js';
import { getSkillState, updateSkillState } from './state.js';
import { localDate } from './settings.js';
import { randomBytes } from 'node:crypto';
import { linkedOwnFolder, ownFolder } from './own-folder.js';

const POSIX = process.platform !== 'win32';
/** SKILL.md is at most 60 lines; anything this big is not one. */
export const MAX_SKILL_BYTES = 64 * 1024;
/** How long a person's command waits for the store; a hook's bookkeeping waits less. */
export const PERSON_WAIT_MS = 1000;
export const HOOK_WAIT_MS = 200;

/** One folder name: no separators, no dot start, no `..`. Wider than NAME_RE so hand-made folders can be named back. */
export const safeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(name)) && !String(name).includes('..');

export const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
export const statOrNull = (p: string): Stats | null => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

/** A folder of ours: made 0700 when missing, tightened when it is a real folder; a link is left as it is (never chmod through it). */
export function privateDir(dir: string): void {
  if (!lstatOrNull(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatOrNull(dir);
  if (POSIX && st?.isDirectory()) {
    try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  }
}

/** The file's text when it is a regular file (links followed) of at most 64 KB; null otherwise. */
export function readCapped(file: string): string | null {
  const st = statOrNull(file);
  if (!st?.isFile() || st.size > MAX_SKILL_BYTES) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export const skillsDir = (env?: NodeJS.ProcessEnv) => trailPath(env, 'skills');
export const heldDir = (env?: NodeJS.ProcessEnv) => trailPath(env, 'held');
export const retiredDir = (env?: NodeJS.ProcessEnv) => join(skillsDir(env), '.retired');

/**
 * Every change to skills/ or held/ runs under one lock (`skills/.store.lock`). Throws when it can't be had in time,
 * and before anything is written when one of Trail's own folders is a link (own-folder.ts).
 */
export function underStoreLock<T>(env: NodeJS.ProcessEnv | undefined, fn: () => T, waitMs = PERSON_WAIT_MS): T {
  const linked = linkedOwnFolder(env);
  if (linked) ownFolder(trailPath(env, linked));
  const done = tryStoreLock(env, fn, waitMs);
  if (!done.ok) throw new Error('trail: the skill store is busy (another trail command is changing it). Try again.');
  return done.value;
}

/** The same lock for a hook's bookkeeping: `{ ok: false }` when busy or when one of Trail's own folders is a link; nothing changed. */
export function tryStoreLock<T>(env: NodeJS.ProcessEnv | undefined, fn: () => T, waitMs = HOOK_WAIT_MS): Locked<T> {
  if (linkedOwnFolder(env)) return { ok: false };
  privateDir(trailPath(env));
  privateDir(skillsDir(env));
  return withLock(join(skillsDir(env), '.store'), fn, waitMs);
}

/**
 * A skill's folder, written whole into a folder that must not exist yet (made here, 0700): SKILL.md (0600), each
 * helper in scripts/ (0700), and an empty lessons/ when asked. Throws on a folder already there (a link included),
 * a bad name, or a helper whose file name is not one plain file name.
 */
export function writeSkillFolder(dir: string, c: CompiledSkill, text: string, opts: { lessons: boolean }): void {
  for (const h of c.helpers) if (!safeName(h.file)) throw new Error(`trail: a helper script needs a plain file name: ${JSON.stringify(h.file).slice(0, 60)}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`trail: a skill folder called ${c.name} is already there`);
    throw e;
  }
  try {
    privateDir(dir);
    writePrivate(join(dir, 'SKILL.md'), text);
    if (c.helpers.length || opts.lessons) privateDir(join(dir, 'scripts'));
    for (const h of c.helpers) writePrivate(join(dir, 'scripts', h.file), h.content, 0o700);
    if (opts.lessons) privateDir(join(dir, 'lessons'));
  } catch (e) {
    // Half a skill (a full disk) would hold the name and never list: the folder made above goes.
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

export function newSkillId(): string {
  return `s-${randomBytes(3).toString('hex')}`;
}

/**
 * The id to save under: the compiled one, unless another skill already holds it, a retired one included (restoring
 * it brings its state back under that id, so two skills must never share one).
 */
export function freeId(id: string, name: string, env?: NodeJS.ProcessEnv): string {
  const held = (x: string) => {
    const s = getSkillState(x, env);
    return s !== null && s.name !== name;
  };
  let out = id;
  for (let i = 0; i < 64 && held(out); i++) out = newSkillId();
  return out;
}

/** Throws unless the name can be a saved skill's: NAME_RE, no `--` or trailing dash, not one of Trail's own words. */
export function checkSaveName(name: string): void {
  if (!goodName(name)) throw new Error(`trail: not a skill name: ${JSON.stringify(name).slice(0, 60)}`);
}

/** The skill folders other tools keep in the person's home (`~/.claude/skills`, `~/.agents/skills`, `$CLAUDE_CONFIG_DIR/skills`). */
export function homeSkillDirs(env?: NodeJS.ProcessEnv): string[] {
  const e = env ?? process.env;
  const home = e.HOME || homedir();
  const dirs = [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')];
  if (e.CLAUDE_CONFIG_DIR) dirs.push(join(e.CLAUDE_CONFIG_DIR, 'skills'));
  return dirs;
}

/** What keeping or restoring a skill would collide with, without a checkout: built in, a personal skill, a host's skill. */
export function takenAtHome(name: string, env?: NodeJS.ProcessEnv): 'built-in' | 'personal' | 'host' | null {
  if (BUILT_IN_NAMES.has(name)) return 'built-in';
  if (lstatOrNull(join(skillsDir(env), name))) return 'personal';
  if (homeSkillDirs(env).some((d) => lstatOrNull(join(d, name)))) return 'host';
  return null;
}

export function personalRef(id: string, name: string, applies: string | null, env?: NodeJS.ProcessEnv): SkillRef {
  const dir = join(skillsDir(env), name);
  return { id, name, scope: 'personal', applies, dir, file: join(dir, 'SKILL.md') };
}

/**
 * A new personal skill's state (candidate, uses 0) and its ledger `saved` line. Throws when the state can't be
 * written (its lock busy, as a hook that died holding it leaves it for 10 s): a skill with no state entry would be
 * recalled but could never count a use, so the caller undoes the save.
 */
export function startSkill(id: string, init: {
  name: string; from: SkillFrom; runId: string | null; hash: string; source: SkillState['source']; version: string;
  consent: 'offer-yes' | 'asked' | 'init'; stepsVerified: number; stepsTotal: number; now: Date; env?: NodeJS.ProcessEnv;
}): void {
  const at = init.now.toISOString();
  const written = updateSkillState(id, () => ({
    name: init.name, scope: 'personal', status: 'candidate', from: init.from, runId: init.runId, addedAt: at,
    lastWorked: init.source ? localDate(init.source.at) : null, lastUsedAt: null, lastUsedRepo: null, uses: 0, checkedUses: 0,
    hash: init.hash, source: init.source, lastFails: [], promoteOffers: {},
  }), init.env);
  if (!written) throw new Error('trail: the skill state is busy (a hook is writing it). Try again in a few seconds.');
  try {
    appendLedger(id, {
      at, event: 'saved', skill: id, v: init.version, from: init.from, scope: 'personal',
      receipt: { consent: init.consent, stepsVerified: init.stepsVerified, stepsTotal: init.stepsTotal },
    }, init.env);
  } catch { /* the state is the truth; the ledger is its record */ }
}

/** Compiled steps plus a check that is not itself a step (4.9 step 10). */
export const stepsTotal = (c: Pick<CompiledSkill, 'steps' | 'check' | 'checkIsStep'>) => c.steps.length + (c.check && !c.checkIsStep ? 1 : 0);
