/**
 * The file side of kept versions (versions.ts): plain reads that never
 * follow a link or open a FIFO, synced writes, folders kept whole by temp
 * folder and rename, pruning, lesson files by id and kind, and swapping a
 * skill's scripts/ with a way back. Nothing here decides whether to write.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { CompiledSkill, SkillRef } from './types.js';
import { MAX_SKILL_BYTES } from './store-fs.js';
import { localDate } from './settings.js';
import { matter } from '../util/front-matter.js';
import { isGuardrailLesson, type Lesson } from './lessons.js';

const HAND_KEPT = 3;
export const V_DIR = /^v([1-9]\d{0,5})$/;

export function versionsDir(ref: SkillRef): string {
  return join(ref.dir, '.versions');
}

export const lst = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};


/** The text of a regular file of at most 64 KB, never through a link; null otherwise (a FIFO is never opened). */
export function regularText(path: string): string | null {
  const s = lst(path);
  if (!s?.isFile() || s.size > MAX_SKILL_BYTES) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** A new file, written and synced (O_EXCL: never over something there). */
export function writeSynced(path: string, data: string, mode = 0o600): void {
  const fd = openSync(path, 'wx', mode);
  try {
    const buf = Buffer.from(data, 'utf8');
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* not every platform syncs a folder */ }
}

/** A folder of ours, made 0700; a link or a file in its place refuses (throws). */
export function ownDir(dir: string): void {
  const s = lst(dir);
  if (s && !s.isDirectory()) throw new LinkError(dir);
  if (!s) mkdirSync(dir, { mode: 0o700 });
}
export class LinkError extends Error {}

/** The plain files of `from` (scripts/, lessons/) copied into a new folder `to`; links and folders inside are left out. */
export function copyFlat(from: string, to: string, mode: number, only?: (name: string) => boolean): number {
  if (!lst(from)?.isDirectory()) return 0;
  let n = 0;
  for (const name of readdirSync(from)) {
    if (name.startsWith('.') || (only && !only(name))) continue;
    const s = lst(join(from, name));
    if (!s?.isFile() || s.size > MAX_SKILL_BYTES) continue;
    if (!n) mkdirSync(to, { mode: 0o700 });
    writeSynced(join(to, name), readFileSync(join(from, name), 'utf8'), mode);
    n++;
  }
  return n;
}

export const tmpName = (dir: string, tag: string) => join(dir, `.${tag}.tmp-${randomBytes(4).toString('hex')}`);

/**
 * `.versions/<name>/` holding `text` as SKILL.md (and `scripts` copied when given): written in a temp folder, synced,
 * renamed into place. A folder already there with the same SKILL.md is reused; with other bytes, 'changed'.
 */
export function keepFolder(ref: SkillRef, name: string, text: string, scripts: string | null): 'kept' | 'same' | 'changed' {
  const vdir = versionsDir(ref);
  ownDir(vdir);
  const at = join(vdir, name);
  if (lst(at)) return regularText(join(at, 'SKILL.md')) === text && lst(at)!.isDirectory() ? 'same' : 'changed';
  const tmp = tmpName(vdir, name);
  mkdirSync(tmp, { mode: 0o700 });
  try {
    writeSynced(join(tmp, 'SKILL.md'), text);
    if (scripts) copyFlat(scripts, join(tmp, 'scripts'), 0o700);
    syncDir(tmp);
    renameSync(tmp, at);
    syncDir(vdir);
    return 'kept';
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** The person's edited file kept as `hand-<date>` (`-2`, `-3` the same day; the same bytes reuse it), the last 3 kept. */
export function keepHand(ref: SkillRef, text: string, now: Date): string {
  const base = `hand-${localDate(now)}`;
  for (let k = 1; k < 100; k++) {
    const name = k === 1 ? base : `${base}-${k}`;
    const r = keepFolder(ref, name, text, null);
    if (r !== 'changed') {
      prune(ref, /^hand-\d{4}-\d{2}-\d{2}(?:-\d+)?$/, HAND_KEPT, name);
      return name;
    }
  }
  throw new Error('trail: too many kept copies of this skill today');
}

/** Removes the oldest folders matching `re` past `keep` (by version number, else by name), never `spare`. */
export function prune(ref: SkillRef, re: RegExp, keep: number, spare?: string): void {
  let names: string[];
  try {
    names = readdirSync(versionsDir(ref)).filter((n) => re.test(n) && n !== spare && lst(join(versionsDir(ref), n))?.isDirectory());
  } catch {
    return;
  }
  const key = (n: string) => V_DIR.exec(n)?.[1] ?? n;
  names.sort((a, b) => key(a).localeCompare(key(b), 'en', { numeric: true }));
  const extra = names.length + (spare ? 1 : 0) - keep;
  for (const n of names.slice(0, Math.max(0, extra))) rmSync(join(versionsDir(ref), n), { recursive: true, force: true });
}


/* ------------------------------------------------------------- lesson files */

export interface LessonFile { name: string; id: string; guardrail: boolean }

/** The top-level lesson files of a skill folder, with the id and kind readLessons gives them. */
export function lessonFiles(dir: string): LessonFile[] {
  let names: string[];
  try {
    if (!lst(join(dir, 'lessons'))?.isDirectory()) return [];
    names = readdirSync(join(dir, 'lessons')).filter((n) => n.endsWith('.md') && !n.startsWith('.'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const text = regularText(join(dir, 'lessons', name));
    if (text === null) return [];
    const fm = matter(text, { scalars: ['id', 'kind', 'skill', 'src', 'at', 'wall'] });
    if (fm.refused) return [];
    const d = fm.data as Record<string, unknown>;
    const id = typeof d.id === 'string' ? d.id : '';
    const lesson = { text: String(fm.content ?? ''), kind: d.kind === 'guardrail' ? 'guardrail' : 'lesson' } as Lesson;
    return [{ name, id, guardrail: isGuardrailLesson(lesson) }];
  });
}

/** Moves lesson files into `to` (made 0700); a move that fails leaves the lesson riding the block, which is harmless. */
export function moveLessons(dir: string, files: LessonFile[], to: string): void {
  if (!files.length) return;
  try {
    ownDir(to);
  } catch {
    return;
  }
  for (const f of files) {
    try { renameSync(join(dir, 'lessons', f.name), join(to, f.name)); } catch { /* stays where it was */ }
  }
}

export interface Swap { undo: () => void; done: () => void }

/** scripts/ replaced by the files in `from` (a folder) or `helpers`; `undo` puts the old ones back, `done` drops them. */
export function swapScripts(ref: SkillRef, src: { from?: string; helpers?: CompiledSkill['helpers'] }): Swap {
  const scripts = join(ref.dir, 'scripts');
  const s = lst(scripts);
  if (s && !s.isDirectory()) throw new LinkError(scripts);
  const tmp = tmpName(ref.dir, 'scripts');
  mkdirSync(tmp, { mode: 0o700 });
  try {
    if (src.from) copyFlat(src.from, join(tmp, 'new'), 0o700);
    else {
      mkdirSync(join(tmp, 'new'), { mode: 0o700 });
      for (const h of src.helpers ?? []) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(h.file)) throw new Error('trail: a helper script needs a plain file name');
        writeSynced(join(tmp, 'new', h.file), h.content, 0o700);
      }
    }
    if (!lst(join(tmp, 'new'))) mkdirSync(join(tmp, 'new'), { mode: 0o700 });
    if (s) renameSync(scripts, join(tmp, 'old'));
    renameSync(join(tmp, 'new'), scripts);
  } catch (e) {
    if (!lst(scripts) && lst(join(tmp, 'old'))) renameSync(join(tmp, 'old'), scripts);
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return {
    undo: () => {
      try {
        if (lst(join(tmp, 'old'))) {
          rmSync(scripts, { recursive: true, force: true });
          renameSync(join(tmp, 'old'), scripts);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    done: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
