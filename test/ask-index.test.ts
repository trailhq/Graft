/**
 * Tests for the `ask` build-time sidecar (`.cache/ask-index.json`).
 *
 * `graft build` writes token/document-frequency bags once so `ask` doesn't
 * re-tokenize the whole corpus per query. These tests pin down the contract
 * that makes the sidecar safe to ship: it is a byte-for-byte reproduction of
 * live tokenization, consuming it never changes a single `ask` result (hits
 * AND scores), and any way the sidecar can be missing/wrong falls back to the
 * live path rather than crashing or silently drifting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { ask } from "../src/ask/ask.js";
import { contextDirFor } from "../src/context/node-file.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { askIndexPath, readAskIndex, tokenize, counts, writeAskIndex } from "../src/ask/index-file.js";
import { rankFileBm25 } from "../src/ask/file-bm25.js";
import { extractFile, languageOf } from "../src/graph/extract.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

/** A small multi-file fixture with enough overlapping vocabulary that IDF and
 * BM25 actually differentiate hits, so a parity test on scores is meaningful. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-index-"));
  writeFileSync(
    join(dir, "auth.ts"),
    `/** Validate an incoming API request's auth token. */\n` +
      `export function validateAuthToken(token: string): boolean {\n` +
      `  return token.length > 0;\n` +
      `}\n\n` +
      `export function authMiddleware(req: unknown): boolean {\n` +
      `  return validateAuthToken("x");\n` +
      `}\n`,
  );
  writeFileSync(
    join(dir, "requests.ts"),
    `/** Parse an incoming API request body. */\n` +
      `export function parseRequestBody(raw: string): unknown {\n` +
      `  return JSON.parse(raw);\n` +
      `}\n`,
  );
  writeFileSync(
    join(dir, "unrelated.ts"),
    `export function addTwo(a: number, b: number): number {\n  return a + b;\n}\n`,
  );
  return dir;
}

const QUERY = "How does authentication middleware validate incoming API requests?";

/**
 * Reconstruct a "fat" wiring.json — body_text present on every node, as EVERY
 * build produced before the slim-serialization change (see `write.ts`) — by
 * re-extracting it from each fixture source file and merging it back onto the
 * (now-slim) wiring.json already on disk. `extractFile` is a pure function of
 * source text, so this reproduces byte-identical values to what the sidecar
 * was actually tokenized from at build time.
 *
 * Several tests below pin down sidecar-corruption fallback behavior (unknown
 * version / stale docCount / unparseable file) — a concern orthogonal to
 * whether wiring.json itself is slim or fat. Before the slim-serialization
 * change those tests got a fat graph for free; this helper keeps them testing
 * the same thing (does falling back to live tokenization reproduce the
 * sidecar exactly?) now that a fresh build no longer hands them one.
 */
function reinjectBodyText(dir: string, outDir: string): void {
  const wpath = wiringPath(outDir);
  const graph = JSON.parse(readFileSync(wpath, "utf8")) as GraphV1;
  const bodyById = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const lang = languageOf(entry);
    if (!lang) continue;
    const source = readFileSync(join(dir, entry), "utf8");
    const { nodes } = extractFile(entry, source, lang);
    for (const n of nodes) if (n.body_text !== undefined) bodyById.set(n.id, n.body_text);
  }
  for (const n of graph.nodes as NodeV1[]) {
    const bt = bodyById.get(n.id);
    if (bt !== undefined) n.body_text = bt;
  }
  writeFileSync(wpath, JSON.stringify(graph));
}

test("writeAskIndex + readAskIndex round-trip matches live tokenization exactly", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const outDir = contextDirFor(dir);
    // This test asserts the sidecar is a byte-for-byte cache of tokenizing the
    // graph's OWN fields — which requires body_text, no longer present on a
    // freshly-built wiring.json. Reconstruct it (deterministically) so the
    // cache-correctness check below is meaningful.
    reinjectBodyText(dir, outDir);
    const graph = readGraph(wiringPath(outDir));
    assert.ok(graph, "wiring graph should exist after build");

    const index = readAskIndex(outDir);
    assert.ok(index, "sidecar should exist after build");
    assert.equal(index!.version, 1);
    assert.equal(index!.docCount, graph!.nodes.length);
    assert.equal(index!.docs.length, graph!.nodes.length);

    const sortPairs = (p: [string, number][]) => [...p].sort((a, b) => a[0].localeCompare(b[0]));
    const byId = new Map(index!.docs.map((d) => [d.id, d]));
    for (const n of graph!.nodes) {
      const d = byId.get(n.id);
      assert.ok(d, `sidecar should carry a doc for ${n.id}`);
      const liveName = [...counts(tokenize(n.name)).entries()];
      const livePath = [...counts(tokenize(n.path)).entries()];
      const liveBody = [
        ...counts(tokenize(`${n.signature ?? ""} ${n.summary ?? ""} ${n.body_text ?? ""}`)).entries(),
      ];
      assert.deepEqual(sortPairs(d!.name), sortPairs(liveName), `name bag for ${n.id}`);
      assert.deepEqual(sortPairs(d!.path), sortPairs(livePath), `path bag for ${n.id}`);
      assert.deepEqual(sortPairs(d!.body), sortPairs(liveBody), `body bag for ${n.id}`);
    }

    // Round-trip through writeAskIndex again (idempotent, deterministic).
    const path2 = writeAskIndex(outDir, graph!);
    assert.equal(path2, askIndexPath(outDir));
    const reread = readAskIndex(outDir);
    assert.deepEqual(reread, index, "re-writing an unchanged graph reproduces the same sidecar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask results are IDENTICAL with and without the sidecar (same hits, same scores)", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const outDir = contextDirFor(dir);
    // A fresh build's wiring.json is slim (no body_text) by design (Task 2) —
    // the live-tokenization fallback only reproduces the sidecar exactly when
    // the underlying graph is fat, so reconstruct that here to test what this
    // test is actually about: does the fallback path correctly reproduce the
    // sidecar's numbers?
    reinjectBodyText(dir, outDir);
    const idxPath = askIndexPath(outDir);

    const withIndex = ask(dir, QUERY, { source: false });
    assert.ok(readAskIndex(outDir), "sanity: sidecar is present for the first run");

    const backup = readFileSync(idxPath);
    unlinkSync(idxPath);
    try {
      assert.equal(readAskIndex(outDir), null, "sanity: sidecar is really gone");
      const withoutIndex = ask(dir, QUERY, { source: false });
      assert.deepEqual(withoutIndex, withIndex, "sidecar vs live fallback must produce identical AskResult");
      assert.ok(withIndex.hits.length > 0, "the fixture query should actually match something");
    } finally {
      writeFileSync(idxPath, backup);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default file-first ask follows the cached whole-file BM25 order", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const index = readAskIndex(contextDirFor(dir));
    assert.ok(index?.files, "build writes the whole-file BM25 sidecar");
    const expected = rankFileBm25(index!.files!, QUERY).map((item) => item.path);
    const actual = ask(dir, QUERY, { limit: expected.length }).hits.map(
      (hit) => hit.pointer.split(":")[0],
    );
    assert.deepEqual(actual, expected, "ask projects spans without changing BM25 file order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown sidecar version falls back to live tokenization without crashing", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const outDir = contextDirFor(dir);
    reinjectBodyText(dir, outDir); // see comment above: fallback == live tokenization only on a fat graph
    const idxPath = askIndexPath(outDir);

    const live = ask(dir, QUERY, { source: false });

    const raw = JSON.parse(readFileSync(idxPath, "utf8"));
    raw.version = 2;
    writeFileSync(idxPath, JSON.stringify(raw));

    assert.equal(readAskIndex(outDir), null, "an unknown version reads as null (fallback signal)");
    const withBadVersion = ask(dir, QUERY, { source: false });
    assert.deepEqual(withBadVersion, live, "unknown-version sidecar must not change results");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale sidecar (docCount mismatch) falls back to live tokenization", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const outDir = contextDirFor(dir);
    reinjectBodyText(dir, outDir); // see comment above: fallback == live tokenization only on a fat graph
    const idxPath = askIndexPath(outDir);

    const live = ask(dir, QUERY, { source: false });

    const raw = JSON.parse(readFileSync(idxPath, "utf8"));
    raw.docs = raw.docs.slice(1); // drop one doc — docs.length !== graph.nodes.length now
    writeFileSync(idxPath, JSON.stringify(raw));

    const stale = ask(dir, QUERY, { source: false });
    assert.deepEqual(stale, live, "a docCount-mismatched sidecar must not change results");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unparseable sidecar file falls back to live tokenization", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const outDir = contextDirFor(dir);
    reinjectBodyText(dir, outDir); // see comment above: fallback == live tokenization only on a fat graph
    const idxPath = askIndexPath(outDir);

    const live = ask(dir, QUERY, { source: false });
    writeFileSync(idxPath, "{not json");

    assert.equal(readAskIndex(outDir), null);
    const withGarbage = ask(dir, QUERY, { source: false });
    assert.deepEqual(withGarbage, live);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A3: a duplicate-named definition still gets its own ask-index doc (unique ids -> docs.length === nodes.length)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-index-dup-"));
  try {
    writeFileSync(
      join(dir, "dup.ts"),
      `export function helper(): void {\n  console.log("first");\n}\n\n` +
        `export function helper(): void {\n  console.log("second");\n}\n`,
    );
    await buildGraph(dir);
    const outDir = contextDirFor(dir);
    const graph = readGraph(wiringPath(outDir));
    assert.ok(graph, "wiring graph should exist after build");
    const ids = graph!.nodes.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, "sanity: node ids are unique");
    assert.ok(
      ids.includes("dup.ts#helper") && ids.includes("dup.ts#helper~2"),
      "sanity: the dup actually minted an ordinal id",
    );

    const index = readAskIndex(outDir);
    assert.ok(index, "sidecar should exist after build");
    assert.equal(index!.docCount, graph!.nodes.length);
    assert.equal(index!.docs.length, graph!.nodes.length);
    const docIds = new Set(index!.docs.map((d) => d.id));
    for (const id of ids) assert.ok(docIds.has(id), `sidecar missing doc for ${id}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAskIndex returns null when the sidecar is simply missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-index-missing-"));
  try {
    assert.equal(readAskIndex(contextDirFor(dir)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAskIndex returns null when docCount doesn't match docs.length", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-index-doccount-"));
  try {
    const outDir = contextDirFor(dir);
    const idxPath = askIndexPath(outDir);
    mkdirSync(dirname(idxPath), { recursive: true });
    const corrupted = {
      version: 1,
      avgBodyLen: 3,
      df: [["foo", 1]],
      docCount: 5, // deliberately mismatched with docs below
      docs: [{ id: "a", name: [], path: [], body: [["foo", 1]] }],
    };
    writeFileSync(idxPath, JSON.stringify(corrupted));
    assert.equal(readAskIndex(outDir), null, "docCount !== docs.length must read as null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed sidecar write is recorded in build errors, not fatal", async () => {
  const dir = makeFixture();
  try {
    const outDir = contextDirFor(dir);
    const idxPath = askIndexPath(outDir);
    // Pre-create the sidecar's own path AS A DIRECTORY so writeAskIndex's
    // writeFileSync fails with EISDIR — simulates any write failure without
    // needing real permission tricks.
    mkdirSync(idxPath, { recursive: true });

    const result = await buildGraph(dir);

    assert.ok(
      result.errors.some((e) => e.startsWith("ask-index:")),
      `expected an "ask-index: ..." entry in result.errors, got: ${JSON.stringify(result.errors)}`,
    );
    // The rest of the build must still have completed: wiring.json, cards,
    // and INDEX all still get written even though the sidecar write failed.
    const graph = readGraph(wiringPath(outDir));
    assert.ok(graph, "wiring graph should still be written despite the sidecar failure");
    assert.ok(result.cards > 0, "cards should still be written despite the sidecar failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Task-2: body_text moves out of wiring.json entirely ────────────────────

test("ask WITH sidecar: identical hits/scores whether the underlying wiring.json is slim or fat", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const outDir = contextDirFor(dir);
    const wpath = wiringPath(outDir);

    const slimResult = ask(dir, QUERY, { source: false });
    assert.ok(slimResult.hits.length > 0, "sanity: the fixture query matches something");

    // Simulate a "fat" wiring.json (as an old build, or a hand-edit, would
    // produce) by re-injecting an arbitrary body_text onto every node. When
    // the sidecar is present, scoring reads token bags from IT, not from
    // node.body_text, so this must have zero effect on the result.
    const raw = JSON.parse(readFileSync(wpath, "utf8")) as GraphV1;
    for (const n of raw.nodes) (n as { body_text?: string }).body_text = `junk filler text for ${n.id}`;
    writeFileSync(wpath, JSON.stringify(raw));

    const fatResult = ask(dir, QUERY, { source: false });
    assert.deepEqual(
      fatResult,
      slimResult,
      "sidecar-driven ask must be identical whether wiring.json is slim or carries body_text",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask WITHOUT sidecar on a SLIM graph: no crash, body contributions absent, name matching still works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-index-slim-nosidecar-"));
  try {
    // "stripe" appears only inside checkout's body — never in its name/signature.
    writeFileSync(
      join(dir, "pay.ts"),
      `export function checkout(amount: number): string {\n` +
        `  const token = createStripeCharge(amount);\n` +
        `  return token;\n` +
        `}\n`,
    );
    await buildGraph(dir); // writes a slim wiring.json + the sidecar
    const outDir = contextDirFor(dir);
    const idxPath = askIndexPath(outDir);
    unlinkSync(idxPath); // no sidecar from here on
    assert.equal(readAskIndex(outDir), null, "sanity: sidecar is really gone");

    // Body-only term: with no sidecar AND a slim graph, body text isn't
    // available anywhere — must not crash, and must simply find nothing.
    const byBody = ask(dir, "stripe");
    assert.equal(
      byBody.hits.find((h) => h.title.startsWith("checkout")),
      undefined,
      "a body-only term cannot be found once body_text lives only in the (now-missing) sidecar",
    );

    // Name matching is unaffected — it never depended on body_text.
    const byName = ask(dir, "checkout");
    const hit = byName.hits.find((h) => h.title.startsWith("checkout"));
    assert.ok(hit, "name-field matching still works with no sidecar and a slim graph");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask on an OLD fat graph (body_text present, no sidecar): unchanged behavior — body_text still used", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-index-old-fat-"));
  try {
    // Build a wiring.json by hand via extractFile directly (bypassing
    // buildGraph/writeGraph entirely), so body_text survives on disk exactly
    // as a pre-slim-serialization build would have written it. No sidecar.
    const source =
      `export function checkout(amount: number): string {\n` +
      `  const token = createStripeCharge(amount);\n` +
      `  return token;\n` +
      `}\n`;
    const { nodes } = extractFile("pay.ts", source, "typescript");
    const graph: GraphV1 = {
      meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: ["typescript"] },
      nodes,
      edges: [],
    };
    const outDir = contextDirFor(dir);
    const wpath = wiringPath(outDir);
    mkdirSync(dirname(wpath), { recursive: true });
    writeFileSync(wpath, JSON.stringify(graph));
    assert.ok(
      nodes.some((n) => n.body_text?.toLowerCase().includes("stripe")),
      "sanity: extractFile actually populated body_text for this fixture",
    );

    const r = ask(dir, "stripe");
    const hit = r.hits.find((h) => h.title.startsWith("checkout"));
    assert.ok(hit, "an old fat graph with no sidecar must still find a body-only term via node.body_text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
