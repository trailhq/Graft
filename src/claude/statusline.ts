import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { renderStatusline, renderSubagent, type WorkspaceStatus } from './format.js';
import { readStats, readStatsIn, readSession, emptyStats, resolveContextDir, type Stats } from './state.js';
import { readWiring, readWiringIn, computeStats } from './stats.js';

/**
 * The statusline's fast path is the hook-maintained cache (graft/.cache/stats.json).
 * When it's absent — a fresh checkout, or a plain `graft build` that doesn't write the
 * cache — fall back to reading the graph itself (wiring.json) so the bar reflects reality
 * immediately instead of showing "not built". An empty wiring.json is still a graph
 * (docs-only repos legitimately have 0 nodes); "not built" is only when the artifact
 * is missing. The graph carries no drift signal, so it reads as synced until the next
 * edit repopulates the cache. Still a pure read (no subprocess): the cache is preferred
 * because it carries live dirty/stale state.
 */
export function resolveStats(dir: string): Stats | null {
  const cached = readStats(dir);
  if (cached && cached.nodeCount > 0) return cached;
  const wiring = readWiring(dir);
  if (wiring) return { ...emptyStats(), ...computeStats(wiring) };
  return null;
}

/** The same cache-then-graph read as `resolveStats`, for one workspace child's
 * `<child>/graft` context dir. */
function resolveChildStats(contextDir: string): Stats | null {
  const cached = readStatsIn(join(contextDir, '.cache'));
  if (cached && cached.nodeCount > 0) return cached;
  const wiring = readWiringIn(contextDir);
  if (wiring) return { ...emptyStats(), ...computeStats(wiring) };
  return null;
}

/**
 * The children listed in `<dir>/graft/workspace.json`, or null when `dir` is not a
 * workspace root. Mirrors `readWorkspace` in `graph/workspace.ts`, which the
 * statusline doesn't import: that module pulls in the whole ask/grep stack and
 * roughly triples the statusline's start-up time. Entries that aren't a plain
 * child dir name are dropped, so the index can't point the reader outside `dir`.
 */
function readWorkspaceChildren(dir: string): string[] | null {
  let parsed: { version?: unknown; children?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(resolveContextDir(dir), 'workspace.json'), 'utf8'));
  } catch { return null; }
  if (parsed?.version !== 1 || !Array.isArray(parsed.children)) return null;
  return parsed.children
    .map(String)
    .filter((c) => c !== '' && c !== '.' && c !== '..' && basename(c) === c);
}

/**
 * At a workspace root, nodes and edges live in each child's own `graft/`, never at
 * the root (#455). Sum the built children so the bar reports the workspace rather
 * than "not built". Returns null when `dir` is not a workspace or no child is built
 * yet, in which case "not built" is the truth.
 */
export function resolveWorkspaceStats(dir: string): { stats: Stats; workspace: WorkspaceStatus } | null {
  const children = readWorkspaceChildren(dir);
  if (!children || children.length === 0) return null;
  const stats = emptyStats();
  const languages = new Set<string>();
  let built = 0;
  for (const child of children) {
    // Child graphs always live at `<child>/graft`, as in `loadWorkspaceGraphs`.
    const s = resolveChildStats(join(dir, child, 'graft'));
    if (!s) continue;
    built++;
    stats.nodeCount += s.nodeCount;
    stats.edgeCount += s.edgeCount;
    stats.totalCount += s.totalCount;
    stats.readyCount += s.readyCount;
    stats.staleCount += s.staleCount;
    stats.dirty ||= s.dirty;
    stats.syncing ||= s.syncing;
    for (const l of s.languages ?? []) languages.add(l);
    if (s.syncedAt && (!stats.syncedAt || s.syncedAt > stats.syncedAt)) stats.syncedAt = s.syncedAt;
  }
  if (built === 0) return null;
  stats.languages = [...languages].sort();
  return { stats, workspace: { built, total: children.length } };
}

export function main(): void {
  let input: any = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid stdin */ }
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const session = readSession(dir, input.session_id || 'default');
  const agent = input?.agent?.name;
  if (agent) { process.stdout.write(renderSubagent(agent, session)); return; }
  let stats = resolveStats(dir);
  let workspace: WorkspaceStatus | undefined;
  if (!stats) {
    const ws = resolveWorkspaceStats(dir);
    if (ws) ({ stats, workspace } = ws);
  }
  const raw = input?.context_window?.used_percentage;
  const ctxPct = typeof raw === 'number' ? Math.round(raw) : null;
  process.stdout.write(renderStatusline(stats, session, { ctxPct, workspace }).join('\n'));
}
