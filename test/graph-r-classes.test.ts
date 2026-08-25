/**
 * Tests for R Phase 2 (S3/S4/R6-aware) extraction. R's class systems are
 * library *convention*, not grammar syntax — unlike every other language graft
 * supports — so this is "pattern-match known call idioms -> sometimes a kind"
 * rather than "one grammar construct -> one graph kind". Three separate risk
 * areas, three separate fixtures: R6's public=/private=/active= list-walking
 * (this repo's own dominant OOP style, per plan_r_language_support.md), S4's
 * "a call defines a symbol" shape (setClass/setMethod), and S3's genuinely
 * ambiguous name.Class dispatch detection (read.csv is NOT an S3 method).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-r-classes-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

const R6_R = `Base <- R6::R6Class("Base",
  public = list(
    ping = function() { 1 }
  )
)

Foo <- R6::R6Class("Foo",
  inherit = Base,
  public = list(
    initialize = function(x) {
      private$x_ <- x
    },
    greet = function() {
      self$helper()
    },
    helper = function() {
      42
    }
  ),
  private = list(
    x_ = NULL,
    secret = function() { 1 }
  )
)
`;

test("R6: class nodes, inherit heritage, public/private visibility", async () => {
  const { dir, graph } = await buildAndRead({ "r6.R": R6_R });
  try {
    assert.equal(nodeById(graph, "r6.R#Base")?.kind, "class");
    assert.equal(nodeById(graph, "r6.R#Foo")?.kind, "class");

    assert.ok(
      graph.edges.some(
        (e) => e.relation === "extends" && e.source === "r6.R#Foo" && e.target === "r6.R#Base",
      ),
      "Foo should extend Base via inherit =",
    );

    const initialize = nodeById(graph, "r6.R#Foo.initialize");
    assert.equal(initialize?.kind, "method");
    assert.equal(initialize?.owner, "Foo");
    assert.equal(initialize?.exported, true);

    assert.equal(nodeById(graph, "r6.R#Foo.greet")?.exported, true);
    assert.equal(nodeById(graph, "r6.R#Foo.helper")?.exported, true);

    // private = list(...) methods are NOT exported.
    assert.equal(nodeById(graph, "r6.R#Foo.secret")?.exported, false);

    // A private FIELD (x_ = NULL, not a function) must not become a node —
    // only function-valued list entries are methods.
    assert.equal(
      graph.nodes.some((n) => n.name === "x_"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R6: self$/private$ calls resolve directly to the enclosing class", async () => {
  const { dir, graph } = await buildAndRead({ "r6.R": R6_R });
  try {
    const call = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "r6.R#Foo.greet" && e.target === "r6.R#Foo.helper",
    );
    assert.ok(call, "self$helper() inside Foo$greet should resolve to Foo$helper");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const S4_R = `setClass("Animal", representation(name = "character"))

setClass("Dog", contains = "Animal")

setClass("Multi", contains = c("Animal", "Dog"))

setGeneric("speak", function(x) standardGeneric("speak"))

setMethod("speak", "Dog", function(x) {
  cat("Woof")
})
`;

test("S4: setClass classes, single + multiple contains heritage", async () => {
  const { dir, graph } = await buildAndRead({ "s4.R": S4_R });
  try {
    assert.equal(nodeById(graph, "s4.R#Animal")?.kind, "class");
    assert.equal(nodeById(graph, "s4.R#Dog")?.kind, "class");
    assert.equal(nodeById(graph, "s4.R#Multi")?.kind, "class");

    assert.ok(
      graph.edges.some((e) => e.relation === "extends" && e.source === "s4.R#Dog" && e.target === "s4.R#Animal"),
      "Dog should extend Animal via contains = \"Animal\"",
    );
    assert.ok(
      graph.edges.some((e) => e.relation === "extends" && e.source === "s4.R#Multi" && e.target === "s4.R#Animal"),
      "Multi should extend Animal via contains = c(...)",
    );
    assert.ok(
      graph.edges.some((e) => e.relation === "extends" && e.source === "s4.R#Multi" && e.target === "s4.R#Dog"),
      "Multi should extend Dog via contains = c(...)",
    );

    // setGeneric() is not specially extracted — no natural class/method mapping.
    assert.equal(
      graph.nodes.some((n) => n.name === "standardGeneric"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S4: setMethod becomes a method owned by its class", async () => {
  const { dir, graph } = await buildAndRead({ "s4.R": S4_R });
  try {
    const speak = nodeById(graph, "s4.R#Dog.speak");
    assert.equal(speak?.kind, "method");
    assert.equal(speak?.owner, "Dog");
    assert.equal(speak?.name, "speak");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const S3_R = `summarizeThing <- function(x) UseMethod("summarizeThing")

summarizeThing.Widget <- function(x) {
  "widget summary"
}

print.Widget <- function(x, ...) {
  cat("a widget")
}

read.csv <- function(path) {
  path
}
`;

test("S3: a locally-registered generic's name.Class dispatch becomes a method", async () => {
  const { dir, graph } = await buildAndRead({ "s3.R": S3_R });
  try {
    const generic = nodeById(graph, "s3.R#summarizeThing");
    assert.equal(generic?.kind, "function", "the generic itself (UseMethod caller) stays a plain function");

    const method = nodeById(graph, "s3.R#Widget.summarizeThing");
    assert.equal(method?.kind, "method");
    assert.equal(method?.owner, "Widget");
    assert.equal(method?.name, "summarizeThing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3: a common base-R generic (print) is recognized without local UseMethod evidence", async () => {
  const { dir, graph } = await buildAndRead({ "s3.R": S3_R });
  try {
    const method = nodeById(graph, "s3.R#Widget.print");
    assert.equal(method?.kind, "method");
    assert.equal(method?.owner, "Widget");
    assert.equal(method?.name, "print");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3: an ordinary dotted function name is NOT misread as S3 dispatch (read.csv)", async () => {
  const { dir, graph } = await buildAndRead({ "s3.R": S3_R });
  try {
    const fn = nodeById(graph, "s3.R#read.csv");
    assert.equal(fn?.kind, "function", "read.csv is a plain helper, not Csv.read S3 dispatch");
    assert.equal(
      graph.nodes.some((n) => n.owner === "csv"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
