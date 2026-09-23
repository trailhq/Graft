/**
 * PR 2 Unit Tests: Structural Graph Ranking & Deduplication (`graphrank-engine.test.ts`)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphRankEngine, executeGraphRankQuery } from "../src/ask/graphrank.js";
import type { GraphV1, NodeV1, EdgeV1 } from "../src/graph/types.js";

function node(id: string, path: string): NodeV1 {
  return {
    id,
    name: id,
    kind: "function",
    path,
    span: "L1-L1",
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: id,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function edge(source: string, target: string): EdgeV1 {
  return { source, target, relation: "calls", confidence: "extracted" };
}

test("GraphRankEngine: applies alpha decay (0.35) and groups files correctly", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 3, edgeCount: 2, languages: ["ts"] },
    nodes: [
      node("fn1", "src/fileA.ts"),
      node("fn2", "src/fileA.ts"),
      node("fn3", "src/fileB.ts"),
    ],
    edges: [edge("fn1", "fn2"), edge("fn2", "fn3")],
  };

  const engine = new GraphRankEngine(0.35);
  const scores = engine.rank(g, new Map([["fn1", 1.0]]));
  const grouped = engine.deduplicateAndGroupFiles(g.nodes, scores);

  assert.ok(grouped.length > 0);
  assert.equal(grouped[0].file, "src/fileA.ts");
});

test("executeGraphRankQuery: returns scores and file groupings cleanly", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 2, edgeCount: 1, languages: ["ts"] },
    nodes: [node("a", "src/a.ts"), node("b", "src/b.ts")],
    edges: [edge("a", "b")],
  };

  const res = executeGraphRankQuery(g, new Map([["a", 1.0]]));
  assert.ok(res.scores.has("a"));
  assert.ok(res.groupedFiles.length > 0);
});
