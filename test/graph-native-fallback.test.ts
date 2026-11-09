/**
 * A depth grammar that won't load costs its own language, never the command.
 *
 * The depth tier parses on WASM files the package ships (depth-parser.ts), so a
 * grammar fails to load only when an install is broken. The native addons it used
 * to need failed far more often: npm 12 stops running dependency install scripts,
 * and `tree-sitter-kotlin` ships no prebuilt binary, so after `npm install -g` its
 * addon was simply absent. Either way the language's files go to the breadth
 * tier's stand-in and the build says so in one line.
 *
 * Simulated through depth-parser.ts's seams: a .wasm read that throws, and, for the
 * native backend the parity check still runs, a require that throws the way
 * node-gyp-build does.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { readDepthWasm, setDepthParsersForTest } from "../src/graph/depth-parser.js";
import type { Language } from "../src/graph/extract.js";
import { missingNativePackages, nativeFallbackNotice, nativeReady, realNativeRequire, setNativeRequireForTest } from "../src/graph/native.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { tmpRepo } from "./helpers.js";

const KOTLIN = [
  "package demo",
  "",
  "class Greeter(val name: String) {",
  '    fun greet(): String = "hi " + name',
  "}",
  "",
  "fun helper(x: Int): Int = x + 1",
  "",
  "fun main() {",
  '    val g = Greeter("a")',
  "    println(g.greet())",
  "    helper(2)",
  "}",
  "",
].join("\n");

const PY = ["class Store:", "    def load(self):", "        return fetch()", "", "def fetch():", "    return 1", ""].join("\n");

const TS = ["export function add(a: number, b: number): number {", "  return a + b;", "}", "export function twice(a: number): number {", "  return add(a, a);", "}", ""].join("\n");

function repo(): string {
  const d = tmpRepo("depth-fallback");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), TS);
  writeFileSync(join(d, "src", "store.py"), PY);
  writeFileSync(join(d, "src", "Main.kt"), KOTLIN);
  return d;
}

/** A .wasm read that fails for `broken`, as a truncated install would, and records
 * every language asked for. */
function wasmFailing(broken: Language[], asked: Language[] = []): (lang: Language) => Uint8Array {
  return (lang) => {
    asked.push(lang);
    if (broken.includes(lang)) throw new Error(`ENOENT: no such file, open 'dist/vendor/grammars/tree-sitter-${lang}.wasm'`);
    return readDepthWasm(lang);
  };
}

/** A require that fails for `missing`, exactly as node-gyp-build does. */
function requireFailing(missing: string[]): (id: string) => unknown {
  return (id) => {
    if (missing.includes(id)) {
      throw new Error(`No native build was found for platform=${process.platform} arch=${process.arch} loaded from node_modules/${id}`);
    }
    return realNativeRequire(id);
  };
}

afterEach(() => {
  setDepthParsersForTest({ backend: null, readWasm: null });
  setNativeRequireForTest(null);
});

function graphOf(contextDir: string) {
  return readGraph(wiringPath(contextDir))!;
}

test("every grammar loads: depth parse everywhere, and no notice", async () => {
  const r = await buildGraph(repo());
  assert.deepEqual(r.errors, []);
  assert.equal(r.nativeFallback, undefined);
  assert.equal(nativeFallbackNotice(r.nativeFallback, "@trailhq/trail"), null);
  assert.deepEqual(r.languages, ["kotlin", "python", "typescript"]);
  assert.ok(graphOf(r.contextDir).nodes.filter((n) => n.kind !== "file").every((n) => n.origin === "ast"));
});

test("a kotlin grammar that won't load: kotlin goes to the stand-in, the build completes, the rest stay on the depth tier", async () => {
  setDepthParsersForTest({ readWasm: wasmFailing(["kotlin"]) });
  const dir = repo();
  const r = await buildGraph(dir);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.languages, ["kotlin", "python", "typescript"]);
  assert.deepEqual(r.nativeFallback, { languages: ["kotlin"], packages: [] });

  const g = graphOf(r.contextDir);
  const kt = g.nodes.filter((n) => n.path === "src/Main.kt" && n.kind !== "file");
  const names = kt.map((n) => n.name).sort();
  for (const want of ["Greeter", "greet", "helper", "main"]) assert.ok(names.includes(want), `kotlin ${want} missing: ${names}`);
  assert.ok(kt.every((n) => n.origin === "generic"), "kotlin symbols come from the stand-in");
  // The vendored kotlin tags query carries calls, so `graft callers helper` works.
  assert.ok(
    g.edges.some((e) => e.relation === "calls" && e.source === "src/Main.kt#main" && e.target === "src/Main.kt#helper"),
    "main → helper call edge",
  );
  for (const path of ["src/math.ts", "src/store.py"]) {
    const syms = g.nodes.filter((n) => n.path === path && n.kind !== "file");
    assert.ok(syms.length > 0 && syms.every((n) => n.origin === "ast"), `${path} stays on the depth tier`);
  }

  // `graft check` dispatches the same way, so the fallback graph reads as in sync.
  const c = await checkGraph(dir);
  assert.deepEqual([c.added, c.removed, c.changed], [[], [], []]);
});

test("the notice names only the grammar that failed, and reinstalling fixes it", async () => {
  setDepthParsersForTest({ readWasm: wasmFailing(["kotlin"]) });
  const r = await buildGraph(repo());
  assert.equal(
    nativeFallbackNotice(r.nativeFallback, "@trailhq/trail"),
    "⚠ kotlin: basic parsing only, its parser didn't load. To fix: npm install -g @trailhq/trail",
  );
  assert.match(nativeFallbackNotice(r.nativeFallback, "@nanonets/graft")!, / @nanonets\/graft$/);
});

test("a repo without kotlin never reads its grammar", async () => {
  const asked: Language[] = [];
  setDepthParsersForTest({ readWasm: wasmFailing([], asked) });
  const d = tmpRepo("depth-lazy");
  writeFileSync(join(d, "math.ts"), TS);
  const r = await buildGraph(d);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(asked, ["typescript"]);
});

test("no depth grammar loads at all: every depth language falls back, nothing crashes", async () => {
  setDepthParsersForTest({ readWasm: wasmFailing(["kotlin", "python", "typescript"]) });
  const r = await buildGraph(repo());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.nativeFallback, { languages: ["kotlin", "python", "typescript"], packages: [] });
  const names = new Set(graphOf(r.contextDir).nodes.filter((n) => n.kind !== "file").map((n) => n.name));
  // The bundle's own tags queries stand in for typescript and python.
  for (const want of ["add", "twice", "Store", "load", "fetch", "helper"]) assert.ok(names.has(want), `${want} missing`);
  assert.equal(
    nativeFallbackNotice(r.nativeFallback, "@trailhq/trail"),
    "⚠ kotlin, python, typescript: basic parsing only, their parsers didn't load. To fix: npm install -g @trailhq/trail",
  );
});

test("a stand-in parse is not replayed once the grammar loads again", async () => {
  const dir = repo();
  setDepthParsersForTest({ readWasm: wasmFailing(["kotlin"]) });
  await buildGraph(dir);
  // The reinstall the notice asks for: same bytes, the grammar now loads.
  setDepthParsersForTest({ readWasm: null });
  const r = await buildGraph(dir);
  assert.equal(r.nativeFallback, undefined);
  assert.equal(r.parsed, 1, "only the kotlin file is parsed again");
  const kt = graphOf(r.contextDir).nodes.filter((n) => n.path === "src/Main.kt" && n.kind !== "file");
  assert.ok(kt.length > 0 && kt.every((n) => n.origin === "ast"), "kotlin is back on the depth tier");
});

test("a .vue file's script falls back with its language, spans still on the .vue line", async () => {
  setDepthParsersForTest({ readWasm: wasmFailing(["typescript"]) });
  const d = tmpRepo("depth-vue");
  writeFileSync(
    join(d, "Card.vue"),
    ["<template>", "  <p>hi</p>", "</template>", "", '<script lang="ts">', "export function shout(what: string) {", "  return what.toUpperCase();", "}", "</script>", ""].join("\n"),
  );
  const r = await buildGraph(d);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.nativeFallback, { languages: ["typescript"], packages: [] });
  const shout = graphOf(r.contextDir).nodes.find((n) => n.name === "shout");
  assert.ok(shout, "the script's function is still indexed");
  assert.equal(shout.span, "L6-L8");
});

test("on the native backend, a missing addon names the package whose install script builds it", async () => {
  setDepthParsersForTest({ backend: "native" });
  setNativeRequireForTest(requireFailing(["tree-sitter-kotlin"]));
  const r = await buildGraph(repo());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.nativeFallback, { languages: ["kotlin"], packages: ["tree-sitter-kotlin"] });
  assert.equal(
    nativeFallbackNotice(r.nativeFallback, "@trailhq/trail"),
    "⚠ kotlin: basic parsing only, its parser didn't load. To fix: npm install -g --allow-scripts=tree-sitter-kotlin @trailhq/trail",
  );
  const py = graphOf(r.contextDir).nodes.filter((n) => n.path === "src/store.py" && n.kind !== "file");
  assert.ok(py.length > 0 && py.every((n) => n.origin === "ast"), "python stays on its addon");
});

test("the allow-scripts name is the real package, not the npm alias", () => {
  setNativeRequireForTest(requireFailing(["tree-sitter-r"]));
  assert.equal(nativeReady("r"), false);
  assert.deepEqual(missingNativePackages(["r", "python"]), ["@davisvaughan/tree-sitter-r"]);
});
