/**
 * Language packs: a language graft never heard of, loaded from `.graft/langs/<name>/`
 * in the repo or `~/.graft/langs/<name>/` at home, contributing exactly what a built-in
 * breadth row does — extensions, grammar, tags query, optionally an LSP server row.
 *
 * The fixture pack "moon" reuses the bundled Lua grammar and graft's own lua.scm under
 * a new name and extension, so the tests prove the pack plumbing (discovery, registry,
 * walk, `-e` validation, LSP pick) without needing a grammar of their own — and prove
 * the refusals: a pack can add a language, never take one away.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadLanguagePacks, packDirs, resetLanguagePacksForTest } from "../src/graph/packs.js";
import { genericLangOf, resetGenericLangsForTest, swapGrammarForTest } from "../src/graph/generic.js";
import { supportedExtensions, unsupportedExtensions } from "../src/graph/source-files.js";
import { pickServer, resetLspServersForTest } from "../src/graph/lsp/registry.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";

const require = createRequire(import.meta.url);
const LUA_WASM = require.resolve("tree-sitter-wasm/lua/tree-sitter-lua.wasm");
const LUA_TAGS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "graph", "queries", "lua.scm");
const LUA_SRC = "local function helper()\n  return 1\nend\n\nlocal function run()\n  return helper()\nend\n";

/** Write a pack dir: manifest + (by default) the Lua grammar and query under the pack's name. */
function writePack(base: string, name: string, manifest: object, files: { grammar?: boolean; tags?: boolean } = {}): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  if (files.grammar !== false) copyFileSync(LUA_WASM, join(dir, `tree-sitter-${name}.wasm`));
  if (files.tags !== false) copyFileSync(LUA_TAGS, join(dir, "tags.scm"));
  writeFileSync(join(dir, "pack.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return dir;
}
const manifest = (name: string, ext: string, extra: object = {}) =>
  ({ name, extensions: [ext], grammar: `tree-sitter-${name}.wasm`, tags: "tags.scm", ...extra });
const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `graft-packs-${tag}-`));
/** A repo with its pack dir, and an empty home so the developer's own packs stay out. */
function repoAndHome(): { repo: string; home: string; langs: string } {
  const repo = tmp("repo"), home = tmp("home");
  const langs = packDirs(repo, home)[0];
  mkdirSync(langs, { recursive: true });
  return { repo, home, langs };
}

beforeEach(() => {
  resetLanguagePacksForTest();
  resetGenericLangsForTest();
  resetLspServersForTest();
  for (const n of ["moon", "sun", "star"]) swapGrammarForTest(n, null);
});

test("a repo-level pack adds a language: discovery, extension routing, -e validation, a built graph", async () => {
  const { repo, home, langs } = repoAndHome();
  writePack(langs, "moon", manifest("moon", ".moon"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.moon"), LUA_SRC);

  const warnings: string[] = [];
  const r = loadLanguagePacks(repo, { home, warn: (m) => warnings.push(m) });
  assert.deepEqual(r, { loaded: ["moon"], skipped: [] });
  assert.deepEqual(warnings, []);
  assert.equal(genericLangOf("src/a.moon")?.name, "moon", "the pack's extension routes to the pack");
  assert.equal(genericLangOf("src/a.moon")?.wasmPath, join(langs, "moon", "tree-sitter-moon.wasm"));
  assert.ok(supportedExtensions().includes(".moon"), "-e knows the pack's extension");
  assert.deepEqual(unsupportedExtensions([".moon", ".nope"], repo), [".nope"]);

  // The build's own walk loads packs too (idempotently — no second warning), and the
  // pack's files come out as breadth-tier nodes with resolved calls.
  await buildGraph(repo, { reuse: false });
  const g = readGraph(wiringPath(contextDirFor(repo)));
  const defs = g!.nodes.filter((n) => n.path === "src/a.moon" && n.kind !== "file");
  assert.deepEqual(defs.map((n) => `${n.kind}:${n.name}`).sort(), ["function:helper", "function:run"]);
  assert.ok(defs.every((n) => n.origin === "generic"));
  assert.ok(g!.edges.some((e) => e.relation === "calls" && e.source === "src/a.moon#run" && e.target === "src/a.moon#helper"), "run → helper resolved");
  assert.ok(g!.meta.languages.includes("moon"), `banner lists the pack language (got ${g!.meta.languages.join(", ")})`);
});

test("a pack can add a language but never take one away: every refusal is one warning, nothing else changes", () => {
  const { repo, home, langs } = repoAndHome();
  writePack(langs, "a_builtin_ext", manifest("a_builtin_ext", ".lua")); // breadth tier owns .lua
  writePack(langs, "a_depth_ext", manifest("a_depth_ext", ".ts")); // depth tier owns .ts
  writePack(langs, "rust", manifest("rust", ".rsx")); // a built-in name
  writePack(langs, "no_grammar", manifest("no_grammar", ".ng"), { grammar: false });
  writePack(langs, "no_tags", manifest("no_tags", ".nt"), { tags: false });
  writePack(langs, "bad_json", "{ not json", {});
  writePack(langs, "Bad-Name", manifest("Bad-Name", ".bn"));
  writePack(langs, "bad_lsp", manifest("bad_lsp", ".bl", { lsp: { args: [] } }));

  const warnings: string[] = [];
  const r = loadLanguagePacks(repo, { home, warn: (m) => warnings.push(m) });
  assert.deepEqual(r.loaded, []);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.dir.split("/").pop(), s.reason]));
  assert.match(reasons.a_builtin_ext, /\.lua is already indexed as lua/);
  assert.match(reasons.a_depth_ext, /\.ts is already indexed as typescript/);
  assert.match(reasons.rust, /built-in language/);
  assert.match(reasons.no_grammar, /grammar not found/);
  assert.match(reasons.no_tags, /tags query not found/);
  assert.match(reasons.bad_json, /not valid JSON/);
  assert.match(reasons["Bad-Name"], /"name" must match/);
  assert.match(reasons.bad_lsp, /"lsp" must be/);
  assert.equal(warnings.length, r.skipped.length, "exactly one stderr line per refused pack");
  // and the built-ins are exactly as they were
  assert.equal(genericLangOf("x.lua")?.name, "lua");
  assert.equal(genericLangOf("x.rsx"), null);
  assert.equal(genericLangOf("x.ng"), null);
});

test("a home-level pack applies to every repo; a repo-level pack of the same name wins", () => {
  const { repo, home, langs } = repoAndHome();
  const homeLangs = packDirs(repo, home)[1];
  writePack(homeLangs, "star", manifest("star", ".star")); // home only
  writePack(homeLangs, "sun", manifest("sun", ".sun_home")); // both — the repo's copy must win
  writePack(langs, "sun", manifest("sun", ".sun"));

  const r = loadLanguagePacks(repo, { home, warn: () => {} });
  assert.deepEqual(r.loaded, ["sun", "star"], "repo packs first, then home");
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /already loaded/);
  assert.equal(genericLangOf("x.sun")?.name, "sun");
  assert.equal(genericLangOf("x.sun_home"), null, "the losing home copy contributed nothing");
  assert.equal(genericLangOf("x.star")?.name, "star");

  // a second call for the same root is a no-op — no re-registration, no warnings
  const again = loadLanguagePacks(repo, { home, warn: (m) => assert.fail(m) });
  assert.deepEqual(again, { loaded: [], skipped: [] });
});

test("a pack's lsp row is picked for its language and shadows nothing built in", () => {
  const { repo, home, langs } = repoAndHome();
  // `node` is on PATH in any environment that runs this suite.
  writePack(langs, "moon", manifest("moon", ".moon", { lsp: { command: "node", args: ["-e", "0"] } }));
  loadLanguagePacks(repo, { home, warn: () => {} });
  const picked = pickServer(new Set(["moon"]));
  assert.ok(picked, "the pack's server is eligible");
  assert.equal(picked!.languageId, "moon", "languageId defaults to the pack name");
  assert.deepEqual(picked!.args, ["-e", "0"]);
  assert.ok(picked!.command.endsWith("node") && picked!.command.startsWith("/"), "resolved to an absolute path");
  assert.notEqual(pickServer(new Set(["rust"]))?.languageId, "moon", "a pack row never answers for another language");
});
