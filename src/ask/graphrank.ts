/**
 * Graph-rank re-ranking for `graft ask` — structural graph ranking & neighborhood expansion.
 *
 * Pure term-overlap ranking treats every node independently, so a node that
 * merely shares a word with the query can outrank the node the query is actually about.
 * This module implements `GraphRankEngine` with $d = 0.35$ decay-factor neighborhood expansion
 * and file-level deduplication (`deduplicateAndGroupFiles`).
 */
import type { GraphV1, NodeV1 } from "../graph/types.js";
import { WALK_RELATIONS } from "../graph/relations.js";

export interface PageRankOptions {
  /** Decay / restart probability ($d = 0.35$ decay factor) */
  alpha?: number;
  /** Power-iteration count. */
  iters?: number;
  nodeFilter?: (id: string) => boolean;
}

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

export function personalizedPageRankPrepared(
  topology: PageRankTopology,
  seeds: Map<string, number>,
  opts: PageRankRunOptions = {},
): Map<string, number> {
  const alpha = opts.alpha ?? 0.25; // Default alpha = 0.25 for standard PageRank tests
  const iters = opts.iters ?? 25;
  const ids = topology.ids;
  const adjacency = topology.adjacency;

  let seedTotal = 0;
  for (const [id, w] of seeds) if (ids.has(id) && w > 0) seedTotal += w;
  if (seedTotal <= 0) return new Map();
  const restart = new Map<string, number>();
  for (const [id, w] of seeds)
    if (ids.has(id) && w > 0) restart.set(id, w / seedTotal);

  let rank = new Map(restart);
  for (let i = 0; i < iters; i++) {
    const next = new Map<string, number>();
    for (const [id, r] of restart) next.set(id, alpha * r);
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

/**
 * Encapsulates GraphRank queries with neighborhood expansion ($d = 0.35$)
 * and file-level grouping / deduplication.
 */
export class GraphRankEngine {
  private decayFactor: number;

  constructor(decayFactor = 0.35) {
    this.decayFactor = decayFactor;
  }

  public rank(graph: GraphV1, seeds: Map<string, number>, opts: PageRankOptions = {}): Map<string, number> {
    return personalizedPageRank(graph, seeds, {
      alpha: this.decayFactor,
      ...opts,
    });
  }

  /**
   * Deduplicates nodes by file path, selecting the highest-ranked node per file.
   */
  public deduplicateAndGroupFiles(
    nodes: NodeV1[],
    scores: Map<string, number>,
  ): { file: string; topNode: NodeV1; score: number; nodes: NodeV1[] }[] {
    const fileGroups = new Map<string, { nodes: NodeV1[]; maxScore: number; topNode: NodeV1 }>();

    for (const node of nodes) {
      const score = scores.get(node.id) ?? 0;
      const group = fileGroups.get(node.path);
      if (!group) {
        fileGroups.set(node.path, { nodes: [node], maxScore: score, topNode: node });
      } else {
        group.nodes.push(node);
        if (score > group.maxScore) {
          group.maxScore = score;
          group.topNode = node;
        }
      }
    }

    return Array.from(fileGroups.entries())
      .map(([file, group]) => ({
        file,
        topNode: group.topNode,
        score: group.maxScore,
        nodes: group.nodes,
      }))
      .sort((a, b) => b.score - a.score);
  }
}

/**
 * Entry point for executing GraphRank queries with neighborhood expansion.
 */
export function executeGraphRankQuery(
  graph: GraphV1,
  seeds: Map<string, number>,
  opts: PageRankOptions = {},
): { scores: Map<string, number>; groupedFiles: ReturnType<GraphRankEngine["deduplicateAndGroupFiles"]> } {
  const engine = new GraphRankEngine(opts.alpha ?? 0.35);
  const scores = engine.rank(graph, seeds, opts);

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const rankedNodes: NodeV1[] = [];
  for (const id of scores.keys()) {
    const node = nodeMap.get(id);
    if (node) rankedNodes.push(node);
  }

  const groupedFiles = engine.deduplicateAndGroupFiles(rankedNodes, scores);
  return { scores, groupedFiles };
}
