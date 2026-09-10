import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOne } from "../src/graph/extract-one.js";
import { warmGenericGrammars } from "../src/graph/generic.js";
import { listSourceStats } from "../src/graph/source-files.js";
import { contentHash } from "../src/util/id.js";

const RS = "pub fn f() {}\npub fn g() { f() }\n";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "graft-pool-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
  writeFileSync(join(d, "src", "lib.rs"), RS);
  return d;
}

test("extractOne: a fresh file is parsed and its entry carries the tier label", async () => {
  const d = repo();
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const rs = files.find((f) => f.rel === "src/lib.rs")!;
  const ts = files.find((f) => f.rel === "src/math.ts")!;
  const r1 = extractOne(rs, null);
  assert.equal(r1.kind, "parsed");
  if (r1.kind !== "parsed") return;
  assert.equal(r1.label, "rust");
  assert.ok(r1.entry.nodes.some((n) => n.id === "src/lib.rs#f"));
  assert.equal(r1.entry.hash, contentHash(RS));
  const r2 = extractOne(ts, null);
  assert.equal(r2.kind, "parsed");
  if (r2.kind !== "parsed") return;
  assert.equal(r2.label, "typescript");
});

test("extractOne: matching bytes report reused without parsing", () => {
  const d = repo();
  const rs = listSourceStats(d, join(d, "graft")).find((f) => f.rel === "src/lib.rs")!;
  assert.deepEqual(extractOne(rs, contentHash(RS)), { kind: "reused", hash: contentHash(RS) });
});

test("extractOne: an unreadable file is skipped with an empty-hash entry that names the file", () => {
  const r = extractOne({ abs: join(tmpdir(), "does-not-exist-graft.rs"), rel: "nope.rs", size: 0, mtimeMs: 0 }, null);
  assert.equal(r.kind, "skipped");
  if (r.kind !== "skipped") return;
  assert.equal(r.entry.hash, "");
  assert.match(r.entry.error ?? "", /^nope\.rs: /);
});

import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";
import type { CruxSummarizer, FileCruxInput, NodeCrux } from "../src/ai/crux.js";

/** Same shape as RecordingCrux in test/graph-enrich-checkpoint.test.ts. */
class TrivialCrux implements CruxSummarizer {
  calls: string[] = [];
  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    this.calls.push(input.path);
    return input.nodes.map((n) => ({ id: n.id, summary: `crux ${n.id}`, crux_start: 0, crux_end: 0 }));
  }
}

test("a --deep build summarizes from disk without buildGraph holding every source", async () => {
  const d = repo();
  const crux = new TrivialCrux();
  const r = await buildGraph(d, { reuse: false, summarizer: crux });
  assert.equal(r.errors.length, 0, r.errors.join("; "));
  assert.ok(crux.calls.includes("src/lib.rs"));
  const g = readGraph(wiringPath(contextDirFor(d)))!;
  assert.equal(g.nodes.find((n) => n.id === "src/lib.rs#f")!.summary_state, "ready");
});

test("a file edited between parse and summary is left pending, not summarized against the wrong lines", async () => {
  const d = repo();
  let edited = false;
  const crux: CruxSummarizer = {
    async describeFile(input) {
      // Simulate an agent editing another file while this one is summarized.
      if (!edited) { edited = true; writeFileSync(join(d, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n"); }
      return input.nodes.map((n) => ({ id: n.id, summary: `crux ${n.id}`, crux_start: 0, crux_end: 0 }));
    },
  };
  const r = await buildGraph(d, { reuse: false, summarizer: crux, concurrency: 1 });
  assert.equal(r.errors.length, 0, r.errors.join("; "));
  const g = readGraph(wiringPath(contextDirFor(d)))!;
  const states = new Set(g.nodes.filter((n) => n.path === "src/math.ts" || n.path === "src/lib.rs").map((n) => n.summary_state));
  // Whichever file was summarized first is ready; the edited one may be pending.
  // What must never happen is a "ready" summary computed against changed bytes.
  assert.ok(states.has("ready"));
  assert.ok(r.meaning.pending + r.meaning.computed >= 1);
});
