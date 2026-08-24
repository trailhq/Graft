/**
 * #119 — when native tree-sitter addons are missing (linux/arm64 has no
 * prebuild for tree-sitter@0.21.1), depth-tier files still extract via WASM.
 *
 * Native-available (this darwin CI) is the control: extractFile without
 * `{ wasm: true }` must keep origin "ast". The fallback is exercised by
 * injecting a throwing require and by extractFile(..., { wasm: true }).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractFile,
  loadNativeGrammars,
  NATIVE_FALLBACK_WARNING,
  nativeFallbackWarning,
} from "../src/graph/extract.js";
import { genericLangOf, isWarm, warmGenericGrammars } from "../src/graph/generic.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";

const TS = `export function hello() {
  return world();
}
function world() {
  return 1;
}
`;

const PY = `def hello():
    return world()
def world():
    return 1
`;

test("loadNativeGrammars: a missing linux/arm64 prebuild yields empty grammars", () => {
  const boom = (id: string): unknown => {
    throw new Error(
      `No native build was found for platform=linux arch=arm64 runtime=node abi=127 uv=1 libc=glibc (${id})`,
    );
  };
  const loaded = loadNativeGrammars(boom);
  assert.equal(loaded.Parser, null);
  assert.equal(Object.keys(loaded.grammars).length, 0);
  assert.match(loaded.error ?? "", /linux/);
  assert.match(loaded.error ?? "", /arm64/);
  assert.equal(
    NATIVE_FALLBACK_WARNING,
    "native parser unavailable — falling back to WASM (reduced binding fidelity)",
  );
});

test("genericLangOf still does not claim depth extensions", () => {
  assert.equal(genericLangOf("src/app.ts"), null);
  assert.equal(genericLangOf("src/main.py"), null);
  assert.equal(genericLangOf("cmd/main.go"), null);
});

test("extractFile wasm fallback still emits nodes for a TS function", async () => {
  await warmGenericGrammars(["typescript"]);
  assert.ok(isWarm("typescript"), "typescript wasm grammar should warm");
  const { nodes, rawEdges } = extractFile("a.ts", TS, "typescript", { wasm: true });
  const named = nodes.filter((n) => n.kind !== "file");
  assert.ok(
    named.some((n) => n.name === "hello"),
    `expected hello, got ${named.map((n) => n.name).join(",")}`,
  );
  assert.ok(
    named.every((n) => n.origin === "generic"),
    "WASM path is the breadth extractor (no bindings/recvType)",
  );
  const calls = rawEdges.filter((e) => e.relation === "calls");
  assert.ok(
    calls.some((e) => e.source.endsWith("#hello") && e.name === "world"),
    `expected hello→world call edge, got ${JSON.stringify(calls)}`,
  );
});

test("extractFile wasm fallback still emits nodes for a Python function", async () => {
  await warmGenericGrammars(["python"]);
  assert.ok(isWarm("python"), "python wasm grammar should warm");
  const { nodes } = extractFile("a.py", PY, "python", { wasm: true });
  const named = nodes.filter((n) => n.kind !== "file");
  assert.ok(
    named.some((n) => n.name === "hello"),
    `expected hello, got ${named.map((n) => n.name).join(",")}`,
  );
  assert.ok(named.every((n) => n.origin === "generic"));
});

test("extractFile default path on this platform stays native (origin ast)", () => {
  const { nodes, rawEdges } = extractFile("a.ts", TS, "typescript");
  const hello = nodes.find((n) => n.name === "hello");
  assert.ok(hello);
  assert.equal(hello?.origin, "ast");
  assert.ok(rawEdges.some((e) => e.relation === "calls" && e.name === "world"));
  assert.equal(nativeFallbackWarning(), null, "darwin/linux-x64 native path must not warn");
});

test("native build + check stay in sync and emit no fallback warning", async () => {
  const d = mkdtempSync(join(tmpdir(), "graft-119-"));
  writeFileSync(join(d, "a.ts"), TS);
  const g = await buildGraph(d, { reuse: false });
  assert.equal(g.errors.length, 0);
  assert.deepEqual(g.warnings, []);
  const check = await checkGraph(d);
  assert.equal(check.missing, false);
  assert.equal(check.ok, true, `check drift: added=${check.added} removed=${check.removed} changed=${check.changed}`);
});
