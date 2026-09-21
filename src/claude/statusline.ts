import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderStatusline, renderSubagent } from './format.js';
import { readStats, readSession, emptyStats, resolveContextDir, type Stats } from './state.js';
import { readWiring, computeStats } from './stats.js';

/**
 * The statusline's fast path is the hook-maintained cache (graft/.cache/stats.json).
 * When it's absent — a fresh checkout, or a plain `graft build` that doesn't write the
 * cache — fall back to reading the graph itself (wiring.json) so the bar reflects reality
 * immediately instead of showing "not built". An empty wiring.json is still a graph
 * (docs-only repos legitimately have 0 nodes); "not built" is only when the artifact
 * is missing. The graph carries no drift signal, so it reads as synced until the next
 * edit repopulates the cache. Still a pure read (no subprocess): the cache is preferred
 * because it carries live dirty/stale state.
 *
 * A workspace parent has neither artifact and is still built: its graph IS
 * `graft/workspace.json`, and the nodes live in the children. Both reads above miss
 * there, so the bar said "not built" for a workspace that `graft check`, `graft ask`
 * and the MCP server were all serving (#311). `init.ts` already knows this shape —
 * it tests `hasGraftIndex` rather than wiring.json for exactly this reason.
 */
export function resolveStats(dir: string): Stats | null {
  return resolveRepoStats(dir) ?? resolveWorkspaceStats(dir);
}

function resolveRepoStats(dir: string): Stats | null {
  const cached = readStats(dir);
  if (cached && cached.nodeCount > 0) return cached;
  const wiring = readWiring(dir);
  if (wiring) return { ...emptyStats(), ...computeStats(wiring) };
  return null;
}

/** The children named by `<dir>/graft/workspace.json`, or null when this isn't a
 * workspace parent (absent, unparseable, or foreign json — all the same thing).
 *
 * Read here rather than through `graph/workspace.js`: that module pulls in ask,
 * grep and scope fusion to answer federated queries, and this file runs on every
 * statusline render. Same reason `stats.ts` reads wiring.json directly. */
function readWorkspaceChildren(dir: string): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(join(resolveContextDir(dir), 'workspace.json'), 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.children)) return null;
    return parsed.children.map(String);
  } catch { return null; }
}

/** Sum the children a workspace parent federates. One level, because that is how
 * the index is written: `children` are immediate directories that are git repos.
 *
 * Every child resolves through {@link resolveRepoStats} — the same path it would
 * take if Claude Code were opened in it — so the parent can't disagree with its own
 * children. `syncedAt` and `lastFile` stay empty: both describe one repo's last
 * sync, and there is no honest parent-level answer to either. Null when no child is
 * built, which is the one case where "not built" is the truth. */
function resolveWorkspaceStats(dir: string): Stats | null {
  const children = readWorkspaceChildren(dir);
  if (!children) return null;
  const parts = children
    .map((child) => resolveRepoStats(join(dir, child)))
    .filter((s): s is Stats => s !== null);
  if (parts.length === 0) return null;
  const sum = (pick: (s: Stats) => number): number => parts.reduce((n, s) => n + pick(s), 0);
  return {
    ...emptyStats(),
    nodeCount: sum((s) => s.nodeCount),
    edgeCount: sum((s) => s.edgeCount),
    languages: [...new Set(parts.flatMap((s) => s.languages))].sort(),
    totalCount: sum((s) => s.totalCount),
    readyCount: sum((s) => s.readyCount),
    staleCount: sum((s) => s.staleCount),
    dirty: parts.some((s) => s.dirty),
    syncing: parts.some((s) => s.syncing),
  };
}

export function main(): void {
  let input: any = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid stdin */ }
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const session = readSession(dir, input.session_id || 'default');
  const agent = input?.agent?.name;
  if (agent) { process.stdout.write(renderSubagent(agent, session)); return; }
  const stats = resolveStats(dir);
  const raw = input?.context_window?.used_percentage;
  const ctxPct = typeof raw === 'number' ? Math.round(raw) : null;
  process.stdout.write(renderStatusline(stats, session, { ctxPct }).join('\n'));
}
