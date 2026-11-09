/**
 * Trail's own folders under its home (`skills`, `state`, `ledger`, `held`,
 * `skills/.retired`) are folders Trail made. A link in place of one was
 * planted (an agent with a shell can do it in one command), and writing
 * through it would put the person's skills, counts or ledger wherever it
 * points, a repo included, and chmod that folder 0700. So a write refuses a
 * folder that is a link. The Trail home itself may be a link (a person's
 * dotfiles); only the folders inside it are checked.
 *
 * Node builtins only.
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { trailHome } from '../notes/trail-home.js';

/** The folders Trail keeps its skill files in. */
export const OWN_FOLDERS = ['skills', 'state', 'ledger', 'held', join('skills', '.retired')] as const;

/** True when `dir` is a symbolic link (a missing folder is not one). */
export function isLinked(dir: string): boolean {
  try {
    return lstatSync(dir).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The first of Trail's own folders that is a link, relative to the home, or null. */
export function linkedOwnFolder(env?: NodeJS.ProcessEnv): string | null {
  const home = trailHome(env ?? process.env);
  return OWN_FOLDERS.find((f) => isLinked(join(home, f))) ?? null;
}

/** Throws when `dir` is a link: the message names it, so the person can see what was planted. */
export function ownFolder(dir: string): void {
  if (isLinked(dir)) throw new Error(`trail: ${dir} is a link, not Trail's own folder; Trail won't write through it. Remove the link to go on.`);
}
