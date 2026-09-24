/**
 * Tests for Hack (Hacklang) extraction in the Tier-1 code graph. Hack is PHP-like
 * but has its own tree-sitter grammar (vendored `tree-sitter-hack`) with distinct
 * node types — a top-level `function_declaration` (not php's `function_definition`),
 * class-body `method_declaration`s, single `call_expression` for every call shape,
 * and `extends_clause`/`implements_clause` as direct children of the declaration.
 * Builds a small tagless-`.hack` project in a temp dir and asserts the emitted
 * nodes and edges match the AST walk in extract.ts.
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

// Tagless `.hack` — the native grammar parses it without a `<?hh` marker.
const APP_HACK = `namespace App;

use App\\Support\\Base;

class Widget extends Base implements Runnable {
  use Loggable;

  public function run(): int {
    $this->log();
    return $this->helper();
  }

  private function helper(): int {
    return Base::seed();
  }

  public function act(Base $b): string {
    return $b->label();
  }
}

interface Runnable {}

trait Loggable {
  protected function log(): void {}
}

enum Color: string {
  RED = 'r';
}

function topLevel(): int {
  return 1;
}
`;

const BASE_HACK = `namespace App\\Support;

class Base {
  public static function seed(): int {
    return 0;
  }

  public function label(): string {
    return 'b';
  }
}
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-hack-"));
  writeFileSync(join(dir, "app.hack"), APP_HACK);
  writeFileSync(join(dir, "base.hack"), BASE_HACK);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("Hack extraction: classes, methods, interface, trait, enum, function", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir); // $0, Tier-1 only
    assert.ok(result.languages.includes("hack"), "languages should include hack");

    const graph = readGraph(wiringPath(join(dir, "graft")));
    assert.ok(graph, "wiring graph should be written");

    assert.equal(nodeById(graph!, "app.hack#Widget")?.kind, "class");
    assert.equal(nodeById(graph!, "base.hack#Base")?.kind, "class");

    // methods — file-scoped under their class; visibility drives `exported`
    const run = nodeById(graph!, "app.hack#Widget.run");
    assert.equal(run?.kind, "method");
    assert.equal(run?.exported, true, "public method is exported");
    assert.equal(nodeById(graph!, "app.hack#Widget.helper")?.exported, false, "private method is not exported");

    // language-specific kinds
    assert.equal(nodeById(graph!, "app.hack#Runnable")?.kind, "interface");
    assert.equal(nodeById(graph!, "app.hack#Loggable")?.kind, "trait");
    assert.equal(nodeById(graph!, "app.hack#Color")?.kind, "enum");
    assert.equal(nodeById(graph!, "app.hack#topLevel")?.kind, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hack extraction: call, extends, and implements edges", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // `class Widget extends Base` resolves cross-file by class name
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "extends" && e.source === "app.hack#Widget" && e.target === "base.hack#Base",
      ),
      "Widget should have a resolved extends edge to Base",
    );

    // `implements Runnable` resolves to the same-file interface
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "implements" && e.source === "app.hack#Widget" && e.target === "app.hack#Runnable",
      ),
      "Widget should have a resolved implements edge to Runnable",
    );

    // `$this->log()` resolves to the used trait's method (trait-use → implements edge)
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.hack#Widget.run" && e.target === "app.hack#Loggable.log",
      ),
      "run should have a resolved calls edge to Loggable.log via trait use",
    );

    // `$this->helper()` resolves to the receiver method (this → enclosing class)
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.hack#Widget.run" && e.target === "app.hack#Widget.helper",
      ),
      "run should have a resolved calls edge to helper",
    );

    // `Base::seed()` static call resolves to the target class method by name
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.hack#Widget.helper" && e.target === "base.hack#Base.seed",
      ),
      "helper should have a resolved calls edge to Base.seed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hack extraction: trait use and typed-parameter receiver binding", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // `use Loggable;` inside the class body resolves to the trait (modelled as implements)
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "implements" && e.source === "app.hack#Widget" && e.target === "app.hack#Loggable",
      ),
      "Widget should have a resolved trait-use (implements) edge to Loggable",
    );

    // `act(Base $b)` -> `$b->label()` resolves via the typed-parameter binding
    // ($b : Base), not by bare method name — Base.label is the only match anyway,
    // but the binding is what makes this correct when several classes share a name.
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "app.hack#Widget.act" && e.target === "base.hack#Base.label",
      ),
      "act should resolve $b->label() to Base.label through the parameter binding",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hack extraction: `new` assignment binds the constructed type for member calls", () => {
  // `$b = new Base(); $b->label();` — the binding pass records $b : Base from the
  // `new` expression, so the member call resolves by receiver type, not bare name.
  const src = `namespace App;

use App\\Support\\Base;

function build(): string {
  $b = new Base();
  return $b->label();
}
`;
  const { rawEdges } = extractFile("build.hack", src, "hack");
  const call = rawEdges.find((e) => e.relation === "calls" && e.name === "label");
  assert.ok(call, "the $b->label() call edge should be emitted");
  assert.equal(call!.recvType, "Base", "$b->label() should carry recvType Base from the new-expression binding");
});

test("Hack extraction: `enum class` is captured as an enum node", () => {
  // Hack's `enum class Foo: Bar {...}` is a distinct node type from a plain
  // `enum` (111 files in webapp use it) — it maps to the same `enum` kind.
  const src = `namespace App;

enum class Refs: Reference {
  Foo<Reference> Bar = new Reference();
}
`;
  const { nodes } = extractFile("refs.hack", src, "hack");
  assert.equal(nodes.find((n) => n.id === "refs.hack#Refs")?.kind, "enum");
});

test("Hack extraction: `.hhi` interface files are indexed like `.hack`", () => {
  const src = `namespace App;

interface Greeter {
  public function greet(): string;
}
`;
  const { nodes } = extractFile("greeter.hhi", src, "hack");
  assert.equal(nodes.find((n) => n.id === "greeter.hhi#Greeter")?.kind, "interface");
});
