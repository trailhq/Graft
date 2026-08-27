/**
 * Tier-0 quality gate as a test: build a real graph over a multi-tier fixture
 * (TS + PHP on the depth extractor, Rust on the generic breadth tier) and assert
 * (a) the structural INVARIANTS hold on the output of BOTH tiers together, and
 * (b) the build is DETERMINISTIC — two cold builds of the same source produce the
 * same graph. Both are things every future extraction/resolution change must keep
 * true; without this a malformed edge or a nondeterministic ordering would ship
 * silently. Uses the shared `checkGraphInvariants` so the gate and any future
 * `graft check --invariants` cannot drift apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { checkGraphInvariants } from "../src/graph/invariants.js";
import type { GraphV1 } from "../src/graph/types.js";

// A recursion-free fixture spanning both tiers: main→helper (TS, depth),
// load→parse (Rust, breadth), Circle implements Shape (PHP, depth → an
// `implements` edge; PHP has a depth extractor, so it is not on the breadth
// tier). No function calls itself, so self-loops must be zero.
function writeFixture(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "app.ts"),
    `export function main(): number { return helper(); }\nfunction helper(): number { return 1; }\n`,
  );
  writeFileSync(
    join(dir, "lib.rs"),
    `pub struct Config { name: String }\n` +
      `pub fn load() -> Config { parse(); Config { name: String::new() } }\n` +
      `fn parse() -> String { String::new() }\n`,
  );
  writeFileSync(
    join(dir, "shape.php"),
    `<?php\ninterface Shape { public function area(); }\n` +
      `class Circle implements Shape { public function area() { return 1; } }\n`,
  );
}

/** The graph's identity for determinism: the node-id sequence and the ordered
 * edge tuples. Order matters — a nondeterministic build would reorder these even
 * when the set is unchanged. */
function identity(g: GraphV1): { nodes: string[]; edges: string[] } {
  return {
    nodes: g.nodes.map((n) => `${n.id}\0${n.kind}\0${n.span}\0${n.origin}`),
    edges: g.edges.map((e) => `${e.source}\0${e.relation}\0${e.target}\0${e.confidence}`),
  };
}

test("Tier-0: a built multi-tier graph satisfies every structural invariant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-invariants-"));
  try {
    writeFixture(dir);
    await buildGraph(dir, { reuse: false });
    const g = readGraph(wiringPath(contextDirFor(dir)));
    assert.ok(g, "graph built");

    // both tiers are actually present, or the fixture isn't testing what it claims
    const origins = new Set(g!.nodes.filter((n) => n.kind !== "file").map((n) => n.origin));
    assert.ok(origins.has("ast"), "TS/PHP depth-tier nodes present");
    assert.ok(origins.has("generic"), "Rust breadth-tier nodes present");
    // and that resolution actually produced the edge kinds this gate is meant to guard
    const rels = new Set(g!.edges.map((e) => e.relation));
    assert.ok(rels.has("calls"), "call edges resolved");
    assert.ok(rels.has("implements"), "a PHP depth-tier implements edge resolved (Circle→Shape)");
    assert.ok(rels.has("contains"), "containment edges present");

    const { problems, selfLoopCalls } = checkGraphInvariants(g!);
    assert.deepEqual(problems, [], `no invariant violations (got: ${problems.slice(0, 5).join("; ")})`);
    assert.equal(selfLoopCalls, 0, "a recursion-free fixture has no self-loop calls");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Tier-0: the invariant checker actually catches malformed graphs (not vacuous)", () => {
  const bad: GraphV1 = {
    meta: { version: 1, nodeCount: 2, edgeCount: 2, languages: ["ts"], scopes: [] },
    nodes: [
      // a valid node, then a duplicate id + a bad kind + an inverted span + an empty name
      { id: "a.ts#Foo", name: "Foo", kind: "class", path: "a.ts", span: "L1-L3",
        signature: null, exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null },
      { id: "a.ts#Foo", name: "  ", kind: "widget" as never, path: "a.ts", span: "L9-L2",
        signature: null, exported: true, origin: "ast", body_hash: "y", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [
      // a calls edge into a node that does not exist (dangling target), plus a bad confidence
      { source: "a.ts#Foo", target: "a.ts#Ghost", relation: "calls", confidence: "guessed" as never },
      // a dangling SOURCE
      { source: "a.ts#Missing", target: "a.ts#Foo", relation: "references", confidence: "extracted" },
    ],
  };
  const { problems } = checkGraphInvariants(bad);
  // every planted defect must be reported
  assert.ok(problems.some((p) => p.includes("duplicate node id")), "flags the duplicate id");
  assert.ok(problems.some((p) => p.includes("empty name")), "flags the empty name");
  assert.ok(problems.some((p) => p.includes("bad kind")), "flags the bad kind");
  assert.ok(problems.some((p) => p.includes("inverted span")), "flags the inverted span");
  assert.ok(problems.some((p) => p.includes("dangling calls target")), "flags the dangling target");
  assert.ok(problems.some((p) => p.includes("dangling source")), "flags the dangling source");
  assert.ok(problems.some((p) => p.includes("bad confidence")), "flags the bad confidence");
  // an unresolved imports/extends/implements/references target is NOT flagged
  const okExternal = checkGraphInvariants({
    ...bad,
    nodes: [bad.nodes[0]],
    edges: [{ source: "a.ts#Foo", target: "com.external.Base", relation: "extends", confidence: "inferred" }],
  });
  assert.deepEqual(okExternal.problems, [], "an external heritage/import string target is allowed, not dangling");
  const okAnno = checkGraphInvariants({
    ...bad,
    nodes: [bad.nodes[0]],
    edges: [{ source: "a.ts#Foo", target: "Override", relation: "references", confidence: "inferred" }],
  });
  assert.deepEqual(okAnno.problems, [], "an external annotation string target is allowed, not dangling");
});

test("Tier-0: the build is deterministic — two cold builds produce the identical graph", async () => {
  const build = async (): Promise<GraphV1> => {
    const dir = mkdtempSync(join(tmpdir(), "graft-determinism-"));
    try {
      writeFixture(dir);
      await buildGraph(dir, { reuse: false });
      const g = readGraph(wiringPath(contextDirFor(dir)));
      assert.ok(g, "graph built");
      return g!;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // Two separate cold builds of byte-identical source (relative ids, so paths match).
  const [a, b] = [await build(), await build()];
  const ia = identity(a), ib = identity(b);
  assert.equal(a.nodes.length, b.nodes.length, "same node count");
  assert.equal(a.edges.length, b.edges.length, "same edge count");
  assert.deepEqual(ia.nodes, ib.nodes, "node id/kind/span/origin sequence is identical across builds");
  assert.deepEqual(ia.edges, ib.edges, "edge sequence is identical across builds");
});
