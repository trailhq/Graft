/**
 * A1 — UTF-16-aware source reading, routed through every repo-source reader.
 *
 * `util/source.ts`'s `readSourceFile` decodes UTF-16LE (BOM `FF FE`) and treats
 * UTF-16BE (BOM `FE FF`) as unsupported (null — never a silent mojibake read).
 * Every reader that walks real repo source — graph/build.ts, graph/fingerprint.ts,
 * graph/check.ts, context/build.ts, context/check.ts, ask.ts's `--source` span
 * slicer, and search/grep.ts — routes through it, so a UTF-16LE file (the common
 * shape written by Windows tooling generally, not just one language's toolchain)
 * decodes identically everywhere it is read: hash-what-you-parse consistency
 * across build/fingerprint/check/grep/ask, not a fresh mojibake bug per reader.
 *
 * These fixtures deliberately use plain .ts/.py files — no PowerShell grammar on
 * this branch — to prove the routing is general-purpose, not tied to any one
 * source language.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceFile } from "../src/util/source.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { probeDrift } from "../src/graph/fingerprint.js";
import { buildContext } from "../src/context/build.js";
import { checkContext } from "../src/context/check.js";
import { grepGraph } from "../src/search/grep.js";
import { ask } from "../src/ask/ask.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import { fakeProviders } from "./helpers.js";

/** BOM + UTF-16LE bytes — the shape Windows tooling in general actually writes. */
function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

/** BOM + UTF-16BE bytes — unsupported; readSourceFile must return null, never
 * mojibake, for this encoding. */
function utf16be(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
}

test("readSourceFile: decodes a UTF-16LE BOM, returns null for UTF-16BE, and reads plain UTF-8 unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-utf16-unit-"));
  try {
    writeFileSync(join(dir, "le.ts"), utf16le("export const x = 1;\n"));
    writeFileSync(join(dir, "be.ts"), utf16be("export const x = 1;\n"));
    writeFileSync(join(dir, "plain.ts"), "export const x = 1;\n", "utf8");

    assert.equal(readSourceFile(join(dir, "le.ts")), "export const x = 1;\n");
    assert.equal(readSourceFile(join(dir, "be.ts")), null);
    assert.equal(readSourceFile(join(dir, "plain.ts")), "export const x = 1;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 graph/build.ts: a UTF-16LE .ts file is decoded at graph ingest, not mojibake-parsed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-utf16-build-"));
  try {
    writeFileSync(join(dir, "legacy.ts"), utf16le("export function fromLegacy(): void {}\n"));
    const r = await buildGraph(dir);
    assert.deepEqual(r.errors, []);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph.nodes.some((n) => n.id === "legacy.ts#fromLegacy"), "the UTF-16LE file's function must be extracted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 graph/build.ts: a UTF-16BE file is an empty entry, not a build error (null → empty-entry posture)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-utf16be-build-"));
  try {
    writeFileSync(join(dir, "legacy.ts"), utf16be("export function fromLegacy(): void {}\n"));
    const r = await buildGraph(dir);
    assert.deepEqual(r.errors, [], "an unsupported encoding is a skip, never an error");
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(!graph.nodes.some((n) => n.path === "legacy.ts"), "no nodes minted for the undecodable file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 hash-what-you-parse consistency: build/check/fingerprint agree on a UTF-16LE file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-utf16-consistency-"));
  try {
    writeFileSync(join(dir, "legacy.py"), utf16le("def from_legacy():\n    return 42\n"));
    await buildGraph(dir);

    const check = await checkGraph(dir);
    assert.equal(check.ok, true, "checkGraph must decode the same way build.ts did — no added/removed/changed");
    assert.deepEqual(check.added, []);
    assert.deepEqual(check.removed, []);
    assert.deepEqual(check.changed, []);

    const drift = probeDrift(join(dir), join(dir, "graft"));
    assert.deepEqual(drift, { changed: [], added: [], removed: [] }, "fingerprint's probe must agree too — no drift");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 fingerprint reports drift when indexed UTF-16LE becomes unsupported UTF-16BE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-utf16-drift-"));
  const previousRefresh = process.env.GRAFT_REFRESH;
  try {
    const file = join(dir, "legacy.ts");
    const source = "export function fromLegacy(): void {}\n";
    writeFileSync(file, utf16le(source));
    await buildGraph(dir);

    writeFileSync(file, utf16be(source));
    process.env.GRAFT_REFRESH = "hash";
    assert.deepEqual(
      probeDrift(dir, join(dir, "graft")),
      { changed: ["legacy.ts"], added: [], removed: [] },
      "becoming undecodable must rebuild once instead of serving stale UTF-16LE nodes",
    );

    await buildGraph(dir);
    assert.deepEqual(
      probeDrift(dir, join(dir, "graft")),
      { changed: [], added: [], removed: [] },
      "after the rebuild records an unsupported file, the probe must not churn",
    );
  } finally {
    if (previousRefresh === undefined) delete process.env.GRAFT_REFRESH;
    else process.env.GRAFT_REFRESH = previousRefresh;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 context/build.ts + check.ts: a UTF-16LE file's summarizer input decodes cleanly, and the two tiers' content hash stays consistent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-utf16-context-"));
  try {
    writeFileSync(
      join(dir, "legacy.ts"),
      utf16le("// [[Utf16Widget]]\nexport const widget = 1;\n"),
    );
    const r = await buildContext(dir, { model: "fake", ...fakeProviders() });
    assert.deepEqual(r.errors, [], "the file must be readable, not treated as an error");
    // PassthroughSummarizer hands the (post-decode) code straight to
    // BracketSynthesizer, which only matches [[Name]] in CLEAN text — a
    // mojibake decode (NUL bytes between every ASCII char) would never match.
    assert.equal(r.nodes, 1, "the [[Utf16Widget]] marker must survive decoding to be synthesized as a node");

    const check = checkContext(dir);
    assert.equal(check.ok, true, "content hash must agree between build and check for the same UTF-16LE file");
    assert.deepEqual(check.contentDrift, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 search/grep.ts: finds a pattern inside a UTF-16LE file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-utf16-grep-"));
  try {
    writeFileSync(
      join(dir, "legacy.ts"),
      utf16le("export function fromLegacy(): void {\n  console.log(\"NEEDLE hit\");\n}\n"),
    );
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph.nodes.some((n) => n.id === "legacy.ts#fromLegacy"), "sanity: the file parses (extract already routes through readSourceFile)");

    const r = grepGraph(graph, dir, "NEEDLE");
    assert.equal(r.totalHits, 1, "grep must find the pattern in the UTF-16LE file's decoded text");
    assert.match(r.groups[0]!.hits[0]!.text, /NEEDLE hit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A1 ask.ts --source: inlines clean (non-garbled) source sliced from a UTF-16LE file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-utf16-ask-"));
  try {
    writeFileSync(
      join(dir, "legacy.ts"),
      utf16le("export function fromLegacyAsk(): number {\n  return 42;\n}\n"),
    );
    await buildGraph(dir);

    const r = ask(dir, "fromLegacyAsk", { source: true });
    const hit = r.hits.find((h) => h.title.startsWith("fromLegacyAsk"));
    assert.ok(hit, "expected a hit for the UTF-16LE-defined function");
    assert.ok(hit!.code, "expected inlined source");
    assert.match(hit!.code!, /return 42/, "the sliced span must decode cleanly, not as mojibake");
    assert.ok(!hit!.code!.includes("\u0000"), "no stray NUL bytes from a mis-decoded UTF-16LE read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
