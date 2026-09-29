import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphV1 } from '../graph/types.js';
import type { Stats } from './state.js';
import { readJson, resolveContextDir } from '../util/state.js';

export function readWiring(projectDir: string): GraphV1 | null {
  try {
    return JSON.parse(readFileSync(join(resolveContextDir(projectDir), '.graph', 'wiring.json'), 'utf8')) as GraphV1;
  } catch { return null; }
}

/** The part of {@link Stats} that comes from a graph rather than from the hooks. */
export type GraphStats = Pick<Stats, 'nodeCount' | 'edgeCount' | 'languages' | 'totalCount' | 'readyCount'>;

export function computeStats(w: GraphV1): GraphStats {
  const nodes = w.nodes ?? [];
  const edges = w.edges ?? [];
  const readyCount = nodes.filter((n) => n.summary_state === 'ready').length;
  return {
    nodeCount: w.meta?.nodeCount ?? nodes.length,
    edgeCount: w.meta?.edgeCount ?? edges.length,
    languages: w.meta?.languages ?? [],
    totalCount: nodes.length,
    readyCount,
  };
}

/**
 * A workspace parent holds no graph of its own: its `graft/` carries only
 * `workspace.json`, and the nodes live in each child's `<child>/graft/`. Read
 * at the parent, `readWiring` is null — so the statusline said "not built" and
 * the Stop-hook sync left `dirty` set forever, while every child had built fine
 * and every federated query worked (#433). The parent's numbers are the
 * children's, summed: the same graphs `ask`/`grep`/`callers` federate over.
 *
 * Deliberately not `loadWorkspaceGraphs`: the statusline is a pure read on the
 * render path, and that module pulls the whole `ask` engine in with it. The
 * child path mirrors `contextDirFor(join(root, child))` with no override —
 * children never inherit the parent's `--dir`, exactly as in the federated
 * commands. Null when `projectDir` is not a workspace parent, or when no listed
 * child has a graph yet, which is the one case that really is "not built".
 */
export function computeWorkspaceStats(projectDir: string): GraphStats | null {
  const ws = readJson<{ version: number; children: string[] }>(join(resolveContextDir(projectDir), 'workspace.json'));
  if (!ws || !Array.isArray(ws.children) || ws.children.length === 0) return null;
  const parts: GraphStats[] = [];
  for (const child of ws.children) {
    try {
      const raw = readFileSync(join(projectDir, child, 'graft', '.graph', 'wiring.json'), 'utf8');
      parts.push(computeStats(JSON.parse(raw) as GraphV1));
    } catch { /* listed but not built yet — coverageNote's job, not the bar's */ }
  }
  if (parts.length === 0) return null;
  const sum = (k: 'nodeCount' | 'edgeCount' | 'totalCount' | 'readyCount') => parts.reduce((n, p) => n + p[k], 0);
  return {
    nodeCount: sum('nodeCount'),
    edgeCount: sum('edgeCount'),
    languages: [...new Set(parts.flatMap((p) => p.languages))].sort(),
    totalCount: sum('totalCount'),
    readyCount: sum('readyCount'),
  };
}
