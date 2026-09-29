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
import {
  warmGenericGrammars,
  extractGeneric,
  genericLangOf,
  isWarm,
  loadWasmLanguage,
  parseWasm,
  swapGrammarForTest,
  type TsNode,
} from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { checkGraph } from "../src/graph/check.js";
import { contextDirFor } from "../src/context/node-file.js";
import { skeleton } from "../src/ask/ask.js";

test("genericLangOf routes .rs to the depth tier (and not depth-tier extensions)", () => {
  assert.equal(genericLangOf("src/main.rs"), null); // depth tier owns .rs (PR #59)
  assert.equal(genericLangOf("src/init.lua")?.name, "lua");
  assert.equal(genericLangOf("src/app.ts"), null); // depth tier owns .ts
  assert.equal(genericLangOf("README.md"), null);
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
  {
    // Lua functions can be declarations, assigned expressions, or table fields;
    // colon syntax defines and calls methods.
    lang: "lua", file: "a.lua",
    src: `local function helper()\n  return 1\nend\n\nlocal assigned = function()\n  return helper()\nend\n\nlocal handlers = { draw = function() return helper() end }\n\nfunction Widget:run()\n  return helper()\nend\n\nlocal function launch()\n  return Widget:run()\nend\n`,
    defs: ["function:assigned", "function:draw", "function:helper", "function:launch", "method:run"], call: ["launch", "run"],
  },
  {
    // Nix: a binding whose value is a lambda (let-bound or attrset field) becomes
    // a function def; a non-function binding (`version`) is not emitted, and an
    // application of one binding by another resolves as a call.
    lang: "nix", file: "a.nix",
    src: `let\n  helper = x: x + 1;\nin {\n  greet = name: helper 2;\n  version = "1.0";\n}\n`,
    defs: ["function:greet", "function:helper"], call: ["greet", "helper"],
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

// The depth-tier Rust extractor, end to end through buildGraph + checkGraph: a
// repo whose only source is .rs must build (origin "ast"), resolve its bare-name
// call edges, and read as in-sync on the very next check — no warmup asymmetry.
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

test("buildGraph + checkGraph handle a depth-tier (.rs) repo end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.rs"), RUST);

  await buildGraph(dir, { reuse: false });
  const g = readGraph(wiringPath(contextDirFor(dir)));
  assert.ok(g, "graph built");
  const rust = g!.nodes.filter((n) => n.path.endsWith(".rs") && n.kind !== "file");
  assert.ok(rust.length >= 4, `indexed the rust defs (got ${rust.length})`);
  assert.ok(rust.every((n) => n.origin === "ast"), "rust nodes are depth-tier");
  assert.ok(g!.edges.some((e) => e.relation === "calls"), "rust call edges resolved");

  // check must agree with build — the file is parsed identically on both paths,
  // so a fresh graph reads as in-sync, not perpetually stale.
  const chk = await checkGraph(dir);
  assert.equal(chk.ok, true, `check OK on a depth-tier repo (added=${chk.added}, removed=${chk.removed})`);
});

// #134: Dart is a breadth-tier language with no vendored tags.scm, so the
// node-kind walker minted class_body / locals and skipped top-level functions.
// Issue fixture — top-level const + functions + a method that calls a top-level fn.
const DART = `const int kThreshold = 3;

bool isReady(int count) => count >= kThreshold;

String describe(int count) {
  final label = isReady(count) ? 'ready' : 'waiting';
  return label;
}

class Counter {
  int value = 0;

  bool ready() => isReady(value);
}
`;

test("genericLangOf routes .dart to the breadth tier", () => {
  assert.equal(genericLangOf("lib/example.dart")?.name, "dart");
});

test("Dart top-level functions/consts become symbols; call edges resolve; body locals stay out (#134)", async () => {
  await warmGenericGrammars(["dart"]);
  assert.ok(isWarm("dart"), "dart grammar should warm");
  const { nodes, rawEdges } = extractGeneric("lib/example.dart", DART, "dart");
  const symbols = nodes.filter((n) => n.kind !== "file");
  const byName = new Map(symbols.map((n) => [n.name, n]));

  assert.equal(byName.get("isReady")?.kind, "function", "isReady is a top-level function");
  assert.equal(byName.get("describe")?.kind, "function", "describe is a top-level function");
  assert.equal(byName.get("kThreshold")?.kind, "constant", "kThreshold is a top-level const");
  assert.equal(byName.get("Counter")?.kind, "class");
  assert.equal(byName.get("ready")?.kind, "method", "Counter.ready is a method");

  assert.ok(!symbols.some((n) => n.name === "label"), "function-body local `label` is not a symbol");
  assert.ok(
    !symbols.some((n) => n.kind === "class" && n.name === "int"),
    `no bogus class int (got ${symbols.filter((n) => n.kind === "class").map((n) => n.name).join(", ")})`,
  );

  const edges = resolveEdges(nodes, rawEdges);
  const calls = edges
    .filter((e) => e.relation === "calls")
    .map((e) => `${e.source.split("#")[1]}→${e.target.split("#")[1]}`);
  assert.ok(calls.includes("describe→isReady"), `describe → isReady (got ${calls.join(", ")})`);
  assert.ok(calls.includes("ready→isReady"), `Counter.ready → isReady (got ${calls.join(", ")})`);
});

test("Dart file-level skeleton lists the API, not function-body locals (#134)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-dart-"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "example.dart"), DART);

  await buildGraph(dir, { reuse: false });
  const r = skeleton(dir, "lib/example.dart");
  const names = r.entries.map((e) => e.name);
  for (const want of ["isReady", "describe", "kThreshold", "Counter", "ready"]) {
    assert.ok(names.includes(want), `skeleton includes ${want} (got ${names.join(", ")})`);
  }
  assert.ok(!names.includes("label"), "skeleton omits function-body local `label`");
  assert.ok(
    !r.entries.some((e) => e.kind === "class" && e.name === "int"),
    "skeleton has no bogus class int",
  );
});

// #139: tree-sitter-wasm 1.1.4's PHP grammar throws `memory access out of bounds`
// on heredoc/nowdoc, and extractGeneric swallows that into a file-only result.
// PHP is depth-tier now (.php is not claimed by the breadth registry), so this
// loads the wasm grammar directly — the same parse the breadth path used when
// the issue landed.
// v1.1.6 is the first release that parses these without crashing.
const PHP_HEREDOC = `<?php
namespace App;
class WithHeredoc {
    public function sql(): string {
        return <<<SQL
            SELECT 1
            SQL;
    }
    public function other(): int { return 2; }
}
`;

const PHP_NOWDOC = `<?php
namespace App;
class WithNowdoc {
    public function sql(): string {
        return <<<'SQL'
            SELECT 1
            SQL;
    }
    public function other(): int { return 2; }
}
`;

function namedOfType(root: TsNode, type: string): string[] {
  const names: string[] = [];
  const visit = (n: TsNode): void => {
    if (n.type === type) {
      const name = n.childForFieldName?.("name")?.text;
      if (name) names.push(name);
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      const c = n.namedChild?.(i);
      if (c) visit(c);
    }
  };
  visit(root);
  return names;
}

async function assertPhpWasmExtractsClassAndMethods(source: string, className: string, label: string): Promise<void> {
  const language = await loadWasmLanguage("php");
  assert.ok(language, "tree-sitter-wasm must ship a php grammar");
  const root = parseWasm(language, source);
  assert.ok(root, `${label}: PHP wasm parse must not crash (1.1.4 threw on heredoc/nowdoc)`);
  const classes = namedOfType(root, "class_declaration");
  const methods = namedOfType(root, "method_declaration");
  assert.ok(classes.includes(className), `${label}: expected class ${className}, got: ${classes.join(", ") || "(none)"}`);
  assert.ok(methods.includes("sql"), `${label}: expected method sql, got: ${methods.join(", ") || "(none)"}`);
  assert.ok(methods.includes("other"), `${label}: expected method other, got: ${methods.join(", ") || "(none)"}`);
}

test("PHP wasm grammar extracts class + methods from a heredoc file (#139)", async () => {
  await assertPhpWasmExtractsClassAndMethods(PHP_HEREDOC, "WithHeredoc", "heredoc");
});

test("PHP wasm grammar extracts class + methods from a nowdoc file (#139)", async () => {
  await assertPhpWasmExtractsClassAndMethods(PHP_NOWDOC, "WithNowdoc", "nowdoc");
});

/**
 * A grammar whose parse throws (the tree-sitter-wasm PHP grammar did, on
 * heredocs — #139) must surface as a per-file build error, not be swallowed
 * into a silently symbol-less file that the extract cache then replays as a
 * clean parse. The real crash is heap-state dependent, so a deterministically
 * throwing fake grammar is swapped in via the test seam instead.
 */
const THROWING_GRAMMAR = {
  // web-tree-sitter's setLanguage() inspects the language object, so any
  // property access blowing up makes extractGeneric's try block throw exactly
  // like a crashing wasm scanner does.
  language: new Proxy({}, { get(): never { throw new Error("memory access out of bounds (fake)"); } }),
  query: null,
};

test("extractGeneric rethrows a throwing grammar with the language named (#139)", async () => {
  await warmGenericGrammars(["dart"]); // initialises web-tree-sitter
  const prev = swapGrammarForTest("dart", THROWING_GRAMMAR);
  try {
    assert.throws(
      () => extractGeneric("src/main.dart", "void f() {}\n", "dart"),
      (err: unknown): boolean => {
        assert.ok(err instanceof Error, "throws an Error");
        assert.match(err.message, /^dart grammar threw: /, "names the language");
        assert.match(err.message, /memory access out of bounds/, "keeps the original message");
        return true;
      },
    );
  } finally {
    swapGrammarForTest("dart", prev);
  }
});

test("a throwing grammar is a per-file build error, cached as a failure (#139)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-throwing-grammar-"));
  writeFileSync(join(dir, "main.dart"), "void f() {}\n");
  await warmGenericGrammars(["dart"]); // so buildGraph's own warm call is a no-op
  const prev = swapGrammarForTest("dart", THROWING_GRAMMAR);
  try {
    const first = await buildGraph(dir, { reuse: false });
    assert.equal(first.errors.length, 1, `one build error (got: ${first.errors.join("; ")})`);
    assert.match(first.errors[0], /main\.dart: parse failed/);
    assert.match(first.errors[0], /dart grammar threw: memory access out of bounds/);
    const g = readGraph(wiringPath(contextDirFor(dir)));
    assert.ok(g, "graph built");
    assert.ok(!g!.nodes.some((n) => n.path === "main.dart"), "failed file has no file node");

    // The extract cache must remember the failure, not an empty success: an
    // incremental rebuild of the unchanged file replays the error.
    const second = await buildGraph(dir, { reuse: true });
    assert.equal(second.parsed, 0, "unchanged file is not re-parsed");
    assert.equal(second.errors.length, 1, `error replayed (got: ${second.errors.join("; ")})`);
    assert.match(second.errors[0], /dart grammar threw/);
  } finally {
    swapGrammarForTest("dart", prev);
  }
});
