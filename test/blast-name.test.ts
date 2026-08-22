/**
 * The naming layer, whose whole job is to be honest about where a label came from.
 *
 * Three properties are asserted here because breaking any of them makes the PR
 * comment worse than no comment at all:
 *   - a cluster's name is keyed by its CONTENT, so the same area is not renamed on
 *     every PR and two comments stay comparable;
 *   - a declined ("mixed") cluster keeps its symbol backstop instead of taking a
 *     flattering name for files that serve two unrelated features;
 *   - any failure — no key, spent quota, malformed answer — leaves every label as
 *     it was and never throws, since a check must not fail over cosmetics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyNames, clusterHash, sanitize, type Cluster, type Namer } from "../src/blast/name.js";
import type { BlastReport, ImpactedModule } from "../src/blast/blast.js";
import type { GraphV1 } from "../src/graph/types.js";

function graph(hashes: Record<string, string>): GraphV1 {
  return {
    meta: { version: 1, generated: "", root: "." } as GraphV1["meta"],
    nodes: Object.entries(hashes).map(([path, body_hash]) => ({
      id: path, name: path, kind: "file", path, span: "L1-L9",
      signature: null, exported: true, origin: "ast", body_hash, chars: 10,
    })) as GraphV1["nodes"],
    edges: [],
  };
}

function mod(key: string, files: string[], symbols: string[]): ImpactedModule {
  return {
    label: symbols[0] ?? key,
    labelSource: "symbol",
    key,
    files,
    from: [],
    symbols: symbols.map((name, i) => ({
      id: `${files[0]}#${name}`, name, kind: "function", path: files[0],
      span: `L${i + 1}-L${i + 2}`, relation: "calls", depth: 1,
    })),
  };
}

function report(modules: ImpactedModule[]): BlastReport {
  return {
    basis: "origin/main...HEAD", depth: 2, changed: [], unindexed: [], deleted: [],
    seeds: [], impacted: [], modules, testModules: [], areas: [],
  };
}

/** Records what it was asked, answers from a fixed table. */
function stubNamer(answers: Record<string, string>): Namer & { calls: Cluster[][] } {
  const calls: Cluster[][] = [];
  return {
    calls,
    async name(clusters) {
      calls.push(clusters);
      const out = new Map<string, string>();
      for (const c of clusters) if (answers[c.symbols[0]]) out.set(c.key, answers[c.symbols[0]]);
      return out;
    },
  };
}

const dir = () => mkdtempSync(join(tmpdir(), "graft-name-"));

test("blast name: a cluster is keyed by content, so unchanged code is never renamed", () => {
  const files = ["src/a.ts", "src/b.ts"];
  const before = new Map([["src/a.ts", "h1"], ["src/b.ts", "h2"]]);
  const reordered = new Map([["src/b.ts", "h2"], ["src/a.ts", "h1"]]);
  const edited = new Map([["src/a.ts", "h1"], ["src/b.ts", "CHANGED"]]);

  assert.equal(clusterHash(files, before), clusterHash([...files].reverse(), reordered),
    "member order must not change the key");
  assert.notEqual(clusterHash(files, before), clusterHash(files, edited),
    "editing a member's body must change the key");
});

test("blast name: names are written to the cache, then served from it without a call", async () => {
  const contextDir = dir();
  const g = graph({ "src/graph/refresh.ts": "h1" });
  const namer = stubNamer({ ensureFreshGraph: "Query Freshness Gate" });

  const first = report([mod("src/graph/", ["src/graph/refresh.ts"], ["ensureFreshGraph"])]);
  const cold = await applyNames(g, first, { namer, contextDir });
  assert.deepEqual([cold.named, cold.cached, cold.declined], [1, 0, 0]);
  assert.equal(first.modules[0].label, "Query Freshness Gate");
  assert.equal(first.modules[0].labelSource, "named", "the report says where the label came from");

  const onDisk = JSON.parse(readFileSync(join(contextDir, ".cache", "areas.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.values(onDisk), ["Query Freshness Gate"]);

  const second = report([mod("src/graph/", ["src/graph/refresh.ts"], ["ensureFreshGraph"])]);
  const warm = await applyNames(g, second, { namer, contextDir });
  assert.deepEqual([warm.named, warm.cached], [0, 1]);
  assert.equal(second.modules[0].label, "Query Freshness Gate");
  assert.equal(namer.calls.length, 1, "a cache hit must not reach the model");
});

test("blast name: a concept label outranks naming, and a declined cluster keeps its symbol", async () => {
  const contextDir = dir();
  const g = graph({ "src/a.ts": "h1", "src/mixed.ts": "h2" });
  const namer = stubNamer({ hubOne: "Real Feature Name" });

  const r = report([
    mod("src/", ["src/a.ts"], ["hubOne"]),
    mod("src/mixed/", ["src/mixed.ts"], ["hubTwo"]),
  ]);
  // A concept node already named this one: naming must not touch it, since a
  // concept is written from whole file bodies and knows strictly more.
  r.modules[0].label = "Written By A Concept";
  r.modules[0].labelSource = "concept";

  const stats = await applyNames(g, r, { namer, contextDir });

  assert.equal(r.modules[0].label, "Written By A Concept");
  assert.deepEqual(namer.calls[0].map((c) => c.symbols[0]), ["hubTwo"], "only the backstop cluster is sent");
  // hubTwo is absent from the stub's table, which is how a "mixed" answer arrives.
  assert.equal(r.modules[1].label, "hubTwo");
  assert.equal(r.modules[1].labelSource, "symbol");
  assert.deepEqual([stats.named, stats.declined], [0, 1]);
});

test("blast name: test-only clusters are never named, since nothing renders them", async () => {
  const contextDir = dir();
  const g = graph({ "src/a.ts": "h1", "test/a.test.ts": "h2" });
  const namer = stubNamer({ hubOne: "Real Feature Name" });

  const r = report([mod("src/", ["src/a.ts"], ["hubOne"])]);
  r.testModules = [mod("test/", ["test/a.test.ts"], ["describesThings"])];

  await applyNames(g, r, { namer, contextDir });

  assert.deepEqual(namer.calls[0].map((c) => c.symbols[0]), ["hubOne"], "only the drawn cluster is sent");
  assert.equal(r.testModules[0].label, "describesThings", "the test cluster keeps its backstop");
});

test("blast name: a failing namer reports the reason and leaves every label alone", async () => {
  const contextDir = dir();
  const g = graph({ "src/a.ts": "h1" });
  const r = report([mod("src/", ["src/a.ts"], ["hubOne"])]);

  const stats = await applyNames(g, r, {
    contextDir,
    namer: { async name() { throw new Error("402 quota exhausted"); } },
  });

  assert.match(stats.error ?? "", /quota exhausted/);
  assert.equal(r.modules[0].label, "hubOne", "the backstop survives a failed call");
  assert.equal(r.modules[0].labelSource, "symbol");
});

test("blast name: a model's answer is untrusted text and is stripped before rendering", () => {
  // Symbol names from a fork's diff reach the prompt, so the answer could carry
  // anything that closes a Mermaid label or opens a markdown table cell.
  assert.equal(sanitize('Auth "Gate" <img src=x>'), "Auth Gate img src=x");
  assert.equal(sanitize("Pipe | Table"), "Pipe Table");
  assert.equal(sanitize("  spaced   out  "), "spaced out");
  assert.equal(sanitize("An Extremely Long Feature Name That Never Fits A Circle").length <= 31, true);
});
