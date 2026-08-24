/**
 * Tests for R Phase 5: plain-list "mixin"/"extension" bundles
 * (`Foo <- list(public = list(...), private = list(...))`, NOT wrapped in
 * `R6::R6Class(...)`) recognized as class-like containers. Discovered
 * dogfooding against a real R6-heavy corpus
 * (matching_on_the_fly_designs_R_package_and_paper_repr/EDI/R), where this
 * "Pattern-1 mixin/extension" convention — sharing method bundles across
 * classes via splicing (`public = c(Mixin$public, list(...))`) rather than
 * `inherit =` — is used in 25 files, 11 of which were entirely invisible to
 * the graph (zero extracted symbols) without this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { extractFile } from "../src/graph/extract.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-r-phase5-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

// Mirrors the real corpus's InferenceMixinKKGLMMShared shape.
const MIXIN_R = `InferenceMixinKKGLMMShared = list(
  public = list(
    compute_estimate = function(estimate_only = FALSE) {
      private$shared(estimate_only = estimate_only)
    }
  ),
  private = list(
    shared = function() { 1 }
  )
)
`;

test("Phase 5: a plain-list mixin container is recognized as a class", async () => {
  const { dir, graph } = await buildAndRead({ "mixin.R": MIXIN_R });
  try {
    const mixin = graph.nodes.find((n) => n.id === "mixin.R#InferenceMixinKKGLMMShared");
    assert.equal(mixin?.kind, "class");

    const publicMethod = graph.nodes.find((n) => n.id === "mixin.R#InferenceMixinKKGLMMShared.compute_estimate");
    assert.equal(publicMethod?.kind, "method");
    assert.equal(publicMethod?.owner, "InferenceMixinKKGLMMShared");
    assert.equal(publicMethod?.exported, true);

    const privateMethod = graph.nodes.find((n) => n.id === "mixin.R#InferenceMixinKKGLMMShared.shared");
    assert.equal(privateMethod?.exported, false, "private = list(...) entries stay unexported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 5: self$/private$ calls inside a mixin's methods still resolve to the mixin itself", async () => {
  const { dir, graph } = await buildAndRead({ "mixin.R": MIXIN_R });
  try {
    const call = graph.edges.find(
      (e) =>
        e.relation === "calls" &&
        e.source === "mixin.R#InferenceMixinKKGLMMShared.compute_estimate" &&
        e.target === "mixin.R#InferenceMixinKKGLMMShared.shared",
    );
    assert.ok(call, "private$shared() should resolve within the mixin container itself");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 5: an ordinary data/config list is NOT mistaken for a mixin container", async () => {
  const src = `EDI_MIXIN_CONTRACTS <- list(
  allowed = c("a", "b"),
  required = list(x = 1, y = 2)
)
`;
  const { dir, graph } = await buildAndRead({ "config.R": src });
  try {
    assert.equal(
      graph.nodes.some((n) => n.id === "config.R#EDI_MIXIN_CONTRACTS"),
      false,
      "a list with no public=/private= entry must not become a class node",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Phase 5: the mixin's list(...) call itself no longer produces a spurious raw calls-edge intent", () => {
  const { rawEdges } = extractFile("mixin.R", MIXIN_R, "r");
  assert.equal(
    rawEdges.some((e) => e.relation === "calls" && e.name === "list"),
    false,
  );
});
