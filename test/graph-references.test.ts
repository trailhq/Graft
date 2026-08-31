/**
 * Regression coverage for issue #34: imported functions used as values must
 * remain visible to `callers`, but as weaker `references` edges rather than
 * being mislabeled as direct calls.
 *
 * …and for issue #116, at the bottom: the same rules have to hold in a file
 * big enough that tree-sitter stops handing back the same JS wrapper object
 * for a node it already materialized.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../src/graph/build.js";
import { callersOf } from "../src/graph/traverse.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { tmpRepo } from "./helpers.js";

test("callers includes an imported function passed as a value (#34)", async () => {
  const root = tmpRepo("graft-references-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "gate.ts"),
    ["export function isActive(): boolean {", "  return true;", "}", ""].join("\n"),
  );
  writeFileSync(
    join(root, "src", "direct.ts"),
    [
      'import { isActive } from "./gate.js";',
      "export function callsItDirectly(): boolean {",
      "  return isActive();",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "consumer.ts"),
    [
      'import { isActive } from "./gate.js";',
      "interface Opts { _isActive?: typeof isActive }",
      "export function run(opts: Opts = {}): boolean {",
      "  const check = opts._isActive ?? isActive;",
      "  return check();",
      "}",
      "",
    ].join("\n"),
  );

  await buildGraph(root, { reuse: false });
  const graph = readGraph(wiringPath(join(root, "graft")))!;
  const target = graph.nodes.find((node) => node.id === "src/gate.ts#isActive");
  assert.ok(target, "fixture target was not indexed");

  const hits = callersOf(graph, target);
  assert.deepEqual(
    hits.map(({ id, relation }) => ({ id, relation })).sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "src/consumer.ts#Opts", relation: "references" },
      { id: "src/direct.ts#callsItDirectly", relation: "calls" },
      { id: "src/consumer.ts#run", relation: "references" },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
});

test("aliased named imports resolve references to the exported symbol", async () => {
  const root = tmpRepo("graft-reference-alias-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "gate.ts"), "export function isActive(): boolean { return true; }\n");
  writeFileSync(
    join(root, "src", "consumer.ts"),
    [
      'import { isActive as defaultCheck } from "./gate.js";',
      "export function choose(): typeof defaultCheck {",
      "  return defaultCheck;",
      "}",
      "",
    ].join("\n"),
  );

  await buildGraph(root, { reuse: false });
  const graph = readGraph(wiringPath(join(root, "graft")))!;
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.source === "src/consumer.ts#choose" &&
        edge.target === "src/gate.ts#isActive" &&
        edge.relation === "references",
    ),
  );
});

/**
 * Regression for #116. node-tree-sitter may rematerialize SyntaxNode wrappers
 * after GC, so wrapper identity cannot reliably classify direct callees.
 *
 * The probe constrains GC pressure and exercises enough call sites to make the
 * failure reproducible while preserving the intended calls/references semantics.
 */
const CALL_SITES = 60;

test("a direct call is not also recorded as a value reference, at scale (#116)", () => {
  const root = tmpRepo("graft-reference-scale-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "dep.ts"),
    [
      "export function target(): number { return 1; }",
      "export function register(fn: () => number): unknown { return fn; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "consumer.ts"),
    [
      'import { target, register } from "./dep.js";',
      "",
      // (b) handed over as a value — a `references` edge
      "export function usesValue(): unknown { return register(target); }",
      // (c) both, in one body — BOTH edges, from two distinct occurrences
      "export function usesBoth(): number { register(target); return target(); }",
      "",
      // (d) a block-scoped declaration that happens to reuse the imported name.
      // It DECLARES a binding, so it is not a use of the import. Module-level, so
      // `withoutShadowedImports` (which only runs inside a function or method) is
      // not what protects it — `isDeclarationName` is.
      "{",
      "  const target = 0;",
      "}",
      "",
      // (a) the case #116 breaks: every one of these invokes `target` directly, so
      // each must produce a `calls` edge and no `references` edge.
      ...Array.from(
        { length: CALL_SITES },
        (_, i) => `export function callsTarget${i}(): number { return target(); }`,
      ),
      "",
    ].join("\n"),
  );

  const probe = join(dirname(fileURLToPath(import.meta.url)), "reference-scale-probe.ts");
  const run = spawnSync(
    process.execPath,
    ["--max-semi-space-size=1", "--import", "tsx", probe, root],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, `probe failed:\n${run.stderr}`);
  const line = run.stdout.split("\n").find((l) => l.startsWith("__EDGES__"));
  assert.ok(line, `probe printed no edges:\n${run.stdout}\n${run.stderr}`);
  const edges: Array<{ source: string; relation: string }> = JSON.parse(line.slice("__EDGES__".length));
  const linked = (from: string, relation: string): boolean =>
    edges.some((e) => e.source === `src/consumer.ts#${from}` && e.relation === relation);

  // (a) a direct invocation is a call, and ONLY a call — at every one of the sites.
  const callSites = (relation: string): number =>
    edges.filter((e) => /^src\/consumer\.ts#callsTarget\d+$/.test(e.source) && e.relation === relation).length;
  assert.equal(callSites("calls"), CALL_SITES, "every direct call resolves to a calls edge");
  assert.equal(
    callSites("references"),
    0,
    "an identifier that is the direct callee must not also be booked as a value reference",
  );

  // (b) the recall #34/#49 bought must survive any fix to (a).
  assert.equal(linked("usesValue", "references"), true, "a function passed as a value is still a reference");

  // (c) `calls` and `references` may legitimately coexist between the same pair —
  // here two different occurrences of `target` in one body. Whatever fixes (a)
  // must not become a blanket "references and calls are mutually exclusive" rule.
  assert.equal(linked("usesBoth", "calls"), true, "the invoked occurrence yields a calls edge");
  assert.equal(linked("usesBoth", "references"), true, "the value occurrence yields a references edge");

  // (d) the block-scoped redeclaration is attributed to the file node, since it sits
  // outside any definition. It names a binding, so it must not reference the import.
  assert.equal(
    edges.some((e) => e.source === "src/consumer.ts" && e.relation === "references"),
    false,
    "a declaration that reuses an imported name is not a use of the import",
  );
});

test("a local binding that shadows an import does not create a false reference", async () => {
  const root = tmpRepo("graft-reference-shadow-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "gate.ts"), "export function isActive(): boolean { return true; }\n");
  writeFileSync(
    join(root, "src", "consumer.ts"),
    [
      'import { isActive } from "./gate.js";',
      "export function choose(isActive: () => boolean): boolean {",
      "  return isActive();",
      "}",
      "",
    ].join("\n"),
  );

  await buildGraph(root, { reuse: false });
  const graph = readGraph(wiringPath(join(root, "graft")))!;
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.source === "src/consumer.ts#choose" &&
        edge.target === "src/gate.ts#isActive" &&
        edge.relation === "references",
    ),
    false,
  );
});
