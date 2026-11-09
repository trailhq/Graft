/**
 * 4.17, R21: Codex runs `trail skills add`, `lesson` and `update` as the agent's command, inside its sandbox, where
 * writing `~/.trail` may be refused. Before such a save writes anything, the folders it writes (`skills`, `state`)
 * must each take a file; when one can't, the CLI changes nothing, leaves the receipt unused, and says how the person
 * can run the same command in their own terminal, where the same receipt and transcript decide (1a).
 */
import { closeSync, constants, openSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { trailHome } from '../notes/trail-home.js';
import { flatLine } from '../notes/flatten.js';

export const sandboxLine = (command: string): string =>
  `trail · couldn't write ~/.trail from Codex's sandbox. The person can run the same command in their own terminal within 30 minutes: ${flatLine(command, 200)}`;

/** The folder itself when it is there, else the nearest folder above it that is (where the save would make it). */
function nearestDir(dir: string): string | null {
  for (let d = dir, i = 0; i < 8; d = dirname(d), i++) {
    try {
      if (statSync(d).isDirectory()) return d;
    } catch { /* not there yet */ }
    if (dirname(d) === d) break;
  }
  return null;
}

/** One new file made and removed in the folder: what a sandbox allows, which a permission-bit check can't tell. */
function takesAFile(dir: string): boolean {
  const probe = join(dir, `.write-check-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    closeSync(openSync(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
  } catch {
    return false;
  }
  try {
    unlinkSync(probe);
  } catch { /* made, so the folder takes a file; a leftover probe is named for its process */ }
  return true;
}

/** Whether a save can write `~/.trail/skills` and `~/.trail/state` (or the folder they would be made in). */
export function trailWritable(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = trailHome(env);
  return [join(home, 'skills'), join(home, 'state')].every((d) => {
    const at = nearestDir(d);
    return at !== null && takesAFile(at);
  });
}

/** The line to print instead of saving, for a save Codex ran where `~/.trail` can't be written; null otherwise. */
export function codexSandboxRefusal(host: string, command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (host !== 'codex') return null;
  return trailWritable(env) ? null : sandboxLine(command);
}
