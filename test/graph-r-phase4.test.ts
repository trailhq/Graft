/**
 * Tests for R Phase 4: bare-name resolution for untyped R6 `$` composition
 * calls (`private$other_obj$method()`) also matching "method"-kind nodes, not
 * just "function". Scoped after investigating a real R6-heavy corpus
 * (matching_on_the_fly_designs_R_package_and_paper_repr/EDI/R) where this
 * exact shape — one class holding another as a field, dynamically constructed
 * (constructor-parameter pass-through / do.call dispatch, not a statically
 * inferable `field <- SomeClass$new()` literal) — appears 41+ times. Without
 * this, every one of those calls was unconditionally unresolvable, since
 * viaMember:false calls used to only ever match kind "function".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-r-phase4-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

// Mirrors the real corpus's shape: Design is constructed dynamically (via
// do.call on a runtime class-generator variable, and passed through the
// Inference constructor as a plain parameter) — nothing in the assignment
// syntactically names "Design", so no type-binding table could infer it.
const COMPOSITION_R = `Design <- R6::R6Class("Design",
  public = list(
    get_n = function() { 100 }
  )
)

FixedDesign <- R6::R6Class("FixedDesign",
  inherit = Design,
  public = list()
)

make_design <- function(design_gen) {
  do.call(design_gen$new, list())
}

Inference <- R6::R6Class("Inference",
  public = list(
    initialize = function(des_obj) {
      private$des_obj <- des_obj
    },
    summarize = function() {
      private$des_obj$get_n()
    }
  ),
  private = list(
    des_obj = NULL
  )
)
`;

test("Phase 4: an untyped private$field$method() call resolves to a uniquely-named method", async () => {
  const { dir, graph } = await buildAndRead({ "composition.R": COMPOSITION_R });
  try {
    const call = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === "composition.R#Inference.summarize" &&
        e.target === "composition.R#Design.get_n",
    );
    assert.ok(call, "private$des_obj$get_n() should resolve to Design$get_n, the only get_n in the repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A and B (each defining "run") live in a DIFFERENT file than the caller, so
// resolveName's same-file-first shortcut doesn't apply and the cross-file
// ambiguity check (global.length === 1) is what's actually exercised —
// same-file duplicates are a separate, pre-existing "first match wins" rule
// this phase doesn't touch (see resolveName's own doc comment).
const CLASSES_R = `A <- R6::R6Class("A", public = list(run = function() { 1 }))
B <- R6::R6Class("B", public = list(run = function() { 2 }))
`;
const HOLDER_R = `Holder <- R6::R6Class("Holder",
  public = list(
    go = function(obj) {
      private$target$run()
    }
  ),
  private = list(
    target = NULL
  )
)
`;

test("Phase 4: a cross-file ambiguous method name (defined on multiple classes) is safely dropped, not guessed", async () => {
  const { dir, graph } = await buildAndRead({ "classes.R": CLASSES_R, "holder.R": HOLDER_R });
  try {
    const calls = graph.edges.filter(
      (e) => e.relation === "calls" && e.source === "holder.R#Holder.go",
    );
    assert.equal(calls.length, 0, "run() is defined on both A and B — must not guess either one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 4: pkg::fun() qualified calls are unaffected (still function-only)", async () => {
  const src = `helper <- function() { 1 }

Widget <- R6::R6Class("Widget",
  public = list(
    helper = function() { 2 },
    useQualified = function() {
      pkg::helper()
    }
  )
)
`;
  const { dir, graph } = await buildAndRead({ "qualified.R": src });
  try {
    // pkg::helper() must resolve to the free function, never Widget$helper —
    // qualified calls never widen to "method" kind.
    const call = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "qualified.R#Widget.useQualified",
    );
    assert.equal(call?.target, "qualified.R#helper");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
