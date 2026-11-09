/**
 * `<trail home>/walls.json` (design 2.7, R57): one machine-wide file for the
 * wall hits seen, the repairs that fixed them, the sessions init already
 * counted, and the lessons that worked.
 *
 * Classes, programs, repo keys, delta kinds and names, 12-hex session
 * hashes and local dates only: never a command, never its output. Every
 * value is checked against its shape on the way in, so an entry that could
 * carry text is dropped rather than written.
 *
 * Writes take the file's lock for at most 200 ms; a write that can't get it
 * is skipped and logged (a lost hit is better than a hook that waits).
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { hookError } from '../claude/skills-hook-util.js';
import { WALL_CLASSES } from '../notes/learning-fields.js';
import { trailPath, withLock, writePrivateJson } from '../util/private-fs.js';
import type { FixDeltaKind, WallClass } from './types.js';

export interface WallsFile {
  v: 1;
  /** Session hashes (12 hex) whose hits and repairs are already in, with 'size:mtimeMs' when init read them. */
  read: Record<string, string>;
  classes: Partial<Record<WallClass, WallClassState>>;
}

export interface WallClassState {
  /** One per (sh, epoch, program); newest last; at most 60. */
  seen: Array<{ d: string; sh: string; epoch: number; repo: string; program: string }>;
  /** Repairs: no command text, delta kinds and names only; newest last; at most 60. */
  fixed: Array<{ d: string; sh: string; epoch: number; repo: string; program: string; delta: Array<{ kind: FixDeltaKind; name: string }> }>;
  /** lesson id -> epochs it worked in (4.10). */
  lessons: Record<string, { worked: Array<{ sh: string; epoch: number; d: string }> }>;
}

type Seen = WallClassState['seen'][number];
type Fixed = WallClassState['fixed'][number];
type Worked = { cls: WallClass; lessonId: string; sh: string; epoch: number; d: string };

const CAP = 60;
const WORKED_CAP = 60;
/** Lesson ids kept per class: the ones that worked most recently. */
const LESSONS_CAP = 60;
/** The file holds well under 300 KB at its caps; anything bigger (or not a plain file) is not Trail's. */
const MAX_FILE = 512 * 1024;
const READ_CAP = 5000;
const WINDOW_DAYS = 45;
const SH = /^[0-9a-f]{12}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const REPO = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/;
const PROGRAM = /^[A-Za-z0-9._+-]{1,40}$/;
const DELTA_NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,63}$|^--?[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const LESSON_ID = /^(?:l|ls)-[0-9a-f]{6,16}$/;
const READ_VALUE = /^\d{1,15}:\d{1,16}(?:\.\d+)?$/;
const KINDS: ReadonlySet<string> = new Set(['env', 'flag', 'wrapper', 'enable-step']);
const CLASSES: ReadonlySet<string> = new Set(WALL_CLASSES);

/**
 * D98: the one key a program (or a wrapper or enabling step) is kept under: its first word, lower-cased, of the
 * PROGRAM shape; '' when it has none, which drops the entry. b2 names programs with their verb (`go test`,
 * `npm install`, `colima ssh --`): writers and readers both go through here, so they always meet.
 */
export function programKey(name: string): string {
  if (typeof name !== 'string') return '';
  const first = name.trim().split(/\s+/, 1)[0]!.toLowerCase();
  return PROGRAM.test(first) ? first : '';
}

/** The entry with its program, and its wrapper and enabling-step names, as program keys (env and flag names as they are). */
function keyed<T extends { program: string; delta?: Array<{ kind: FixDeltaKind; name: string }> }>(e: T): T {
  if (!isObj(e)) return e;
  const out = { ...e, program: programKey(e.program) };
  if (Array.isArray(e.delta)) {
    out.delta = e.delta.map((x) => (isObj(x) && (x.kind === 'wrapper' || x.kind === 'enable-step') ? { ...x, name: programKey(x.name) } : x));
  }
  return out;
}

/** `<trail home>/walls.json`. */
export function wallsPath(env: NodeJS.ProcessEnv = process.env): string {
  return trailPath(env, 'walls.json');
}

const empty = (): WallsFile => ({ v: 1, read: {}, classes: {} });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const epochOk = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 1e6;
/** A YYYY-MM-DD that is on the calendar (no month 13, no Feb 31). */
function dayOk(d: unknown): d is string {
  const m = typeof d === 'string' ? DAY.exec(d) : null;
  if (!m) return false;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, da));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === da;
}
/** Oldest first by day, keeping the order of equal days (newest last), then the last `cap`. */
const newestLast = <T extends { d: string }>(xs: T[], cap: number): T[] => [...xs].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)).slice(-cap);
/** The lesson ids that worked most recently, at most LESSONS_CAP. */
function capLessons(l: WallClassState['lessons']): WallClassState['lessons'] {
  const ids = Object.keys(l);
  if (ids.length <= LESSONS_CAP) return l;
  const last = (id: string) => l[id]!.worked.reduce((m, w) => (w.d > m ? w.d : m), '');
  const keep = new Set(ids.map((id, i) => ({ id, i, d: last(id) })).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i)).slice(-LESSONS_CAP).map((x) => x.id));
  return Object.fromEntries(ids.filter((id) => keep.has(id)).map((id) => [id, l[id]!]));
}

/**
 * The file's text, or null: never through a link, never a FIFO or device (O_NONBLOCK, then a plain-file check),
 * never more than MAX_FILE. A planted FIFO or a link to /dev/zero would otherwise hang or fill the hook.
 */
function readSmall(path: string): string | null {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* closed */ }
  }
}

function okSeen(s: unknown): s is Seen {
  if (!isObj(s)) return false;
  return dayOk(s.d) && typeof s.sh === 'string' && SH.test(s.sh) && epochOk(s.epoch)
    && typeof s.repo === 'string' && s.repo.length <= 200 && REPO.test(s.repo) && typeof s.program === 'string' && PROGRAM.test(s.program);
}

function okFixed(f: unknown): f is Fixed {
  if (!okSeen(f) || !Array.isArray((f as Fixed).delta)) return false;
  const delta = (f as Fixed).delta;
  return delta.length > 0 && delta.length <= 8
    && delta.every((x) => isObj(x) && KINDS.has(x.kind as string) && typeof x.name === 'string' && DELTA_NAME.test(x.name));
}

function okWorked(w: unknown): w is { sh: string; epoch: number; d: string } {
  return isObj(w) && typeof w.sh === 'string' && SH.test(w.sh) && epochOk(w.epoch) && dayOk(w.d);
}

/** Only the fields of the shape, so nothing else rides along into the file. */
const seenOf = (s: Seen): Seen => ({ d: s.d, sh: s.sh, epoch: s.epoch, repo: s.repo, program: s.program });
const fixedOf = (f: Fixed): Fixed => ({ ...seenOf(f), delta: f.delta.map((x) => ({ kind: x.kind, name: x.name })) });

function cleanClass(c: unknown): WallClassState {
  const out: WallClassState = { seen: [], fixed: [], lessons: {} };
  if (!isObj(c)) return out;
  if (Array.isArray(c.seen)) out.seen = newestLast(c.seen.filter(okSeen).map(seenOf), CAP);
  if (Array.isArray(c.fixed)) out.fixed = newestLast(c.fixed.filter(okFixed).map(fixedOf), CAP);
  if (isObj(c.lessons)) {
    for (const [id, l] of Object.entries(c.lessons)) {
      if (!LESSON_ID.test(id) || !isObj(l) || !Array.isArray(l.worked)) continue;
      out.lessons[id] = { worked: newestLast(l.worked.filter(okWorked).map((w) => ({ sh: w.sh, epoch: w.epoch, d: w.d })), WORKED_CAP) };
    }
    out.lessons = capLessons(out.lessons);
  }
  return out;
}

/** {v:1, read:{}, classes:{}} on missing or bad; entries of the wrong shape dropped. */
export function readWalls(env: NodeJS.ProcessEnv = process.env): WallsFile {
  let raw: unknown = null;
  try {
    raw = JSON.parse(readSmall(wallsPath(env)) ?? 'null');
  } catch {
    raw = null;
  }
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.read) || !isObj(raw.classes)) return empty();
  const out = empty();
  for (const [sh, v] of Object.entries(raw.read)) if (SH.test(sh) && typeof v === 'string' && READ_VALUE.test(v)) out.read[sh] = v;
  for (const [cls, c] of Object.entries(raw.classes)) if (CLASSES.has(cls)) out.classes[cls as WallClass] = cleanClass(c);
  return out;
}

const seenKey = (s: { sh: string; epoch: number; program: string }) => `${s.sh}|${s.epoch}|${s.program}`;

function classOf(w: WallsFile, cls: WallClass): WallClassState {
  return (w.classes[cls] ??= { seen: [], fixed: [], lessons: {} });
}

/** Adds `add` to `w` in memory: idempotent per (sh, epoch, cls, program); newest last; capped. */
function merge(w: WallsFile, add: Parameters<typeof noteWalls>[0]): void {
  for (const raw of add.seen ?? []) {
    const s = keyed(raw);
    if (!CLASSES.has(s?.cls) || !okSeen(s)) continue;
    const c = classOf(w, s.cls);
    if (!c.seen.some((x) => seenKey(x) === seenKey(s))) c.seen.push(seenOf(s));
    c.seen = newestLast(c.seen, CAP);
  }
  for (const raw of add.fixed ?? []) {
    const f = keyed(raw);
    if (!CLASSES.has(f?.cls) || !okFixed(f)) continue;
    const c = classOf(w, f.cls);
    if (!c.fixed.some((x) => seenKey(x) === seenKey(f))) c.fixed.push(fixedOf(f));
    c.fixed = newestLast(c.fixed, CAP);
  }
  for (const k of add.worked ?? []) {
    if (!CLASSES.has(k?.cls) || !LESSON_ID.test(k.lessonId) || !okWorked(k)) continue;
    const l = (classOf(w, k.cls).lessons[k.lessonId] ??= { worked: [] });
    if (!l.worked.some((x) => x.sh === k.sh && x.epoch === k.epoch)) l.worked.push({ sh: k.sh, epoch: k.epoch, d: k.d });
    l.worked = newestLast(l.worked, WORKED_CAP);
  }
  for (const c of Object.values(w.classes)) if (c) c.lessons = capLessons(c.lessons);
  for (const [sh, v] of Object.entries(add.read ?? {})) if (SH.test(sh) && typeof v === 'string' && READ_VALUE.test(v)) w.read[sh] = v;
  const shs = Object.keys(w.read);
  if (shs.length > READ_CAP) for (const sh of shs.slice(0, shs.length - READ_CAP)) delete w.read[sh];
  // A class left with nothing in it is not kept.
  for (const cls of Object.keys(w.classes) as WallClass[]) {
    const c = w.classes[cls]!;
    if (!c.seen.length && !c.fixed.length && !Object.keys(c.lessons).length) delete w.classes[cls];
  }
}

/** One locked rewrite (wait 200 ms, else skip and log with hookError). Idempotent per (sh, epoch, cls, program). */
export function noteWalls(add: {
  seen?: Array<{ cls: WallClass } & WallClassState['seen'][number]>;
  fixed?: Array<{ cls: WallClass } & WallClassState['fixed'][number]>;
  read?: Record<string, string>;
  worked?: Worked[];
}, env: NodeJS.ProcessEnv = process.env): void {
  const path = wallsPath(env);
  try {
    const r = withLock(path, () => {
      const w = readWalls(env);
      merge(w, add ?? {});
      writePrivateJson(path, w);
    });
    if (!r.ok) {
      const e = new Error('walls.json is locked');
      e.name = 'WallsLockTimeout';
      hookError('walls', e, env);
    }
  } catch (e) {
    hookError('walls', e, env);
  }
}

/** YYYY-MM-DD of `d` in local time. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const deltaKey = (f: Fixed) => f.delta.map((x) => `${x.kind}:${x.name}`).sort().join(',');

/**
 * Earlier epochs (not this one) where (repo, cls, program) was hit and fixed, in the 45 days up to `now` (moment 3).
 * `sameDelta`: how many of them had this epoch's delta (this epoch's repair is read from `w`; when it isn't there,
 * 0). `from`: those same-delta epochs, then this one, oldest first: what a lesson kept from this offer has worked in (R48).
 */
export function repairsSeen(w: WallsFile, repo: string, cls: WallClass, program: string, sh: string, epoch: number, now: Date = new Date()):
  { epochs: number; firstAt: string | null; sameDelta: number; from: Array<{ sh: string; epoch: number; d: string }> } {
  program = programKey(program);
  const fixed = program ? w.classes?.[cls]?.fixed ?? [] : [];
  const since = localDay(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
  const today = localDay(now);
  const mine = fixed.filter((f) => f.repo === repo && f.program === program);
  const self = mine.find((f) => f.sh === sh && f.epoch === epoch) ?? null;
  const earlier = new Map<string, Fixed>();
  for (const f of mine) {
    if ((f.sh === sh && f.epoch === epoch) || f.d < since || f.d > today) continue;
    const k = `${f.sh}|${f.epoch}`;
    if (!earlier.has(k)) earlier.set(k, f);
  }
  const list = [...earlier.values()].sort((a, b) => (a.d === b.d ? 0 : a.d < b.d ? -1 : 1));
  const same = self ? list.filter((f) => deltaKey(f) === deltaKey(self)) : [];
  return {
    epochs: list.length,
    firstAt: list[0]?.d ?? null,
    sameDelta: same.length,
    from: self ? [...same, self].map((f) => ({ sh: f.sh, epoch: f.epoch, d: f.d })) : [],
  };
}

/** Distinct local days a class was seen on this machine (init's guardrail bar, 4.5), oldest first; none after today. */
export function wallDays(w: WallsFile, cls: WallClass, now: Date = new Date()): string[] {
  const today = localDay(now);
  return [...new Set((w.classes?.[cls]?.seen ?? []).map((s) => s.d).filter((d) => d <= today))].sort();
}

/** Distinct epochs `lessonId` worked in for `cls`, none dated after today. */
export function lessonWorkedEpochs(w: WallsFile, cls: WallClass, lessonId: string, now: Date = new Date()): number {
  const today = localDay(now);
  const worked = (w.classes?.[cls]?.lessons?.[lessonId]?.worked ?? []).filter((x) => x.d <= today);
  return new Set(worked.map((x) => `${x.sh}|${x.epoch}`)).size;
}
