/**
 * D117 (3), J16: is this a repo Trail knows? It has a `.trail/` folder (trail
 * init made it, or the team committed one), or its key is in
 * `~/.trail/repos/index.json` (a root commit's key, or an alias either side).
 * Outside one, the global hooks keep no pool and make no offers there; walls
 * and guardrails still apply everywhere.
 *
 * Reads only: one stat and one small JSON file, no git, no process.
 */
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { trailHome } from '../notes/trail-home.js';
import { readJsonSafe, trailPath } from '../util/private-fs.js';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `<checkout>/.trail` is a folder and not the Trail home itself (a home folder that is a work tree). */
function hasTrailFolder(checkout: string, env: NodeJS.ProcessEnv): boolean {
  const dot = join(checkout, '.trail');
  if (!isDir(dot)) return false;
  try {
    return realpathSync(dot) !== realpathSync(trailHome(env));
  } catch {
    return true;
  }
}

function inIndex(key: string, env: NodeJS.ProcessEnv): boolean {
  const raw = readJsonSafe<{ aliases?: unknown; roots?: unknown }>(trailPath(env, 'repos', 'index.json'));
  if (!raw || typeof raw !== 'object') return false;
  const map = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const aliases = map(raw.aliases);
  if (Object.prototype.hasOwnProperty.call(aliases, key) || Object.values(aliases).includes(key)) return true;
  return Object.values(map(raw.roots)).includes(key);
}

/** Never throws: a read that fails knows nothing. */
export function repoKnown(key: string | null | undefined, checkout: string | null | undefined, env: NodeJS.ProcessEnv): boolean {
  try {
    if (checkout && hasTrailFolder(checkout, env)) return true;
    return typeof key === 'string' && key !== '' && inIndex(key, env);
  } catch {
    return false;
  }
}
