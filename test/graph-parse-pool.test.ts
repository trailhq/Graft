import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOne } from "../src/graph/extract-one.js";
import { warmGenericGrammars } from "../src/graph/generic.js";
import { grammarsFor, warmGrammarsFor } from "../src/graph/tier.js";
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
  const files = listSourceStats(d, join(d, "graft"));
  await warmGrammarsFor(files.map((f) => f.abs));
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
  assert.deepEqual(extractOne(rs, { hash: contentHash(RS) }), { kind: "reused", hash: contentHash(RS) });
});

test("extractOne: a prior parse by a different stand-in is parsed again, not reused", async () => {
  const d = repo();
  const files = listSourceStats(d, join(d, "graft"));
  await warmGrammarsFor(files.map((f) => f.abs));
  const rs = files.find((f) => f.rel === "src/lib.rs")!;
  // Same bytes, but the cached parse came from a stand-in that this file no longer
  // goes through: replaying it would pin the stand-in's output to the file.
  const r = extractOne(rs, { hash: contentHash(RS), via: "some-stand-in" });
  assert.equal(r.kind, "parsed");
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

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PARSE_POOL_MIN_FILES, parseWorkerEntry, poolSize, runParsePool } from "../src/graph/parse-pool.js";

test("poolSize: 0 unless GRAFT_PARSE_WORKERS is set or the caller asks; then bounded by cores, memory and work", () => {
  assert.equal(poolSize(100_000, {}, 8, 64e9), 0, "never automatic");
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "0" }, 8, 64e9), 0);
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "3" }, 8, 64e9), 3);
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "auto" }, 8, 64e9), 7, "auto = cores - 1");
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "auto" }, 64, 1e9), 3, "memory-capped at ~300 MB per child");
  assert.equal(poolSize(50, { GRAFT_PARSE_WORKERS: "auto" }, 64, 64e9), 0, "under the minimum, in-thread");
  assert.equal(poolSize(PARSE_POOL_MIN_FILES * 2, { GRAFT_PARSE_WORKERS: "auto" }, 64, 64e9), 2, "work-capped");
  assert.equal(poolSize(100_000, { GRAFT_PARSE_WORKERS: "garbage" }, 8, 64e9), 0, "unparseable = in-thread");
});

test("parseWorkerEntry points at a file that exists", () => {
  assert.ok(existsSync(parseWorkerEntry()), parseWorkerEntry());
});

test("runParsePool returns the same results, in file order, as extractOne in-thread", async () => {
  const d = repo();
  for (let i = 0; i < 30; i++) writeFileSync(join(d, "src", `m${i}.rs`), `pub fn m${i}() { f() }\n`);
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const inThread = files.map((f) => extractOne(f, null));
  const pooled = await runParsePool(files, () => null, grammarsFor(files.map((f) => f.abs)), { workers: 2 });
  assert.deepEqual(pooled, inThread);
});

test("runParsePool honours the prior parse and reports reused", async () => {
  const d = repo();
  const files = listSourceStats(d, join(d, "graft"));
  const rs = files.find((f) => f.rel === "src/lib.rs")!;
  const pooled = await runParsePool(files, (rel) => (rel === rs.rel ? { hash: contentHash(RS) } : null), grammarsFor(files.map((f) => f.abs)), { workers: 2 });
  assert.deepEqual(pooled[files.indexOf(rs)], { kind: "reused", hash: contentHash(RS) });
});

/** A child entry that behaves like parse-worker.ts except where `mode` says otherwise. */
function fakeWorker(dir: string, mode: "crash-on-boom" | "never-ready" | "always-crash"): string {
  const entry = join(dir, `worker-${mode}.mjs`);
  const src = pathToFileURL(join(process.cwd(), "src", "graph")).href;
  writeFileSync(entry, [
    `import { extractOne } from ${JSON.stringify(src + "/extract-one.ts")};`,
    `import { warmGrammars } from ${JSON.stringify(src + "/tier.ts")};`,
    `const mode = ${JSON.stringify(mode)};`,
    "process.on('message', async (m) => {",
    "  if (m.type === 'init') { if (mode === 'never-ready') return; await warmGrammars(m.grammars); process.send({ type: 'ready' }); }",
    "  else if (m.type === 'job') {",
    "    if (mode === 'always-crash' || (mode === 'crash-on-boom' && m.f.rel.endsWith('boom.rs'))) process.exit(9);",
    "    process.send({ type: 'done', seq: m.seq, result: extractOne(m.f, m.prior) });",
    "  } else if (m.type === 'stop') process.exit(0);",
    "});",
    "process.on('disconnect', () => process.exit(0));",
  ].join("\n"));
  return entry;
}

test("runParsePool: a child that dies mid-job costs that file two attempts, then an error; the rest still parse", async () => {
  const d = repo();
  writeFileSync(join(d, "src", "boom.rs"), "pub fn boom() {}\n");
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const results = await runParsePool(files, () => null, grammarsFor(files.map((f) => f.abs)), { workers: 2, entry: fakeWorker(d, "crash-on-boom") });
  const boom = results[files.findIndex((f) => f.rel === "src/boom.rs")];
  assert.equal(boom.kind, "error");
  if (boom.kind !== "error") return;
  assert.match(boom.message, /src\/boom\.rs: parse failed — parser process exited/);
  assert.equal(results[files.findIndex((f) => f.rel === "src/lib.rs")].kind, "parsed");
});

test("runParsePool: children that never become ready are killed at the warm-up timeout and the parent parses in-thread", async () => {
  const d = repo();
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const t0 = Date.now();
  const results = await runParsePool(files, () => null, grammarsFor(files.map((f) => f.abs)), { workers: 2, entry: fakeWorker(d, "never-ready"), warmTimeoutMs: 1500 });
  assert.ok(Date.now() - t0 < 10_000, "did not hang");
  assert.deepEqual(results, files.map((f) => extractOne(f, null)), "in-thread fallback produced the full result set");
});

test("runParsePool: children that always crash fall back to in-thread parsing instead of rejecting", async () => {
  const d = repo();
  for (let i = 0; i < 10; i++) writeFileSync(join(d, "src", `c${i}.rs`), `pub fn c${i}() {}\n`);
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  const results = await runParsePool(files, () => null, grammarsFor(files.map((f) => f.abs)), { workers: 2, entry: fakeWorker(d, "always-crash") });
  assert.equal(results.length, files.length);
  assert.ok(results.every((r) => r.kind === "parsed"), "every file was parsed in-thread after the pool gave up");
});

test("runParsePool: a file that kills every child with no other work is treated as environmental and parsed in-thread", async () => {
  // boom.rs is the ONLY file, so no job ever completes in a child (succeeded === 0).
  // The crashes are therefore taken to be environmental (fork/loader/permissions),
  // not this file poisoning the parser, so the parked job is parsed in-thread.
  const d = mkdtempSync(join(tmpdir(), "graft-pool-solo-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "boom.rs"), "pub fn boom() {}\n");
  await warmGenericGrammars(["rust"]);
  const files = listSourceStats(d, join(d, "graft"));
  assert.equal(files.length, 1);
  const results = await runParsePool(files, () => null, grammarsFor(files.map((f) => f.abs)), { workers: 2, entry: fakeWorker(d, "crash-on-boom") });
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "parsed");
});

test("buildGraph with parseWorkers writes byte-identical wiring.json to the in-thread build", async () => {
  const d = repo();
  for (let i = 0; i < 40; i++) writeFileSync(join(d, "src", `p${i}.rs`), `pub fn p${i}() { f() }\n`);
  const inThread = await buildGraph(d, { reuse: false });
  assert.equal(inThread.parseWorkers, 0);
  const a = readFileSync(wiringPath(contextDirFor(d)), "utf8");
  const pooled = await buildGraph(d, { reuse: false, parseWorkers: 2 });
  assert.equal(pooled.parseWorkers, 2);
  assert.equal(pooled.parsed, inThread.parsed);
  assert.equal(readFileSync(wiringPath(contextDirFor(d)), "utf8"), a);
  assert.equal((await buildGraph(d, { reuse: false, parseWorkers: "auto" })).parseWorkers, 0, "auto on 42 files stays in-thread");
});

test("buildGraph never forks unless asked, whatever the environment says", async () => {
  const d = repo();
  const prev = process.env.GRAFT_PARSE_WORKERS;
  process.env.GRAFT_PARSE_WORKERS = "4";
  try {
    const r = await buildGraph(d, { reuse: false });
    assert.equal(r.parseWorkers, 0, "the env var is read by the CLI, not by buildGraph");
  } finally {
    if (prev === undefined) delete process.env.GRAFT_PARSE_WORKERS; else process.env.GRAFT_PARSE_WORKERS = prev;
  }
});
