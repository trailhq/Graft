/**
 * Tests for the graph-rank re-ranking stage of `graft ask`.
 *
 * The unit tests exercise {@link personalizedPageRank} directly on hand-built
 * graphs; the integration tests drive the whole `ask` path on real fixtures
 * built by {@link buildGraph}, proving the keyword-collision fix end-to-end:
 * a lexically-matched but structurally isolated node is demoted below a
 * lexically-equal node that is wired into the query's cluster, and strongly
 * connected neighbours the query never named are rescued into the results.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { ask } from "../src/ask/ask.js";
import {
  personalizedPageRank,
  personalizedPageRankPrepared,
  preparePageRankPartitions,
} from "../src/ask/graphrank.js";
import type { GraphV1, NodeV1, EdgeV1, Relation } from "../src/graph/types.js";

// ── Unit: personalizedPageRank ───────────────────────────────────────────────

function node(id: string): NodeV1 {
  return {
    id,
    name: id,
    kind: "function",
    path: `${id}.ts`,
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
function edge(source: string, target: string, relation: Relation = "calls"): EdgeV1 {
  return { source, target, relation, confidence: "extracted" };
}
function graphOf(nodes: string[], edges: EdgeV1[]): GraphV1 {
  return {
    meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: ["ts"] },
    nodes: nodes.map(node),
    edges,
  };
}

test("PageRank: a seed wired to the cluster outranks an isolated seed", () => {
  // hub calls a, b, c; lone is a disconnected seed with equal restart weight.
  const g = graphOf(
    ["hub", "a", "b", "c", "lone"],
    [edge("hub", "a"), edge("hub", "b"), edge("hub", "c")],
  );
  const pr = personalizedPageRank(g, new Map([["hub", 1], ["lone", 1]]));
  assert.ok((pr.get("hub") ?? 0) > (pr.get("lone") ?? 0), "connected seed beats isolated seed");
  assert.equal([...pr.values()].some((v) => v === 1), true, "top node normalized to 1");
});

test("PageRank: neighbours of a seed accrue mass even with zero restart weight", () => {
  const g = graphOf(["hub", "a", "b"], [edge("hub", "a"), edge("hub", "b")]);
  const pr = personalizedPageRank(g, new Map([["hub", 1]]));
  assert.ok((pr.get("a") ?? 0) > 0, "a neighbour of the only seed gets walk mass");
  assert.ok((pr.get("b") ?? 0) > 0);
});

test("PageRank: empty or all-zero seeds yield an empty map", () => {
  const g = graphOf(["a", "b"], [edge("a", "b")]);
  assert.equal(personalizedPageRank(g, new Map()).size, 0);
  assert.equal(personalizedPageRank(g, new Map([["a", 0]])).size, 0);
});

test("PageRank: edges to non-node targets (unresolved imports) are ignored", () => {
  // "react" is an import module string, not a node id — must not crash or count.
  const g = graphOf(["a"], [edge("a", "react", "imports")]);
  const pr = personalizedPageRank(g, new Map([["a", 1]]));
  assert.equal(pr.get("a"), 1, "sole seed with no real neighbours stays at 1");
  assert.equal(pr.has("react"), false, "the module string never becomes a ranked node");
});

test("PageRank: dangling-mass pooling is algebraically identical to per-node redistribution", () => {
  // 5 nodes: a-b-c chain, d dangling with seed mass, e isolated non-seed.
  // Reference values captured from the pre-fix (per-dangling-node redistribution)
  // implementation, run once before the O(dangling×seeds) fix was applied.
  const g = graphOf(
    ["a", "b", "c", "d", "e"],
    [edge("a", "b"), edge("b", "c")],
  );
  const seeds = new Map([["a", 2], ["d", 1]]);
  const out = personalizedPageRank(g, seeds);
  // Captured from the pre-fix (per-dangling-node redistribution) implementation.
  const EXPECTED_A = 0.9577162737326514;
  const EXPECTED_B = 1;
  const EXPECTED_C = 0.37462976423958994;
  const EXPECTED_D = 0.29154325474653076;
  assert.ok(Math.abs((out.get("a") ?? 0) - EXPECTED_A) < 1e-9, `a: ${out.get("a")}`);
  assert.ok(Math.abs((out.get("b") ?? 0) - EXPECTED_B) < 1e-9, `b: ${out.get("b")}`);
  assert.ok(Math.abs((out.get("c") ?? 0) - EXPECTED_C) < 1e-9, `c: ${out.get("c")}`);
  assert.ok(Math.abs((out.get("d") ?? 0) - EXPECTED_D) < 1e-9, `d: ${out.get("d")}`);
  assert.equal(out.get("b"), 1, "top-ranked node is the hub linking both chain ends");
  assert.ok((out.get("a") ?? 0) > 0);
  assert.ok((out.get("d") ?? 0) > 0, "dangling seed keeps mass");
  assert.equal(out.get("e"), undefined, "unreached node absent");
});

test("PageRank: broad seeds on a large mostly-dangling graph complete fast", () => {
  // 20k dangling nodes (no edges) + 100 connected ones; seed EVERY node — the
  // pathological shape from real 32k-node graphs with common-word queries.
  // Pre-fix, per-dangling-node redistribution makes this O(dangling × seeds)
  // and takes minutes; pooled dangling mass makes it O(nodes + seeds).
  const ids = Array.from({ length: 20000 }, (_, i) => `n${i}`);
  const edges: EdgeV1[] = [];
  for (let i = 0; i < 100; i++) edges.push(edge(`n${i}`, `n${i + 1}`));
  const g = graphOf(ids, edges);
  const seeds = new Map(ids.map((id) => [id, 1]));
  const t0 = Date.now();
  const out = personalizedPageRank(g, seeds);
  const ms = Date.now() - t0;
  assert.ok(out.size > 0);
  assert.ok(ms < 3000, `took ${ms}ms — dangling redistribution must not be O(dangling × seeds)`);
});

test("PageRank: nodeFilter restricted to component A matches running on component A alone", () => {
  // Two disjoint components: A (hub/a/b/c) and B (x/y/z). A filter that keeps
  // only component A must produce ranks identical to a graph containing only
  // component A — the other component's nodes and edges must not leak in.
  const componentAIds = ["hub", "a", "b", "c"];
  const edgesA: EdgeV1[] = [edge("hub", "a"), edge("hub", "b"), edge("hub", "c")];
  const edgesB: EdgeV1[] = [edge("x", "y"), edge("y", "z")];
  const full = graphOf([...componentAIds, "x", "y", "z"], [...edgesA, ...edgesB]);
  const onlyA = graphOf(componentAIds, edgesA);

  const seeds = new Map([["hub", 1], ["a", 0.5]]);
  const filtered = personalizedPageRank(full, seeds, {
    nodeFilter: (id) => componentAIds.includes(id),
  });
  const reference = personalizedPageRank(onlyA, seeds);

  assert.equal(filtered.size, reference.size);
  for (const [id, v] of reference) {
    assert.ok(filtered.has(id), `filtered result missing ${id}`);
    assert.equal(filtered.get(id), v, `mismatched rank for ${id}`);
  }
  assert.equal(filtered.has("x"), false, "filtered-out component must not appear");
});

test("PageRank: no filter (opts omitted) reproduces exact pre-existing output", () => {
  // Snapshot of the dangling-mass fixture's known values (see the dedicated
  // dangling-mass test above) — proves omitting nodeFilter is byte-stable.
  const g = graphOf(["a", "b", "c", "d", "e"], [edge("a", "b"), edge("b", "c")]);
  const seeds = new Map([["a", 2], ["d", 1]]);
  const out = personalizedPageRank(g, seeds);
  const EXPECTED_A = 0.9577162737326514;
  const EXPECTED_B = 1;
  const EXPECTED_C = 0.37462976423958994;
  const EXPECTED_D = 0.29154325474653076;
  assert.ok(Math.abs((out.get("a") ?? 0) - EXPECTED_A) < 1e-9, `a: ${out.get("a")}`);
  assert.equal(out.get("b"), EXPECTED_B);
  assert.ok(Math.abs((out.get("c") ?? 0) - EXPECTED_C) < 1e-9, `c: ${out.get("c")}`);
  assert.ok(Math.abs((out.get("d") ?? 0) - EXPECTED_D) < 1e-9, `d: ${out.get("d")}`);
  assert.equal(out.get("e"), undefined);
});

test("PageRank: seeds outside the filter are ignored without error", () => {
  const g = graphOf(
    ["hub", "a", "b", "outside"],
    [edge("hub", "a"), edge("hub", "b")],
  );
  const seeds = new Map([["hub", 1], ["outside", 5]]);
  assert.doesNotThrow(() => {
    const pr = personalizedPageRank(g, seeds, { nodeFilter: (id) => id !== "outside" });
    assert.equal(pr.has("outside"), false, "filtered-out seed never appears in output");
    assert.ok((pr.get("hub") ?? 0) > 0, "in-filter seed still ranked");
  });
});

test("PageRank: prepared partitions exactly match independent nodeFilter walks", () => {
  const g = graphOf(
    ["a.hub", "a.left", "a.right", "b.hub", "b.left", "outside"],
    [
      edge("a.hub", "a.left"),
      edge("a.hub", "a.left"), // Duplicate multiplicity/order must survive preparation.
      edge("a.hub", "a.right"),
      edge("b.hub", "b.left"),
      edge("a.right", "b.left"), // Cross-partition: excluded from both walks.
      edge("a.hub", "missing", "imports"),
    ],
  );
  const partitionOf = (id: string) => id.startsWith("a.") ? "a" : id.startsWith("b.") ? "b" : undefined;
  const prepared = preparePageRankPartitions(g, partitionOf);

  for (const scope of ["a", "b"]) {
    const seeds = new Map([
      [`${scope}.hub`, 2],
      [`${scope}.left`, 1],
      [scope === "a" ? "b.hub" : "a.hub", 50], // Out-of-scope seed is ignored.
    ]);
    const filtered = personalizedPageRank(g, seeds, {
      nodeFilter: (id) => partitionOf(id) === scope,
    });
    const reused = personalizedPageRankPrepared(prepared.get(scope)!, seeds);
    assert.deepEqual(
      [...reused],
      [...filtered],
      `${scope}: prepared topology must preserve entry order and exact floating-point scores`,
    );
  }
});

test("PageRank: preparing many partitions reads graph topology only once", () => {
  const backing = graphOf(
    ["a.hub", "a.leaf", "b.hub", "b.leaf"],
    [edge("a.hub", "a.leaf"), edge("b.hub", "b.leaf")],
  );
  let nodeReads = 0;
  let edgeReads = 0;
  let partitionCalls = 0;
  const counted: GraphV1 = {
    meta: backing.meta,
    get nodes() {
      nodeReads += 1;
      return backing.nodes;
    },
    get edges() {
      edgeReads += 1;
      return backing.edges;
    },
  };

  const prepared = preparePageRankPartitions(counted, (id) => {
    partitionCalls += 1;
    return id[0];
  });
  personalizedPageRankPrepared(prepared.get("a")!, new Map([["a.hub", 1]]));
  personalizedPageRankPrepared(prepared.get("b")!, new Map([["b.hub", 1]]));

  assert.equal(nodeReads, 1, "all partitions share one node pass");
  assert.equal(edgeReads, 1, "all partitions share one edge pass");
  assert.equal(partitionCalls, backing.nodes.length, "each node is assigned once");
});

// ── Integration: ask() with and without graph-rank ──────────────────────────

/** A fixture with a same-word collision: `fooHandler` (wired to two helpers)
 * and `fooWidget` (isolated) both match the token "foo" equally. */
function makeCollisionFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-graphrank-"));
  writeFileSync(
    join(dir, "connected.ts"),
    `export function fooHandler() {\n  helperAlpha();\n  helperBeta();\n}\n` +
      `export function helperAlpha() { return 1; }\n` +
      `export function helperBeta() { return 2; }\n`,
  );
  writeFileSync(join(dir, "isolated.ts"), `export function fooWidget() { return 0; }\n`);
  return dir;
}

const rank = (dir: string, gr: boolean) =>
  ask(dir, "foo", { graphRank: gr }).hits.map((h) => h.title.split(" ·")[0]);

test("ask (graphRank off): pure lexical does not favour the connected hit", async () => {
  const dir = makeCollisionFixture();
  try {
    await buildGraph(dir);
    const titles = rank(dir, false);
    // Both same-word hits are present, no un-matched helper is rescued, and —
    // the key point — connectivity plays no role: the graph-connected fooHandler
    // is NOT lifted above the isolated fooWidget on pure lexical scoring.
    assert.ok(titles.includes("fooHandler") && titles.includes("fooWidget"));
    assert.ok(!titles.includes("helperAlpha"), "no rescue without graph-rank");
    assert.ok(
      titles.indexOf("fooHandler") >= titles.indexOf("fooWidget"),
      "without graph-rank the connected hit gets no ranking advantage",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask (graphRank on): connected hit outranks the isolated collision", async () => {
  const dir = makeCollisionFixture();
  try {
    await buildGraph(dir);
    const titles = rank(dir, true);
    const iHandler = titles.indexOf("fooHandler");
    const iWidget = titles.indexOf("fooWidget");
    assert.ok(iHandler >= 0 && iWidget >= 0, "both same-word hits still present");
    assert.ok(iHandler < iWidget, "the graph-connected fooHandler ranks above isolated fooWidget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask (graphRank on): a strongly-connected neighbour is rescued in", async () => {
  const dir = makeCollisionFixture();
  try {
    await buildGraph(dir);
    const titles = rank(dir, true);
    // helperAlpha/helperBeta never contain "foo", but are called by the matched
    // fooHandler — graph-rank surfaces them so the agent gets the whole cluster.
    assert.ok(
      titles.includes("helperAlpha") || titles.includes("helperBeta"),
      "a helper the query never named is rescued via connectivity",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask: graph-rank is on by default (same as graphRank:true)", async () => {
  const dir = makeCollisionFixture();
  try {
    await buildGraph(dir);
    const def = ask(dir, "foo").hits.map((h) => h.title);
    const on = ask(dir, "foo", { graphRank: true }).hits.map((h) => h.title);
    assert.deepEqual(def, on, "default ordering equals explicit graphRank:true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
