/**
 * The generic (breadth) tier: one language-agnostic extractor over a WASM grammar
 * + its tags.scm. These tests prove (a) it emits well-formed graft nodes/edges
 * for a language with NO hand-written extractor, and (b) the EXISTING resolver
 * resolves its bare-name call edges with zero language-specific code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmGenericGrammars, extractGeneric, genericLangOf, isWarm } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { checkGraph } from "../src/graph/check.js";
import { contextDirFor } from "../src/context/node-file.js";

const RUST = `pub struct Config {
    name: String,
}

pub fn load() -> Config {
    let c = parse();
    Config { name: c }
}

fn parse() -> String {
    helper()
}

fn helper() -> String {
    String::new()
}
`;

test("genericLangOf routes .rs to the breadth tier (and not depth-tier extensions)", () => {
  assert.equal(genericLangOf("src/main.rs")?.name, "rust");
  assert.equal(genericLangOf("src/app.ts"), null); // depth tier owns .ts
  assert.equal(genericLangOf("README.md"), null);
});

test("extractGeneric emits nodes + bare-name call edges for Rust (no rust-specific code)", async () => {
  await warmGenericGrammars(["rust"]);
  assert.ok(isWarm("rust"), "rust grammar should warm");
  const { nodes, rawEdges } = extractGeneric("lib.rs", RUST, "rust");

  const kinds = nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
  assert.deepEqual(kinds, ["function:helper", "function:load", "function:parse", "struct:Config"]);

  // every non-file node carries the generic provenance + a span + a signature
  for (const n of nodes.filter((n) => n.kind !== "file")) {
    assert.equal(n.origin, "generic");
    assert.match(n.span, /^L\d+-L\d+$/);
    assert.ok(n.signature && n.signature.length > 0, `${n.name} has a signature`);
  }

  // calls are bare-name raw edges attributed to their enclosing function
  const calls = rawEdges.filter((e) => e.relation === "calls");
  const pairs = calls.map((e) => `${e.source.split("#")[1]}→${e.name}`).sort();
  assert.ok(pairs.includes("load→parse"), `load calls parse (got ${pairs.join(", ")})`);
  assert.ok(pairs.includes("parse→helper"), "parse calls helper");
});

test("the EXISTING resolver resolves generic-tier Rust calls by name", async () => {
  await warmGenericGrammars(["rust"]);
  const { nodes, rawEdges } = extractGeneric("lib.rs", RUST, "rust");
  const edges = resolveEdges(nodes, rawEdges);
  const call = edges.find((e) => e.relation === "calls" && e.source.endsWith("#load"));
  assert.ok(call, "load's call edge survived resolution");
  assert.equal(call?.target, "lib.rs#parse", "resolved to the same-file parse definition");
  assert.equal(call?.confidence, "extracted", "same-file → extracted");
});

// One inline snippet per breadth language, each exercising a definition + a call
// that must resolve. Java/Ruby/C# calls target METHODS — proving the generic-origin
// call-kind widening (resolve.ts) works, not just function-target languages.
const SNIPPETS: Array<{ lang: string; file: string; src: string; defs: string[]; call: [string, string] }> = [
  {
    lang: "java", file: "A.java",
    src: `class A {\n  int run() { return helper(); }\n  int helper() { return 1; }\n}\n`,
    defs: ["class:A", "method:helper", "method:run"], call: ["run", "helper"],
  },
  {
    // Explicit call (`self.draw`), not a parenless bareword: graft's ruby query
    // captures only real call nodes — the upstream bareword @reference.call
    // needs locals-tracking graft doesn't run, so it's dropped for precision.
    lang: "ruby", file: "a.rb",
    src: `class Widget\n  def render\n    self.draw\n  end\n  def draw\n    1\n  end\nend\n`,
    defs: ["class:Widget", "method:draw", "method:render"], call: ["render", "draw"],
  },
  {
    lang: "c_sharp", file: "A.cs",
    src: `class A {\n  int Run() { return Helper(); }\n  int Helper() { return 1; }\n}\n`,
    defs: ["class:A", "method:Helper", "method:Run"], call: ["Run", "Helper"],
  },
  {
    lang: "c", file: "a.c",
    src: `int helper() { return 1; }\nint run() { return helper(); }\n`,
    defs: ["function:helper", "function:run"], call: ["run", "helper"],
  },
  {
    // Lisp: every form is a bare list_lit, so definitions are matched by the
    // head symbol's name (`defn`, `ns`, …), not a dedicated grammar node.
    lang: "clojure", file: "a.clj",
    src: `(ns my.core)\n\n(defn helper [] 1)\n\n(defn run [] (helper))\n`,
    defs: ["function:helper", "function:run", "module:my.core"], call: ["run", "helper"],
  },
];

for (const s of SNIPPETS) {
  test(`breadth tier: ${s.lang} — defs + a call that the resolver resolves`, async () => {
    await warmGenericGrammars([s.lang]);
    assert.ok(isWarm(s.lang), `${s.lang} grammar warms`);
    const { nodes, rawEdges } = extractGeneric(s.file, s.src, s.lang);
    const kinds = nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
    assert.deepEqual(kinds, s.defs, `${s.lang} definitions`);
    const edges = resolveEdges(nodes, rawEdges);
    const call = edges.find((e) => e.relation === "calls" && e.source.endsWith(`#${s.call[0]}`));
    assert.ok(call, `${s.lang}: ${s.call[0]}'s call edge exists and is attributed to the caller`);
    assert.equal(call?.target, `${s.file}#${s.call[1]}`, `${s.lang}: resolved ${s.call[0]}→${s.call[1]}`);
  });
}

// Structural references the grammar already marks — a supertype (extends), an
// implemented interface, an object creation — become `references` edges the resolver
// settles to a type-like definition. This is the breadth-tier orphan-rate fix: a class
// that is only ever extended or instantiated (never "called") stops being disconnected.
test("breadth tier: Java extends/implements/new become resolved references edges (precision-safe)", async () => {
  await warmGenericGrammars(["java"]);
  const src =
    `interface Animal {}\n` +
    `class Base {}\n` +
    `class Dog extends Base implements Animal {\n` +
    `  Base make() { return new Base(); }\n` +
    `}\n` +
    `class Cat extends UnknownExternal {}\n`; // external supertype → must be dropped, never guessed
  const { nodes, rawEdges } = extractGeneric("A.java", src, "java");
  const edges = resolveEdges(nodes, rawEdges);
  const refs = edges.filter((e) => e.relation === "references");
  const pairs = refs.map((e) => `${e.source.split("#")[1]}→${e.target.split("#")[1] ?? e.target}`);

  // extends + implements are attributed to the declaring class; `new Base()` to the method
  assert.ok(pairs.includes("Dog→Base"), `Dog extends Base (got ${pairs.join(", ")})`);
  assert.ok(pairs.includes("Dog→Animal"), "Dog implements Animal");
  assert.ok(pairs.includes("make→Base"), "make() references Base via `new Base()`");
  // same-file targets resolve as certain
  assert.ok(refs.every((e) => e.confidence === "extracted"), "same-file references are extracted");
  // an external/undefined supertype is dropped, not emitted as a bogus edge
  assert.ok(!refs.some((e) => e.target.includes("UnknownExternal")), "unresolved external type is dropped");
  // no self-loops (a class referencing its own name never becomes X→X)
  assert.ok(!refs.some((e) => e.source === e.target), "no self-loop references");
});

// C/C++ #include is the dependency graph the tags.scm can't see (it's the
// preprocessor). A local `#include "x.h"` becomes a file→file import the resolver
// settles to an in-repo header — relative first, then a unique path-suffix (an
// -I-reached header), and never a guess. System `<...>` includes are skipped.
test("breadth tier: C #include becomes a resolved file→file import (local only, drop-rather-than-guess)", async () => {
  await warmGenericGrammars(["c"]);
  const files: Record<string, string> = {
    "src/app.c": '#include "app.h"\n#include "net/sock.h"\n#include <stdio.h>\nint run(void){return 0;}\n',
    "src/app.h": "int run(void);\n",
    "src/net/sock.h": "int connect_sock(void);\n",
    "include/uniq.h": "int uq(void);\n", // reachable only via -I, unique basename
    "src/uses.c": '#include "uniq.h"\n',
    "a/util.h": "int a_u(void);\n", // two util.h → an ambiguous basename
    "b/util.h": "int b_u(void);\n",
    "src/amb.c": '#include "util.h"\n',
  };
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "c");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const imports = resolveEdges(nodes, raw).filter((e) => e.relation === "imports");
  const targetsOf = (src: string) => imports.filter((e) => e.source === src).map((e) => e.target);

  // relative include → the in-repo header (exact; same dir and a subdir)
  assert.ok(targetsOf("src/app.c").includes("src/app.h"), "app.c → app.h (same dir)");
  assert.ok(targetsOf("src/app.c").includes("src/net/sock.h"), "app.c → net/sock.h (subdir)");
  // system <stdio.h> is skipped entirely — no import edge minted
  assert.ok(!imports.some((e) => String(e.target).includes("stdio")), "system include is not captured");
  // a unique basename reached via -I resolves by suffix
  assert.ok(targetsOf("src/uses.c").includes("include/uniq.h"), "unique -I header resolves by suffix");
  // an ambiguous basename is NOT guessed — kept as the raw string, resolving to neither file
  assert.deepEqual(targetsOf("src/amb.c"), ["util.h"], "ambiguous include kept external, never guessed");
});

// Rust `use crate::…` → a file→module import, resolved against the file's crate root
// (the lib.rs/main.rs dir). The longest-prefix rule disambiguates a module from an item
// and a `foo.rs` from a `foo/mod.rs`; std/super/external/glob are skipped, and an
// unresolvable in-crate path is kept as a `crate::…` string, never guessed.
test("breadth tier: Rust use crate::… resolves to the in-repo module (longest-prefix, drop-rather-than-guess)", async () => {
  await warmGenericGrammars(["rust"]);
  const files: Record<string, string> = {
    "src/lib.rs": "pub mod error;\npub mod net;\n",
    "src/error.rs": "pub struct Error;\n",
    "src/net/mod.rs": "pub mod tcp;\n",
    "src/net/tcp.rs": "pub struct Stream;\n",
    "src/app.rs":
      "use crate::error::Error;\n" +          // item under a module → src/error.rs
      "use crate::net::tcp::Stream;\n" +       // nested module → src/net/tcp.rs
      "use crate::net;\n" +                    // single-segment module → src/net/mod.rs
      "use crate::missing::Thing;\n" +         // in-crate but no such file → kept as string
      "use std::io::Read;\n" +                 // external — skipped
      "use super::sibling::Thing;\n" +         // relative — skipped
      "use serde::Serialize;\n" +              // external crate — skipped
      "fn go() {}\n",
    // an integration test lives OUTSIDE the crate root (src/); its `crate::` is the test
    // binary's own root, not the lib — so it must NOT resolve across to src/error.rs.
    "tests/it.rs": "use crate::error::Error;\nfn t() {}\n",
  };
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "rust");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const imports = resolveEdges(nodes, raw).filter((e) => e.relation === "imports" && e.source === "src/app.rs");
  const targets = imports.map((e) => e.target).sort();

  assert.ok(targets.includes("src/error.rs"), "crate::error::Error → error.rs");
  assert.ok(targets.includes("src/net/tcp.rs"), "crate::net::tcp::Stream → net/tcp.rs");
  assert.ok(targets.includes("src/net/mod.rs"), "crate::net (single-segment module) → net/mod.rs");
  // in-crate but unresolvable → the full path kept as a string, never a guessed file edge
  // (crucially NOT silently resolved to the crate-root lib.rs)
  assert.ok(targets.includes("crate::missing::Thing"), "unresolved in-crate path kept as a string");
  // std / super / external crate are not in-crate imports — no edge at all
  assert.ok(!targets.some((t) => /io|sibling|serde|Read|Serialize/.test(t)), "external/relative use skipped");
  assert.equal(imports.length, 4, "exactly the 4 crate:: uses became edges");

  // an integration test's `crate::error::Error` must NOT cross into src/error.rs — its
  // crate root is unknown (it's the test binary), so it stays a string, never a false edge
  const fromTest = resolveEdges(nodes, raw).filter((e) => e.relation === "imports" && e.source === "tests/it.rs");
  assert.deepEqual(fromTest.map((e) => e.target), ["crate::error::Error"], "test-binary crate:: never resolves into the lib");
});

// PHP `use App\Models\User` → a file→class-file import, resolved to the in-repo class by
// the longest namespace-tail suffix (PSR-4 root is unknown). Groups expand; `use function`
// is skipped; a vendor/unknown class or an ambiguous tail stays a string, never guessed.
test("breadth tier: PHP use resolves to the class file (namespace-suffix, groups, drop-rather-than-guess)", async () => {
  await warmGenericGrammars(["php"]);
  const files: Record<string, string> = {
    "src/Models/User.php": "<?php\nnamespace App\\Models;\nclass User {}\n",
    "src/Http/Request.php": "<?php\nnamespace App\\Http;\nclass Request {}\n",
    "src/Http/Response.php": "<?php\nnamespace App\\Http;\nclass Response {}\n",
    "a/Dup.php": "<?php\nclass Dup {}\n",
    "b/Dup.php": "<?php\nclass Dup {}\n",
    "src/App.php":
      "<?php\nnamespace App;\n" +
      "use App\\Models\\User;\n" +              // → src/Models/User.php
      "use App\\Http\\{Request, Response};\n" +  // group → both Http files
      "use App\\Support\\Str as S;\n" +          // in-namespace but no file → string
      "use function App\\helpers\\tap;\n" +      // function import → skipped, no edge
      "use Psr\\Log\\LoggerInterface;\n" +       // external vendor → string
      "use Whatever\\Dup;\n" +                   // ambiguous basename → drop
      "class App {}\n",
  };
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "php");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const imports = resolveEdges(nodes, raw).filter((e) => e.relation === "imports" && e.source === "src/App.php");
  const targets = imports.map((e) => e.target).sort();

  assert.ok(targets.includes("src/Models/User.php"), "use App\\Models\\User → Models/User.php");
  assert.ok(targets.includes("src/Http/Request.php") && targets.includes("src/Http/Response.php"), "group expands to both");
  assert.ok(targets.includes("App\\Support\\Str"), "in-namespace but fileless → kept as string");
  assert.ok(targets.includes("Psr\\Log\\LoggerInterface"), "external vendor class → kept as string");
  assert.ok(targets.includes("Whatever\\Dup"), "ambiguous basename → kept as string, never guessed");
  assert.ok(!targets.some((t) => /tap|helpers/.test(t)), "use function … is skipped (symbol import, not a class file)");
});

test("buildGraph + checkGraph handle a breadth-tier (.rs) repo end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.rs"), RUST);

  await buildGraph(dir, { reuse: false });
  const g = readGraph(wiringPath(contextDirFor(dir)));
  assert.ok(g, "graph built");
  const rust = g!.nodes.filter((n) => n.path.endsWith(".rs") && n.kind !== "file");
  assert.ok(rust.length >= 4, `indexed the rust defs (got ${rust.length})`);
  assert.ok(rust.every((n) => n.origin === "generic"), "rust nodes are generic-tier");
  assert.ok(g!.edges.some((e) => e.relation === "calls"), "rust call edges resolved");

  // check must agree with build — the async warmup means .rs files are re-extracted
  // identically, so a fresh graph reads as in-sync, not perpetually stale.
  const chk = await checkGraph(dir);
  assert.equal(chk.ok, true, `check OK on a breadth-tier repo (added=${chk.added}, removed=${chk.removed})`);
});
