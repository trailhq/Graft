/**
 * The checkout a run ran in (D93), for everything that compiles the run as a
 * skill: the prompt hook's asked save, the offer moment, both halves of the
 * save gate and the held copy. Compile reads paths relative to that root, so
 * every one of them must use the same one, taken from the run itself (its
 * sheet, or the receipt the PreToolUse half wrote), never from the folder a
 * command happens to run in: a session that starts in a folder above the
 * repo and cds into it runs `trail skills add` up there.
 *
 * A folder is used only when it still exists and is the top of a git
 * checkout whose repo key is the run's. Otherwise ''.
 */
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RunSheet } from '../trace/types.js';
import { repoPlace } from '../notes/home.js';

/** `dir` is an existing checkout's top, with the key `repoKey`. */
function holds(dir: unknown, repoKey: string, env: NodeJS.ProcessEnv): dir is string {
  if (typeof dir !== 'string' || !dir || !isAbsolute(dir) || !repoKey) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const place = repoPlace(dir, env);
  return place.git && place.key === repoKey && resolve(place.checkout) === resolve(dir);
}

/** The run's own checkout when it holds, else the first hint that does (an older sheet has none); '' when none. */
export function runCheckout(sheet: Pick<RunSheet, 'repoKey' | 'checkout'>, env: NodeJS.ProcessEnv = process.env, ...hints: Array<string | null | undefined>): string {
  for (const dir of [sheet.checkout, ...hints]) if (holds(dir, sheet.repoKey, env)) return resolve(dir);
  return '';
}
