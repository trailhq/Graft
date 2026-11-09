/**
 * D120 (2), replacing D116 item 4's pattern: the clean-tree ready probe leaves
 * out exactly the paths `trail init` recorded writing in this checkout (its
 * install record, src/init/install-record.ts), and only while each still holds
 * what init wrote. So a repo whose wiring isn't committed yet doesn't open every
 * run block with "Uncommitted changes here", and any later edit to one of those
 * files, the person's own settings changes included, blocks again. Anything
 * init never wrote blocks, in `.trail/` too. No record: nothing is left out.
 * Read only: `git status --porcelain` output, one more `git status` per
 * untracked folder (to list its files the way git sees them), the record, and
 * the hashes of the files it names.
 */
import { initLeftIt, readInstallRecord } from '../init/install-record.js';

type Git = (args: string[], cwd: string, timeoutMs: number) => { code: number | null; out: string; timedOut: boolean };

/** The paths of `git status --porcelain` lines (both sides of a rename, quotes left on: such a path is never init's). */
function statusPaths(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    paths.push(...line.slice(3).split(' -> '));
  }
  return paths;
}

/** Whether every change `git status --porcelain` printed is a path init wrote here and nobody changed since. */
export function onlyTrailChanges(out: string, checkout: string, git: Git, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = statusPaths(out);
  if (!paths.length) return false;
  const files = readInstallRecord(checkout, env);
  if (!files) return false;
  for (const p of paths) {
    if (!p.endsWith('/')) {
      if (!initLeftIt(files, checkout, p)) return false;
      continue;
    }
    // An untracked folder is shown whole: list its files as git sees them (ignored ones left out).
    const inside = git(['status', '--porcelain', '--untracked-files=all', '--', p], checkout, timeoutMs);
    if (inside.timedOut || inside.code !== 0) return false;
    const rels = statusPaths(inside.out);
    if (!rels.length || rels.length > 64 || rels.some((r) => !initLeftIt(files, checkout, r))) return false;
  }
  return true;
}
