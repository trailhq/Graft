/**
 * D117 (4): the lesson learnings in a folder, through an index keyed by each
 * file's mtime, ctime, size and inode, so the wall fix (PostToolUseFailure,
 * 30 ms p95) doesn't parse every every-repo learning on each hit. At 1,000
 * files a warm read is one readdir and one lstat a file.
 *
 * The index (`~/.trail/state/lesson-index.json`) is only a cache of what the
 * files say: an entry whose key isn't the file's now is read again from the
 * file, a file that is gone is gone, a link is never followed. It is written
 * at Stop and session start only (`write`), never on PostToolUseFailure (R34),
 * which reads it and parses what changed in memory.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNote, type Note } from './notes.js';
import { everyRepoDir } from './every-repo.js';
import { repoNotesDir } from './repo-notes-dir.js';
import { readJsonSafe, trailPath, writePrivate } from '../util/private-fs.js';

/** What liveLessons and wallLessons read of a lesson learning. */
export type IndexedLesson = Pick<Note, 'id' | 'kind' | 'status' | 'replaces' | 'applies' | 'wall' | 'src' | 'date' | 'path' | 'body'>;

interface Entry { k: string; n: Omit<IndexedLesson, 'path'> | null }
interface IndexFile { v: 1; dirs: Record<string, { files: Record<string, Entry> }> }

/** A learning file over this is never read (lessons.ts's cap). */
export const LESSON_FILE_MAX = 4 * 1024;
const MAX_DIRS = 64;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

export const lessonIndexPath = (env?: NodeJS.ProcessEnv): string => trailPath(env, 'state', 'lesson-index.json');

function readIndex(env?: NodeJS.ProcessEnv): IndexFile {
  try {
    if (lstatSync(lessonIndexPath(env)).size > MAX_INDEX_BYTES) return { v: 1, dirs: {} };
  } catch {
    return { v: 1, dirs: {} };
  }
  const raw = readJsonSafe<IndexFile>(lessonIndexPath(env));
  if (!raw || raw.v !== 1 || !raw.dirs || typeof raw.dirs !== 'object' || Array.isArray(raw.dirs)) return { v: 1, dirs: {} };
  return raw;
}

const keyOf = (st: { mtimeMs: number; ctimeMs: number; size: number; ino: number }) => `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;

function parsed(path: string): Entry['n'] {
  const note = parseNote(readFileSync(path, 'utf8'), path);
  if (!note || note.kind !== 'lesson') return null;
  const { id, kind, status, replaces, applies, wall, src, date, body } = note;
  return { id, kind, status, replaces, applies, wall, src, date, body };
}

const shaped = (n: unknown): n is NonNullable<Entry['n']> => !!n && typeof n === 'object' && typeof (n as { id?: unknown }).id === 'string'
  && (n as { kind?: unknown }).kind === 'lesson' && typeof (n as { date?: unknown }).date === 'string' && typeof (n as { body?: unknown }).body === 'string';

/** The lessons in `dir`, by file name order, with the index's entries for `dir` brought up to date. */
function readDir(dir: string, idx: IndexFile): { lessons: IndexedLesson[]; changed: boolean } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    const changed = dir in idx.dirs;
    delete idx.dirs[dir];
    return { lessons: [], changed };
  }
  const had = idx.dirs[dir]?.files;
  const old: Record<string, Entry> = had && typeof had === 'object' && !Array.isArray(had) ? had : {};
  const files: Record<string, Entry> = {};
  let changed = !idx.dirs[dir];
  const lessons: IndexedLesson[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > LESSON_FILE_MAX) continue;
    const k = keyOf(st);
    const prev = Object.prototype.hasOwnProperty.call(old, name) ? old[name] : undefined;
    let entry: Entry;
    if (prev && prev.k === k && (prev.n === null || shaped(prev.n))) entry = prev;
    else {
      try {
        entry = { k, n: parsed(path) };
      } catch {
        continue;
      }
      changed = true;
    }
    files[name] = entry;
    if (entry.n) lessons.push({ ...entry.n, path });
  }
  if (Object.keys(old).some((n) => !(n in files))) changed = true;
  idx.dirs[dir] = { files };
  return { lessons, changed };
}

function save(idx: IndexFile, keep: string[], env?: NodeJS.ProcessEnv): void {
  // The folders asked about last stay; the index never grows past MAX_DIRS.
  const names = Object.keys(idx.dirs);
  if (names.length > MAX_DIRS) for (const d of names.filter((n) => !keep.includes(n)).slice(0, names.length - MAX_DIRS)) delete idx.dirs[d];
  try {
    writePrivate(lessonIndexPath(env), JSON.stringify(idx));
  } catch { /* the next Stop writes it */ }
}

/** The lesson learnings in each of `dirs`, in that order. `write`: keep what changed in the index (Stop, session start). */
export function lessonNotesIn(dirs: string[], env: NodeJS.ProcessEnv | undefined, opts: { write?: boolean } = {}): IndexedLesson[][] {
  const idx = readIndex(env);
  let changed = false;
  const out = dirs.map((d) => {
    const r = readDir(d, idx);
    changed ||= r.changed;
    return r.lessons;
  });
  if (changed && opts.write) save(idx, dirs, env);
  return out;
}

/** Stop and session start: the every-repo folder and this repo's personal one, read and kept in the index. Never throws. */
export function refreshLessonIndex(repoKey: string | null | undefined, env: NodeJS.ProcessEnv | undefined): void {
  try {
    const dirs = [everyRepoDir(env)];
    if (repoKey) {
      try { dirs.push(repoNotesDir(repoKey, env)); } catch { /* not a key */ }
    }
    lessonNotesIn(dirs, env, { write: true });
  } catch { /* the next one */ }
}
