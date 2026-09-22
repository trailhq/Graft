/**
 * Writing a brain's rules into the instruction file each coding agent already
 * reads.
 *
 * Two delivery paths exist and both matter. Every `graft ask` carries the rules
 * for the symbols in its answer — that is the precise one. This is the broad
 * one: the repo-wide conventions, sitting in `AGENTS.md` / `CLAUDE.md` /
 * `.cursor/rules` where the agent picks them up whether or not it ever calls
 * graft.
 *
 * The rules land in their OWN fenced block (`BRAIN_MARKERS`), never inside the
 * instruction block: instructions are static and rewritten by `init`, rules
 * change whenever the brain does, and `uninstall` has to be able to remove
 * either one.
 */
import { join } from 'node:path';
import { HOSTS, detectHosts, type DetectProbe, type HostTarget } from '../hosts/registry.js';
import { upsertSection, BRAIN_MARKERS, type UpsertAction } from '../hosts/sections.js';
import { statSync } from 'node:fs';
import type { BrainRule } from './link.js';

/** How many rules go into an instruction file. */
const MAX_FILE_RULES = 40;

/** What a rules write did to one host's file. */
export interface BrainWrite {
  id: string;
  path: string;
  action: UpsertAction;
}

/**
 * Render the rules block for an instruction file.
 *
 * Grouped by the file the rule governs, because that is how someone reads a
 * codebase, and repo-wide rules (no symbol) come first — they apply everywhere,
 * so they should not be buried under a path heading.
 */
export function renderBrainSection(rules: BrainRule[], repoLabel: string): string {
  const capped = rules.slice(0, MAX_FILE_RULES);
  const lines = [
    '## House rules for this codebase',
    '',
    `Mined from ${repoLabel}'s own history — commit messages and pull-request`,
    'discussion — by Trail. These are decisions the team has already made, so',
    'follow them and do not re-litigate them in passing. Each is attributed to',
    'what established it.',
    '',
  ];

  const byFile = new Map<string, BrainRule[]>();
  for (const r of capped) {
    // A node id is `<path>#<QualifiedName>`; everything before the '#' is the file.
    const file = r.symbol.includes('#') ? r.symbol.slice(0, r.symbol.indexOf('#')) : '';
    const bucket = byFile.get(file);
    if (bucket) bucket.push(r);
    else byFile.set(file, [r]);
  }

  const general = byFile.get('') ?? [];
  for (const r of general) lines.push(`- ${r.rule}${r.sourceUrl ? ` (${r.sourceUrl})` : ''}`);
  if (general.length) lines.push('');

  for (const [file, group] of [...byFile].filter(([f]) => f !== '').sort()) {
    lines.push(`### ${file}`);
    for (const r of group) lines.push(`- ${r.rule}${r.sourceUrl ? ` (${r.sourceUrl})` : ''}`);
    lines.push('');
  }

  if (rules.length > capped.length) {
    lines.push(
      `_${rules.length - capped.length} more rules apply to specific symbols; graft attaches those to each \`graft ask\` answer._`,
    );
  }
  return lines.join('\n').trimEnd();
}

/** Build the probe `detectHosts` needs. Mirrors hosts/init.ts's own. */
function probeFor(repo: string, home: string): DetectProbe {
  return {
    home,
    repo,
    dirExists: (p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

/**
 * Every instruction file a brain section should go in.
 *
 * `section`-kind hosts only. An `owned`-kind host (Cursor's `.mdc`, Kiro's
 * steering file, a `SKILL.md`) is a file graft rewrites whole from a pure
 * template, so a second managed region inside one would be erased by the next
 * `init` — those agents get their rules through `graft ask` instead, which they
 * all call.
 *
 * Deduplicated by path: three hosts target `AGENTS.md`, and writing it three
 * times in one pass is just three identical upserts.
 */
export function brainSectionTargets(repo: string, home: string, ids?: string[]): HostTarget[] {
  const selected = ids?.length
    ? HOSTS.filter((h) => ids.includes(h.id))
    : detectHosts(probeFor(repo, home));
  const seen = new Set<string>();
  const out: HostTarget[] = [];
  for (const h of selected) {
    if (h.kind !== 'section') continue;
    if (seen.has(h.relPath)) continue;
    seen.add(h.relPath);
    out.push(h);
  }
  return out;
}

/**
 * Write the brain's rules into each selected host's instruction file.
 *
 * Best-effort per file: one unwritable path must not stop the rest, since a
 * partially delivered rulebook is strictly better than none.
 */
export function writeBrainSections(
  repo: string,
  home: string,
  rules: BrainRule[],
  repoLabel: string,
  ids?: string[],
): BrainWrite[] {
  if (!rules.length) return [];
  const body = renderBrainSection(rules, repoLabel);
  const out: BrainWrite[] = [];
  for (const host of brainSectionTargets(repo, home, ids)) {
    const path = join(repo, host.relPath);
    try {
      const { action } = upsertSection(path, body, BRAIN_MARKERS);
      out.push({ id: host.id, path, action });
    } catch {
      // Unwritable file (read-only checkout, a directory in the way). Skipped
      // silently here; the caller reports what it did get.
    }
  }
  return out;
}
