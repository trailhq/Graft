/**
 * The depth tier's WASM grammars are the ones the native addons were built from,
 * on the core they were built with, and the build ships every one of them.
 *
 * Bumping a grammar package without rebuilding its .wasm, or the depth runtime
 * without re-running the parity check, would change parse trees under extract.ts
 * with nothing failing. These tests are what fails instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPTH_WASM, NATIVE_ONLY, depthReady, readDepthWasm, warmDepthGrammars } from "../src/graph/depth-parser.js";
import { extractFile, type Language } from "../src/graph/extract.js";
import { GRAMMARS } from "../scripts/vendor-grammars.mjs";
import { sourceHash } from "../scripts/build-grammar-wasm.mjs";
import { tmpRepo } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const LANGS = Object.keys(DEPTH_WASM) as Language[];
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

test("every depth .wasm is the one the parity check passed with (grammars.json)", () => {
  const manifest = JSON.parse(readFileSync(join(root, "src", "graph", "grammars", "grammars.json"), "utf8")) as Record<
    string,
    { module: string; version: string; sha256: string; source?: string }
  >;
  assert.deepEqual(Object.keys(manifest).sort(), [...new Set(LANGS.map((l) => DEPTH_WASM[l].file))].sort());
  for (const lang of LANGS) {
    const { module, file, built } = DEPTH_WASM[lang];
    const entry = manifest[file]!;
    const dir = dirname(require.resolve(`${module}/package.json`));
    const { version } = require(`${module}/package.json`) as { version: string };
    const why = `${file}: ${module} changed. Run node scripts/build-grammar-wasm.mjs, then test/depth-parity.ts on real repos`;
    assert.equal(entry.module, module, why);
    assert.equal(version, entry.version, why);
    assert.equal(sha256(readDepthWasm(lang, join(root, "nowhere"))), entry.sha256, why);
    if (built) assert.equal(sourceHash(dir), entry.source, why);
  }
});

test("the depth runtime is web-tree-sitter 0.22.2, the core the parity check ran on", () => {
  assert.equal(pkg.dependencies["web-tree-sitter-depth"], "npm:web-tree-sitter@0.22.2");
  assert.equal((require("web-tree-sitter-depth/package.json") as { version: string }).version, "0.22.2");
});

test("grammar packages and the native addon are dev dependencies only", () => {
  for (const name of ["tree-sitter", ...new Set(LANGS.map((l) => DEPTH_WASM[l].module))]) {
    assert.equal(pkg.dependencies[name], undefined, `${name} is a runtime dependency`);
    assert.ok(pkg.devDependencies[name], `${name} is not a dev dependency`);
  }
  assert.equal(NATIVE_ONLY.size, 0, "a NATIVE_ONLY language needs its addon as a dependency again");
});

test("every depth grammar loads and extracts on WASM", async () => {
  await warmDepthGrammars(LANGS);
  for (const lang of LANGS) {
    assert.ok(depthReady(lang), `${lang} did not load`);
    const { nodes } = extractFile(`x.${lang}`, "", lang);
    assert.equal(nodes[0]?.kind, "file", lang);
  }
});

test("the build vendors every depth grammar, byte for byte, with its license", () => {
  const out = tmpRepo("vendor");
  const run = spawnSync(process.execPath, [join(root, "scripts", "vendor-grammars.mjs"), out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    GRAMMARS.flatMap((g) => g.files).sort(),
    [...new Set(LANGS.map((l) => DEPTH_WASM[l].file))].sort(),
    "vendor-grammars.mjs and DEPTH_WASM name the same files",
  );
  const dir = join(out, "grammars");
  for (const lang of LANGS) {
    assert.deepEqual(readDepthWasm(lang, dir), readDepthWasm(lang, join(out, "nowhere")), `${lang} differs from its source`);
    assert.ok(existsSync(join(dir, `${DEPTH_WASM[lang].module}.LICENSE`)), `${lang} license`);
  }
});
