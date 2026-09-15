import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeEnv, tmpRepo } from "./helpers.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const extractUrl = new URL("../src/graph/extract.ts", import.meta.url).href;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Block native loads in a fresh process without changing the installed packages.
// This reproduces a missing binding even on machines with working native builds.
function probe(args: string[], allowed: string[] = []): string {
  const home = tmpRepo("native-home");
  try {
    const preload = `
      import { sep } from "node:path";
      const allowed = new Set(${JSON.stringify(allowed)});
      const dlopen = process.dlopen;
      process.dlopen = function (...args) {
        const filename = args[1];
        const parts = filename.split(sep);
        const packageName = parts[parts.lastIndexOf("node_modules") + 1];
        if (!allowed.has(packageName)) {
          throw new Error("No native build was found for " + packageName);
        }
        return Reflect.apply(dlopen, this, args);
      };
    `;
    const run = spawnSync(process.execPath, [
      "--import", "tsx",
      "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      ...args,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...homeEnv(home), DO_NOT_TRACK: "1", CI: "1" },
    });
    assert.equal(run.status, 0, `native loading probe failed:\n${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
    return run.stdout;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("CLI version works without any native bindings", () => {
  const output = probe([cliPath, "--version"]);
  assert.equal(output.trim(), version);
});

test("language metadata does not load native bindings", () => {
  probe(["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const { depthExtensions, languageOf, languageLabelOf } = await import(${JSON.stringify(extractUrl)});
    assert.equal(languageOf("Main.kt"), "kotlin");
    assert.equal(languageLabelOf("index.mjs"), "javascript");
    assert.ok(depthExtensions().includes(".swift"));
  `]);
});

test("CLI builds TypeScript without unrelated native bindings", () => {
  const dir = tmpRepo("native-build");
  try {
    writeFileSync(join(dir, "index.ts"), "export function greet(): string { return 'hello'; }\n");
    const output = probe([cliPath, "build", dir], ["tree-sitter", "tree-sitter-typescript"]);
    assert.match(output, /wiring:/);

    probe(["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const { readGraph, wiringPath } = await import(${JSON.stringify(new URL("../src/graph/write.ts", import.meta.url).href)});
      const graph = readGraph(wiringPath(${JSON.stringify(join(dir, "graft"))}));
      assert.ok(graph?.nodes.some((node) => node.name === "greet" && node.kind === "function"));
    `]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a required missing binding throws without poisoning other languages", () => {
  probe(["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const { extractFile } = await import(${JSON.stringify(extractUrl)});
    assert.throws(
      () => extractFile("Main.kt", "fun main() {}", "kotlin"),
      /No native build was found/,
    );
    const result = extractFile("index.ts", "export function greet() {}", "typescript");
    assert.ok(result.nodes.some((node) => node.name === "greet"));
  `], ["tree-sitter", "tree-sitter-typescript"]);
});

test("an available Kotlin binding still extracts definitions", () => {
  probe(["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const { extractFile } = await import(${JSON.stringify(extractUrl)});
    const result = extractFile("Main.kt", "fun greet(): String { return \\"hello\\" }", "kotlin");
    assert.ok(result.nodes.some((node) => node.name === "greet" && node.kind === "function"));
  `], ["tree-sitter", "tree-sitter-kotlin"]);
});
