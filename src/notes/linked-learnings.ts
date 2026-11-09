/**
 * A linked `<trail home>/learnings` (D114 (1)). People link dotfile folders,
 * so a link there, or at a folder below it, stays allowed. But when the
 * link's real target is inside a git work tree that has a `.trail/` folder
 * (a Trail checkout), a learning written through it would sit in that repo,
 * ready to be committed for the team. Every writer of person-level learnings
 * refuses that one case, before it writes.
 *
 * b7 review: the Trail home itself is one of the folders looked at (a linked
 * `~/.trail` carries `learnings` with it); a link whose target isn't there
 * yet is judged by where it would land, so it is refused before the folder
 * is made, not only after; and a home folder that is itself a work tree is
 * no Trail checkout because of its own `.trail`, the Trail home.
 *
 * Node builtins only, no git call: a work tree is the nearest folder above
 * the target holding `.git` (a folder, or a worktree's file).
 */
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { trailHome } from './trail-home.js';
import { trailPath } from '../util/private-fs.js';

/** The nearest work tree root at or above `start` (a real path, or where one would be), or null. */
function workTreeOf(start: string): string | null {
  let at = start;
  for (let i = 0; i < 256; i++) {
    if (existsSync(join(at, '.git'))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

const isDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Where `p` really is: its real path, or for a path that isn't there yet (a link to a folder not made), the real
 * path its links lead to so far with the rest of the name after it. Bounded, so a link loop ends.
 */
function landsAt(p: string, hops = 0): string {
  try {
    return realpathSync(p);
  } catch { /* not there (yet) */ }
  if (hops > 40) return resolve(p);
  if (isLink(p)) {
    try {
      return landsAt(resolve(dirname(p), readlinkSync(p)), hops + 1);
    } catch {
      return resolve(p);
    }
  }
  const up = dirname(p);
  return up === p ? p : join(landsAt(up, hops + 1), basename(p));
}

/** The Trail home's own `.trail`, reached with no link: a home folder that is a work tree is not a checkout for it. */
function isTrailHomeItself(tree: string, env: NodeJS.ProcessEnv): boolean {
  const home = trailHome(env);
  if (isLink(home)) return false;
  try {
    return realpathSync(join(tree, '.trail')) === realpathSync(home);
  } catch {
    return false;
  }
}

/**
 * The Trail checkout a link on the way from the Trail home down to `dir` leads into, or null. Only the folders from
 * the Trail home down are looked at (the home, `learnings`, then below), and only the ones that are links.
 */
export function linkedIntoCheckout(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = trailHome(env);
  const base = trailPath(env, 'learnings');
  const rel = relative(base, resolve(dir));
  if (rel.startsWith('..')) return null;
  const parts = [home, base, ...(rel ? rel.split(sep).map((_, i, all) => join(base, ...all.slice(0, i + 1))) : [])];
  for (const at of parts) {
    if (!isLink(at)) continue;
    const tree = workTreeOf(landsAt(at));
    if (tree && isDir(join(tree, '.trail')) && !isTrailHomeItself(tree, env)) return tree;
  }
  return null;
}

/** Throws when writing a learning in `dir` would land in a Trail checkout through a link. */
export function refuseLinkedIntoCheckout(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const tree = linkedIntoCheckout(dir, env);
  if (tree) {
    throw new Error(`trail: ${trailPath(env, 'learnings')} is linked into the repo at ${tree}, which has a .trail folder; `
      + 'a learning written there could be committed for the team. Trail won\'t write your own learnings through it. Remove the link to go on.');
  }
}
