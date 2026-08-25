/**
 * Tests for R Phase 3: roxygen `@export` visibility detection and R6's
 * `super$method()` inheritance-dispatch resolution. Both were scoped
 * specifically for an R6-plus-roxygen setup (no S3/S4 involved) — see
 * plan_r_language_support.md's Phase 2 section and the follow-up discussion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { extractFile } from "../src/graph/extract.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-r-phase3-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

const ROXYGEN_R = `#' @title Widget Class
#' @description a widget
#' @export
Widget <- R6::R6Class("Widget",
  public = list(
    #' @description does a thing
    doThing = function() { 1 }
  )
)

#' Documented but not exported
#' @noRd
internalHelper <- function() { 1 }

#' @export
publicHelper <- function() { 2 }

plainHelper <- function() { 3 }

.dotHelper <- function() { 4 }
`;

test("roxygen: @export tag marks a definition exported regardless of naming", async () => {
  const { dir, graph } = await buildAndRead({ "roxygen.R": ROXYGEN_R });
  try {
    assert.equal(nodeById(graph, "roxygen.R#Widget")?.exported, true, "@export on the R6 class");
    assert.equal(nodeById(graph, "roxygen.R#publicHelper")?.exported, true, "@export on a plain function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roxygen: a documented-but-untagged definition is explicitly NOT exported", async () => {
  const { dir, graph } = await buildAndRead({ "roxygen.R": ROXYGEN_R });
  try {
    // Has a roxygen block (so it's NOT naming-convention "unknown"), but no
    // @export tag — roxygen's own NAMESPACE-generation convention treats this
    // as an explicit internal signal, not an absence of evidence.
    assert.equal(nodeById(graph, "roxygen.R#internalHelper")?.exported, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roxygen: no roxygen block at all falls back to the leading-dot naming convention", async () => {
  const { dir, graph } = await buildAndRead({ "roxygen.R": ROXYGEN_R });
  try {
    assert.equal(nodeById(graph, "roxygen.R#plainHelper")?.exported, true);
    assert.equal(nodeById(graph, "roxygen.R#.dotHelper")?.exported, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("roxygen: R6 method visibility still comes from public=/private=, not roxygen", async () => {
  const { dir, graph } = await buildAndRead({ "roxygen.R": ROXYGEN_R });
  try {
    // doThing has its own roxygen block (@description, no @export — @export
    // doesn't apply to individual R6 methods) but must still resolve via the
    // public= section it's declared in, not fall through to "not exported".
    assert.equal(nodeById(graph, "roxygen.R#Widget.doThing")?.exported, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SUPER_R = `Animal <- R6::R6Class("Animal",
  public = list(
    speak = function() {
      "..."
    }
  )
)

Dog <- R6::R6Class("Dog",
  inherit = Animal,
  public = list(
    speak = function() {
      base <- super$speak()
      paste(base, "Woof")
    }
  )
)
`;

test("super$: resolves to the PARENT class's method, not the current class's own override", async () => {
  const { dir, graph } = await buildAndRead({ "super.R": SUPER_R });
  try {
    const call = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "super.R#Dog.speak" && e.target === "super.R#Animal.speak",
    );
    assert.ok(call, "Dog$speak's super$speak() should resolve to Animal$speak, not Dog$speak itself");

    const selfCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "super.R#Dog.speak" && e.target === "super.R#Dog.speak",
    );
    assert.equal(selfCall, undefined, "must not resolve to its own (same-named) method");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R6Class(...) itself no longer produces a spurious raw calls-edge intent", () => {
  // Checked at the extractFile/rawEdges level, not the resolved graph: an
  // unresolved "calls" RawEdge (no function is ever really named "R6Class")
  // gets silently dropped by resolve.ts regardless, so this fix has no effect
  // on the final graph.edges — it only matters here, avoiding a wasted/
  // incorrect raw-edge intent in the first place.
  const { rawEdges } = extractFile("super.R", SUPER_R, "r");
  assert.equal(
    rawEdges.some((e) => e.relation === "calls" && e.name === "R6Class"),
    false,
  );
});
