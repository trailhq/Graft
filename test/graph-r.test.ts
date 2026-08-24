/**
 * Tests for R extraction in the Tier-1 code graph (Phase 1: flat function
 * extraction, no S3/S4/R6 awareness — see plan_r_language_support.md). Builds a
 * small R module in a temp dir and asserts the emitted nodes (left-assign,
 * `=`-assign, and right-assign function definitions) and edges (contains, calls,
 * imports) match the AST walk in extract.ts. Right-assignment is the main risk
 * area: `function() {} -> name`'s AST shape does not mirror left-assign's the
 * way it looks like it should (see describeR's doc comment) — get it wrong and
 * every right-assigned function in a real R codebase silently disappears.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const MAIN_R = `library(dplyr)
require(purrr)
source("helpers.R")

foo <- function(x) {
  x + 1
}

.helper <- function() {
  1
}

bar = function(y) {
  y * 2
}

function(z) {
  z - 1
} -> baz

result <- lapply(1:3, function(n) n + 1)

sibling <- function() {
  42
}

useQualified <- function() {
  pkg::sibling()
}

useDollar <- function(obj) {
  obj$sibling()
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-r-"));
  writeFileSync(join(dir, "main.R"), MAIN_R);
  writeFileSync(join(dir, "helpers.R"), "noop <- function() { NULL }\n");
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("R extraction: left-assign, =-assign, and right-assign function definitions", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir);
    assert.ok(result.languages.includes("r"), "languages should include r");
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const foo = nodeById(graph, "main.R#foo");
    assert.equal(foo?.kind, "function");
    assert.equal(foo?.exported, true);
    assert.equal(foo?.signature, "function(x)");

    const bar = nodeById(graph, "main.R#bar");
    assert.equal(bar?.kind, "function");
    assert.equal(bar?.exported, true);

    // The critical assertion: right-assign's AST shape is NOT a mirror of
    // left-assign's — `->`'s low precedence absorbs it into the function
    // definition's own body field. Get this wrong and baz never appears.
    const baz = nodeById(graph, "main.R#baz");
    assert.equal(baz?.kind, "function");
    assert.equal(baz?.exported, true);
    assert.equal(baz?.signature, "function(z)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R extraction: leading-dot naming convention marks a function unexported", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.equal(nodeById(graph, "main.R#.helper")?.exported, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R extraction: an anonymous callback function is NOT emitted as a node", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // Every real definition in the fixture, no more, no fewer — the anonymous
    // `function(n) n + 1` passed to lapply() must not sneak in as an 8th.
    const expected = ["foo", ".helper", "bar", "baz", "sibling", "useQualified", "useDollar"];
    const functionNodes = graph.nodes.filter((n) => n.kind === "function" && n.path === "main.R");
    assert.deepEqual(
      functionNodes.map((n) => n.name).sort(),
      [...expected].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R extraction: library()/require()/source() become imports edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      graph.edges.some((e) => e.relation === "imports" && e.source === "main.R" && e.target === "dplyr"),
      "library(dplyr) should be captured",
    );
    assert.ok(
      graph.edges.some((e) => e.relation === "imports" && e.source === "main.R" && e.target === "purrr"),
      "require(purrr) should be captured",
    );
    assert.ok(
      graph.edges.some((e) => e.relation === "imports" && e.source === "main.R" && e.target === "helpers.R"),
      `source("helpers.R") should be captured`,
    );

    // library()/require()/source() must NOT also produce spurious `calls` edges
    // to functions literally named "library"/"require"/"source" — isImport is
    // checked before the generic calls path precisely to prevent this.
    assert.equal(
      graph.edges.some((e) => e.relation === "calls" && ["library", "require", "source"].includes(e.target)),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R extraction: qualified (pkg::fn) and member-style ($) calls resolve by bare name", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const qualifiedCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "main.R#useQualified" && e.target === "main.R#sibling",
    );
    assert.ok(qualifiedCall, "pkg::sibling() should resolve to the in-repo sibling() by bare name");

    const dollarCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "main.R#useDollar" && e.target === "main.R#sibling",
    );
    assert.ok(dollarCall, "obj$sibling() should resolve to the in-repo sibling() by bare name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R extraction: contains edges (file -> function)", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const foo = nodeById(graph, "main.R#foo")!;
    assert.ok(
      graph.edges.some((e) => e.relation === "contains" && e.source === "main.R" && e.target === foo.id),
      "main.R should contain foo",
    );
    const baz = nodeById(graph, "main.R#baz")!;
    assert.ok(
      graph.edges.some((e) => e.relation === "contains" && e.source === "main.R" && e.target === baz.id),
      "main.R should contain baz (right-assigned)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
