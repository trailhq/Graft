/**
 * Held items (`~/.trail/held/<name>/`, design 2): a save Trail could not
 * trust, because the person never said yes or because it came from a host
 * where Trail can't check which steps ran. A held item is never read by
 * recall. It is shown once, at the next `startup` or `resume` of another
 * session than the one that held it (`session`, D93; `shownAt`), stays
 * keepable for 24 hours after that showing, and is then deleted (by
 * housekeeping, or here when kept). Only the person keeps one
 * (`trail skills keep <name>`, checked by `personAtTerminal`).
 *
 * `held/<name>/SKILL.md` is the skill as it would have been saved; its
 * `held.json` says why it was held, where it came from, and when it was shown.
 */
import { renameSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JobClass } from '../trace/types.js';
import type { CompiledSkill, SkillRef } from './types.js';
import type { PersonCheck } from './person.js';
import { readJsonSafe, writePrivate } from '../util/private-fs.js';
import { parseSkillMd, renderSkillMd, skillHash } from './skillmd.js';
import {
  checkSaveName, freeId, heldDir, lstatOrNull, personalRef, privateDir, readCapped, safeName, skillsDir, startSkill,
  stepsTotal, takenAtHome, tryStoreLock, underStoreLock, writeSkillFolder,
} from './store-fs.js';

export interface HeldItem {
  name: string; why: 'no-yes' | 'host'; host: string; job: JobClass | null; repoKey: string; at: string; shownAt: string | null; dir: string;
  /** The run it was compiled from (D65: a live save for the same run drops the held item instead of being refused). Null when held.json lacks it. */
  runId?: string | null;
  /** D93: sha256(sessionId).slice(0, 12) of the session that held it; null when held.json lacks it (written before). */
  session?: string | null;
}

/** held.json: the HeldItem without `dir`, plus what keeping it needs. */
interface HeldFile extends Omit<HeldItem, 'dir' | 'runId' | 'session'> {
  v: 1;
  id: string;
  runId: string;
  session?: string | null;
  source: { commands: number; failed: number; at: string };
  stepsTotal: number;
}

const KEEP_MS = 24 * 3600_000;

/** One held item as Trail wrote it: a real folder (never a link) with a valid held.json; null otherwise. */
function heldAt(name: string, env?: NodeJS.ProcessEnv): (HeldFile & { dir: string }) | null {
  if (!safeName(name)) return null;
  const dir = join(heldDir(env), name);
  if (!lstatOrNull(dir)?.isDirectory()) return null;
  const f = readJsonSafe<HeldFile>(join(dir, 'held.json'));
  if (!f || typeof f !== 'object' || f.name !== name || (f.why !== 'no-yes' && f.why !== 'host') || typeof f.repoKey !== 'string' || typeof f.at !== 'string') return null;
  if (f.shownAt !== null && typeof f.shownAt !== 'string') return null;
  return { ...f, dir };
}

const toItem = (f: HeldFile & { dir: string }): HeldItem => ({
  name: f.name, why: f.why, host: String(f.host ?? ''), job: f.job ?? null, repoKey: f.repoKey, at: f.at, shownAt: f.shownAt, dir: f.dir,
  runId: typeof f.runId === 'string' ? f.runId : null,
  session: typeof f.session === 'string' ? f.session : null,
});

/** Shown and more than 24 h ago: no longer keepable. */
const expired = (f: { shownAt: string | null }, now: Date) => f.shownAt !== null && now.getTime() - Date.parse(f.shownAt) >= KEEP_MS;

/** Every held item Trail wrote, whatever its age, oldest first. */
export function allHeld(env?: NodeJS.ProcessEnv): HeldItem[] {
  let names: string[];
  try {
    names = readdirSync(heldDir(env));
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith('.')).flatMap((n) => {
    const f = heldAt(n, env);
    return f ? [toItem(f)] : [];
  }).sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
}

/** Writes held/<name>/SKILL.md (+ scripts/) and held.json, replacing a held item of the same name. */
export function saveHeld(c: CompiledSkill, why: HeldItem['why'], meta: { host: string; job: JobClass | null; repoKey: string; session?: string | null }, env?: NodeJS.ProcessEnv, now: Date = new Date()): HeldItem {
  checkSaveName(c.name);
  return underStoreLock(env, () => {
    privateDir(heldDir(env));
    const dir = join(heldDir(env), c.name);
    rmSync(dir, { recursive: true, force: true }); // a link is removed, never followed
    writeSkillFolder(dir, c, renderSkillMd(c), { lessons: false });
    const f: HeldFile = {
      v: 1, name: c.name, why, host: meta.host, job: meta.job, repoKey: meta.repoKey, at: now.toISOString(), shownAt: null,
      id: c.meta.trail, runId: c.source.runId, ...(meta.session ? { session: meta.session } : {}), source: { commands: c.source.commands, failed: c.source.failed, at: c.source.at }, stepsTotal: stepsTotal(c),
    };
    writePrivate(join(dir, 'held.json'), JSON.stringify(f, null, 2));
    return toItem({ ...f, dir });
  });
}

/** Held items not shown yet, and shown ones younger than 24 h (still keepable). */
export function listHeld(env?: NodeJS.ProcessEnv, now: Date = new Date()): HeldItem[] {
  return allHeld(env).filter((h) => !expired(h, now));
}

/** Hook bookkeeping (SessionStart): a busy store leaves it unshown, to be shown next time. */
export function markHeldShown(name: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): void {
  tryStoreLock(env, () => {
    const f = heldAt(name, env);
    if (!f || f.shownAt !== null) return;
    const { dir, ...file } = f;
    writePrivate(join(dir, 'held.json'), JSON.stringify({ ...file, shownAt: now.toISOString() }, null, 2));
  });
}

export function dropHeld(name: string, env?: NodeJS.ProcessEnv): void {
  if (!safeName(name)) return;
  tryStoreLock(env, () => {
    const dir = join(heldDir(env), name);
    if (lstatOrNull(dir)) rmSync(dir, { recursive: true, force: true });
  });
}

/**
 * The person keeps a held item: it moves into skills/<name> as a candidate they asked for (ledger `saved`, consent
 * `asked`, no steps verified: the transcript was not read again). Refused for anyone but the person, an unknown or
 * expired item, or a name a personal skill, a host's skill or Trail itself already uses.
 */
export function keepHeld(name: string, person: PersonCheck, env?: NodeJS.ProcessEnv, now: Date = new Date()): { ok: true; ref: SkillRef } | { ok: false; reason: 'not-a-person' | 'unknown' | 'name-taken' } {
  if (!person.ok) return { ok: false, reason: 'not-a-person' };
  if (!safeName(name)) return { ok: false, reason: 'unknown' };
  return underStoreLock(env, () => {
    const f = heldAt(name, env);
    // Trail wrote held/<name>/SKILL.md itself: a link there is not its file.
    const own = f && !expired(f, now) && lstatOrNull(join(f.dir, 'SKILL.md'))?.isFile();
    const text = own ? readCapped(join(f.dir, 'SKILL.md')) : null;
    let parsed = text === null ? null : parseSkillMd(text, name);
    if (!f || text === null || !parsed) return { ok: false as const, reason: 'unknown' as const };
    if (takenAtHome(name, env)) return { ok: false as const, reason: 'name-taken' as const };
    const dir = join(skillsDir(env), name);
    renameSync(f.dir, dir);
    let file = text;
    try {
      rmSync(join(dir, 'held.json'), { force: true });
      privateDir(join(dir, 'scripts'));
      privateDir(join(dir, 'lessons'));
      const id = freeId(parsed.meta.trail, name, env);
      if (id !== parsed.meta.trail) {
        file = text.replace(/^(\s+trail:\s*)"[^"\n]*"\s*$/m, `$1"${id}"`);
        writePrivate(join(dir, 'SKILL.md'), file);
        parsed = parseSkillMd(file, name) ?? parsed;
      }
      startSkill(id, {
        name, from: 'asked', runId: f.runId ?? null, hash: skillHash(file), source: f.source ?? null, version: parsed.meta.version,
        consent: 'asked', stepsVerified: 0, stepsTotal: typeof f.stepsTotal === 'number' ? f.stepsTotal : parsed.steps.length, now, env,
      });
      return { ok: true as const, ref: personalRef(id, name, parsed.meta.applies ?? null, env) };
    } catch (e) {
      // Put the held item back as it was, so the person can keep it once the state is free.
      try {
        if (file !== text) writePrivate(join(dir, 'SKILL.md'), text);
        renameSync(dir, f.dir);
        const { dir: _dir, ...held } = f;
        writePrivate(join(f.dir, 'held.json'), JSON.stringify(held, null, 2));
      } catch { /* left in skills/ without state: listed, and the person can forget it */ }
      throw e;
    }
  });
}
