import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphV1 } from '../graph/types.js';
import type { Stats } from './state.js';
import { resolveContextDir } from '../util/state.js';

export function readWiring(projectDir: string): GraphV1 | null {
  return readWiringIn(resolveContextDir(projectDir));
}

/** Read `wiring.json` from an explicit graft context dir (`<repo>/graft`). */
export function readWiringIn(contextDir: string): GraphV1 | null {
  try {
    return JSON.parse(readFileSync(join(contextDir, '.graph', 'wiring.json'), 'utf8')) as GraphV1;
  } catch { return null; }
}

export function computeStats(
  w: GraphV1,
): Pick<Stats, 'nodeCount' | 'edgeCount' | 'languages' | 'totalCount' | 'readyCount'> {
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
