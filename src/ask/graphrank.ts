/**
 * Graph-rank re-ranking for `graft ask` — the fix for lexical keyword-collision.
 *
 * Pure term-overlap ranking treats every node independently, so a node that
 * merely shares a word with the query (a window "overlay" widget) can outrank
 * the node the query is actually about (a scroll-"overlay" config) purely on
 * word count. The graph knows better: the right node is the one wired into the
 * cluster of code the query touches.
 *
 * This module runs personalized PageRank (random-walk-with-restart) over the
 * wiring graph, seeded by the lexical scores. Mass concentrates on nodes that
 * are edge-connected to the matched set; a lexically-matched but structurally
 * isolated node keeps only its own restart mass and sinks. "Lexical proposes,
 * graph disposes." Deterministic, $0, no embeddings — a lexical-seed →
 * graph-rank pipeline, the established alternative to vector search for code.
 */
import type { GraphV1 } from "../graph/types.js";
import { WALK_RELATIONS } from "../graph/relations.js";

export interface PageRankOptions {
  /** Restart probability — the mass that teleports back to the seed set each
   * step. Higher keeps the walk closer to the seeds. 0.25 is the standard value. */
  alpha?: number;
  /** Power-iteration count. 25 is plenty to converge on graphs this size. */
  iters?: number;
  /** Restrict the walk to a subgraph: when present, an edge counts only when
   * BOTH endpoints pass, and only passing ids can hold rank mass or seed
   * weight. Seeds outside the filter are silently ignored (same as a seed
   * naming a non-existent node). Omit for the full-graph walk (unchanged
   * behavior). */
  nodeFilter?: (id: string) => boolean;
}

/** Immutable graph topology consumed by the PageRank iteration. Preparing it
 * separately lets a multi-scope query partition one large graph once, instead
 * of rescanning every node and edge for every scope. */
export interface PageRankTopology {
  ids: ReadonlySet<string>;
  adjacency: ReadonlyMap<string, readonly string[]>;
}

export type PageRankRunOptions = Pick<PageRankOptions, "alpha" | "iters">;

interface MutablePageRankTopology {
  ids: Set<string>;
  adjacency: Map<string, string[]>;
}

const emptyTopology = (): PageRankTopology => ({
  ids: new Set<string>(),
  adjacency: new Map<string, readonly string[]>(),
});

const link = (adjacency: Map<string, string[]>, source: string, target: string): void => {
  const neighbours = adjacency.get(source);
  if (neighbours) neighbours.push(target);
  else adjacency.set(source, [target]);
};

/** Build independent PageRank topologies in one node pass and one edge pass.
 * Edges crossing partitions are excluded, exactly like applying a nodeFilter
 * for each partition independently. Returning `undefined` omits a node. */
export function preparePageRankPartitions(
  graph: GraphV1,
  partitionOfId: (id: string) => string | undefined,
): Map<string, PageRankTopology> {
  const partitionById = new Map<string, string>();
  const mutable = new Map<string, MutablePageRankTopology>();

  for (const node of graph.nodes) {
    const partition = partitionOfId(node.id);
    if (partition === undefined) continue;
    partitionById.set(node.id, partition);
    const topology = mutable.get(partition);
    if (topology) topology.ids.add(node.id);
    else mutable.set(partition, { ids: new Set([node.id]), adjacency: new Map() });
  }

  for (const edge of graph.edges) {
    if (!WALK_RELATIONS.has(edge.relation)) continue;
    const partition = partitionById.get(edge.source);
    if (partition === undefined || partitionById.get(edge.target) !== partition) continue;
    const topology = mutable.get(partition)!;
    link(topology.adjacency, edge.source, edge.target);
    link(topology.adjacency, edge.target, edge.source);
  }

  return new Map(mutable);
}

/** Prepare one optionally filtered topology. Kept public for callers/tests that
 * reuse the same graph across multiple seed sets. */
export function preparePageRankTopology(
  graph: GraphV1,
  nodeFilter?: (id: string) => boolean,
): PageRankTopology {
  const ids = new Set(
    graph.nodes.map((node) => node.id).filter((id) => !nodeFilter || nodeFilter(id)),
  );
  if (ids.size === 0) return emptyTopology();

  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!WALK_RELATIONS.has(edge.relation)) continue;
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    link(adjacency, edge.source, edge.target);
    link(adjacency, edge.target, edge.source);
  }
  return { ids, adjacency };
}

/**
 * Personalized PageRank over the wiring graph.
 *
 * `seeds` maps node id → restart weight (a node's lexical score; only positive
 * weights matter). The graph is treated as UNDIRECTED — for "understand this
 * area" a callee is as relevant as a caller. Returns a score per node
 * normalized so the top node is 1; nodes untouched by the walk are absent.
 *
 * Edges whose endpoints aren't both real nodes (e.g. an unresolved import
 * module string) are ignored, so only genuine symbol-to-symbol wiring counts.
 */
export function personalizedPageRank(
  graph: GraphV1,
  seeds: Map<string, number>,
  opts: PageRankOptions = {},
): Map<string, number> {
  return personalizedPageRankPrepared(
    preparePageRankTopology(graph, opts.nodeFilter),
    seeds,
    opts,
  );
}

/** Run PageRank on an already prepared topology. This is numerically identical
 * to {@link personalizedPageRank}; it only removes repeated topology scans. */
export function personalizedPageRankPrepared(
  topology: PageRankTopology,
  seeds: Map<string, number>,
  opts: PageRankRunOptions = {},
): Map<string, number> {
  const alpha = opts.alpha ?? 0.25;
  const iters = opts.iters ?? 25;
  const ids = topology.ids;
  const adjacency = topology.adjacency;

  // Restart distribution: seed weights, restricted to real nodes, normalized.
  let seedTotal = 0;
  for (const [id, w] of seeds) if (ids.has(id) && w > 0) seedTotal += w;
  if (seedTotal <= 0) return new Map();
  const restart = new Map<string, number>();
  for (const [id, w] of seeds)
    if (ids.has(id) && w > 0) restart.set(id, w / seedTotal);

  // Power iteration from the restart distribution.
  let rank = new Map(restart);
  for (let i = 0; i < iters; i++) {
    const next = new Map<string, number>();
    // Teleport: every step, alpha of the mass returns to the seed set.
    for (const [id, r] of restart) next.set(id, alpha * r);
    // Dangling mass (nodes with no walk edges) is pooled and returned to the
    // seed set ONCE per iteration — same math as redistributing per node, but
    // O(nodes + seeds) instead of O(dangling × seeds).
    let dangling = 0;
    for (const [id, mass] of rank) {
      const nbrs = adjacency.get(id);
      if (!nbrs || nbrs.length === 0) {
        dangling += mass;
        continue;
      }
      const share = ((1 - alpha) * mass) / nbrs.length;
      for (const nb of nbrs) next.set(nb, (next.get(nb) ?? 0) + share);
    }
    if (dangling > 0) {
      const dm = (1 - alpha) * dangling;
      for (const [sid, r] of restart) next.set(sid, (next.get(sid) ?? 0) + dm * r);
    }
    rank = next;
  }

  let max = 0;
  for (const v of rank.values()) if (v > max) max = v;
  if (max <= 0) return new Map();
  const out = new Map<string, number>();
  for (const [id, v] of rank) out.set(id, v / max);
  return out;
}
