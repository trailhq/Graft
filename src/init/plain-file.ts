/**
 * How init opens a file it did not write (b5 review): transcripts, how-to
 * files, and the pointers in its own record, which an agent can edit.
 *
 * - `openPlain` never waits on a FIFO or a device (O_NONBLOCK, then a
 *   plain-file check on the open descriptor, so a file swapped after a stat
 *   is still caught) and, unless asked, never follows a link.
 * - `claudeTranscript` says whether a path is a transcript where Claude Code
 *   keeps them, `~/.claude/projects/<folder>/<name>.jsonl` (HOME from env, as
 *   discovery reads it), reached with no link on the way: a file the agent
 *   wrote anywhere else, or linked into that folder, is not one.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** A read-only descriptor of a plain file, or a throw. `follow`: a link to a plain file is allowed. */
export function openPlain(path: string, opts: { follow?: boolean } = {}): number {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (opts.follow ? 0 : constants.O_NOFOLLOW ?? 0);
  // Windows has no O_NOFOLLOW, and open follows a link there: refuse one seen before the open.
  if (!opts.follow && constants.O_NOFOLLOW === undefined && lstatSync(path).isSymbolicLink()) throw new Error('a link');
  const fd = openSync(path, flags);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a plain file');
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** A plain file's text (no link, no FIFO) of at most `max` bytes; null otherwise. Never throws. */
export function readPlain(path: string, max: number): string | null {
  let fd = -1;
  try {
    fd = openPlain(path);
    const size = fstatSync(fd).size;
    if (size > max) return null;
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** Claude Code's projects folder for `env`, real path; null when there is none. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return realpathSync(join(env.HOME || homedir(), '.claude', 'projects'));
  } catch {
    return null;
  }
}

/** `path` is `<projects>/<folder>/<name>.jsonl`, a plain file, with no link in the folder or the file itself. */
export function claudeTranscript(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (typeof path !== 'string' || !path.endsWith('.jsonl')) return false;
    const root = claudeProjectsDir(env);
    if (!root) return false;
    // Neither the file nor its folder is a link, and the folder is one of the projects folder's own.
    if (!lstatSync(path).isFile() || !lstatSync(dirname(path)).isDirectory()) return false;
    const folder = realpathSync(dirname(path));
    return dirname(folder) === root && lstatSync(join(root, basename(folder))).isDirectory();
  } catch {
    return false;
  }
}
