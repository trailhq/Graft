/**
 * #128: the crux pass used to reach wiring.json only at build end, so an interrupted
 * `--deep` run discarded every crux it had already computed and paid for. `enrichGraph`
 * now flushes partial progress via a `checkpoint` callback, and (as it always has) folds
 * a prior graph back in by `body_hash`. Together those mean a killed run keeps its crux
 * and the next run replays it rather than re-issuing the LLM calls. These tests exercise
 * that with a fake summarizer, no real model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichGraph } from "../src/graph/enrich.js";
import type { CruxSummarizer, FileCruxInput, NodeCrux } from "../src/ai/crux.js";
import type { NodeV1 } from "../src/graph/types.js";

/** A CruxSummarizer that records which files it was asked to summarize (so a test can
 * prove a file was, or was NOT, re-issued) and returns a trivial crux for each node. */
class RecordingCrux implements CruxSummarizer {
  calls: string[] = [];
  async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
    this.calls.push(input.path);
    return input.nodes.map((n) => ({ id: n.id, summary: `crux ${n.id}`, crux_start: 0, crux_end: 0 }));
  }
}

function methodNode(path: string, name: string, hash: string): NodeV1 {
  return {
    id: `${path}#${name}`, name, kind: "method", path, span: "L1-L3",
    signature: `${name}()`, exported: true, origin: "ast", body_hash: hash,
    summary_state: "pending", summary: null, crux: null,
  };
}

const FILES = ["a.ts", "b.ts", "c.ts", "d.ts"];
function fixture(): { nodes: NodeV1[]; sources: Map<string, string> } {
  const nodes = FILES.map((f, i) => methodNode(f, "run", `h${i}`));
  const sources = new Map(FILES.map((f) => [f, "class X {\n  run() { return 1; }\n}\n"]));
  return { nodes, sources };
}

test("#128: the crux pass flushes partial progress mid-run (checkpoint), not only at the end", async () => {
  const { nodes, sources } = fixture();
  const prev = process.env.GRAFT_CRUX_CHECKPOINT_MS;
  process.env.GRAFT_CRUX_CHECKPOINT_MS = "0"; // flush on every completed file
  try {
    const readyAtCheckpoint: number[] = [];
    await enrichGraph(nodes, new Map(), sources, {
      summarizer: new RecordingCrux(),
      concurrency: 1, // deterministic completion order for the snapshot assertion
      checkpoint: () => readyAtCheckpoint.push(nodes.filter((n) => n.summary_state === "ready").length),
    });
    // A checkpoint fired DURING the pass (before the build's final write), and the
    // count of persisted-ready nodes climbed — i.e. an interruption would have kept them.
    assert.ok(readyAtCheckpoint.length > 0, "checkpoint fired during the pass");
    assert.ok(readyAtCheckpoint.some((n) => n > 0 && n < FILES.length), "partial progress was flushable");
    assert.equal(nodes.filter((n) => n.summary_state === "ready").length, FILES.length, "all ended ready");
  } finally {
    if (prev === undefined) delete process.env.GRAFT_CRUX_CHECKPOINT_MS;
    else process.env.GRAFT_CRUX_CHECKPOINT_MS = prev;
  }
});

test("#128: a rerun replays checkpointed crux by body_hash instead of re-issuing it", async () => {
  const { nodes, sources } = fixture();
  // Simulate an interrupted run that checkpointed the first two files as ready.
  const prior = new Map(
    nodes.slice(0, 2).map((n) => [n.id, { ...n, summary: `crux ${n.id}`, crux: null, summary_state: "ready" as const }]),
  );
  // The next run starts from fresh (pending) nodes with the SAME body_hash.
  const fresh = FILES.map((f, i) => methodNode(f, "run", `h${i}`));
  const rec = new RecordingCrux();
  const stats = await enrichGraph(fresh, prior, sources, { summarizer: rec });

  assert.ok(!rec.calls.includes("a.ts") && !rec.calls.includes("b.ts"), "already-done files are NOT re-summarized");
  assert.ok(rec.calls.includes("c.ts") && rec.calls.includes("d.ts"), "only the unfinished files run");
  assert.equal(stats.cached, 2, "two crux carried over from the interrupted run");
  assert.equal(stats.computed, 2, "two freshly computed");
});
