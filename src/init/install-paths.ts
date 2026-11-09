/**
 * D120 (2): the repo paths a `trail init` run may write in each checkout (every
 * host's repo files, so a retracted one counts too, `.trail/README.md`, the
 * `.gitignore` and `.ignore` lines the graph build adds and `.trail/.gitignore`,
 * and what it removes: the graft-named copies in a repo moving from graft, and
 * the layout before 0.23, the shims under `.claude/helpers/` and the skill in
 * `.claude/skills/`, which claude/init.ts clears away), looked at before it
 * writes and recorded after (install-record.ts). Kept out of the hook's import
 * closure.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { claudeTargetsFor, legacyClaudeTargets } from '../claude/init.js';
import { planInit } from '../hosts/plan.js';
import { cursorHookShimRelPath, HOSTS } from '../hosts/registry.js';
import { repoPlace } from '../notes/home.js';
import { recordInstall, snapInstall, type InstallSnap } from './install-record.js';

const SHIMS = ['graft', 'trail'].flatMap((b) => ['hooks', 'statusline'].map((k) => `.claude/helpers/${b}-${k}.cjs`));
/** The graph build's ignore lines under graft, and under trail the one file that keeps `.trail/cache/` and the status line out of git (#619). */
const IGNORES = ['.gitignore', '.ignore', '.trail/.gitignore'];

/** The plain files under a folder init removes whole (graft's old Claude Code skill folder), at most 50, no links followed. */
function filesUnder(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length >= 50) return out;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names.slice(0, 50)) {
    const p = join(dir, n);
    try {
      const st = lstatSync(p);
      if (st.isFile()) out.push(p);
      else if (st.isDirectory()) filesUnder(p, depth + 1, out);
    } catch { /* gone */ }
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * fix-lab5: what a `trail init` removes in a repo moving from graft's names: graft's Claude Code shims and its whole
 * `.claude/skills/graft/` folder (claude/init.ts), each owned host's graft-named copy (hosts/init.ts), and Cursor's
 * graft shim. Looked at before init runs, so a deletion is recorded like a write.
 */
function graftCopies(target: string): string[] {
  const claude = claudeTargetsFor(target, 'graft').map((w) => w.path);
  const skillDir = join(target, '.claude', 'skills', 'graft');
  return [...claude, ...filesUnder(skillDir), ...HOSTS.filter((h) => h.kind === 'owned').map((h) => join(target, h.relPath)),
    join(target, cursorHookShimRelPath('graft'))];
}

/** #619: trail's layout before 0.23, which init clears away in a repo it set up then: its repo skill folder and `.mcp.json` server. */
function oldTrailLayout(target: string): string[] {
  return [...legacyClaudeTargets(target, 'trail').map((w) => w.path), ...filesUnder(join(target, '.claude', 'skills', 'trail'))];
}

function pathsFor(target: string, checkout: string, home: string): string[] {
  const writes = planInit(target, { home }).flatMap((p) => p.writes).filter((w) => w.scope === 'repo').map((w) => w.path);
  return [...writes, ...graftCopies(target), ...oldTrailLayout(target), ...[...SHIMS, ...IGNORES].map((s) => join(target, s)), join(checkout, '.trail', 'README.md')]
    .map((p) => relative(checkout, p).split(sep).join('/'))
    .filter((r) => r && !r.startsWith('..'));
}

/** One look per checkout, before init writes anything. */
export function snapInit(targets: string[], home: string, env: NodeJS.ProcessEnv = process.env): InstallSnap[] {
  const rels = new Map<string, string[]>();
  for (const target of targets) {
    const place = repoPlace(target, env);
    if (place.git) rels.set(place.checkout, [...(rels.get(place.checkout) ?? []), ...pathsFor(target, place.checkout, home)]);
  }
  return [...rels].map(([checkout, list]) => snapInstall(checkout, list, env));
}

/** After the writes. A record that can't be written only means the probe blocks on init's files, as before. */
export function recordInit(snaps: InstallSnap[], env: NodeJS.ProcessEnv = process.env): void {
  for (const s of snaps) {
    try { recordInstall(s, env); } catch { /* the probe reads no record */ }
  }
}
