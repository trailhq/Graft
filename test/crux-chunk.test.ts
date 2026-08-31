/**
 * #260: one crux call per file hits maxTokens (~8192) around 125 symbols. The
 * adapter's JSON.parse of the truncated tool arguments fails, parseResults
 * returns [], and the whole file is dropped. Re-running --deep hits the same
 * ceiling, so those files stay failed forever.
 *
 * Fix: chunk targets at {@link CRUX_CHUNK_SIZE} (pinned here; not a silent 125),
 * merge chunk results, and log truncation instead of swallowing it. Small files
 * still cost one call. Empty chunks must not be cached as ready (#177).
 *
 * All of this is a fake ChatModel — no provider key, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer, chunkCruxTargets, CRUX_CHUNK_SIZE } from "../src/ai/crux.js";
import { enrichGraph } from "../src/graph/enrich.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";
import type { FileCruxInput, NodeRef } from "../src/ai/crux.js";
import type { NodeV1 } from "../src/graph/types.js";

/** Observed production cliff from #260 — test-only. Production chunks at CRUX_CHUNK_SIZE. */
const TRUNCATE_ABOVE = 125;
const DENSE = 200;

test("#260: CRUX_CHUNK_SIZE is pinned and dense files split, small files do not", () => {
  assert.equal(CRUX_CHUNK_SIZE, 80);
  assert.ok(CRUX_CHUNK_SIZE < TRUNCATE_ABOVE, "chunk size must sit under the observed truncation cliff");
  assert.deepEqual(
    chunkCruxTargets(Array.from({ length: 80 }, (_, i) => i)).map((c) => c.length),
    [80],
  );
  assert.deepEqual(
    chunkCruxTargets(Array.from({ length: 81 }, (_, i) => i)).map((c) => c.length),
    [80, 1],
  );
  assert.deepEqual(
    chunkCruxTargets(Array.from({ length: DENSE }, (_, i) => i)).map((c) => c.length),
    [80, 80, 40],
  );
  assert.deepEqual(chunkCruxTargets([]), []);
});

test("#260: a 200-symbol file truncated in one call is not silently dropped", async () => {
  const model = new CeilingModel();
  const { result, err } = await withCapturedError(() =>
    new ChatCruxSummarizer(model).describeFile(denseInput(DENSE)),
  );

  assert.ok(result.length > 0, "chunking must keep at least some summaries instead of dropping the file");
  assert.equal(result.length, DENSE, "every target in a dense file should come back once chunks fit under the cliff");
  assert.ok(model.calls >= 2, `dense file must take more than one LLM call, saw ${model.calls}`);
  assert.ok(
    model.sizes.every((n) => n <= CRUX_CHUNK_SIZE),
    `every call must pack ≤ ${CRUX_CHUNK_SIZE} targets, saw ${model.sizes.join(",")}`,
  );
  assert.equal(err.filter((l) => /truncated/i.test(l)).length, 0, "successful chunks must not log truncation");
});

test("#260: a small file is still one LLM call", async () => {
  const model = new CeilingModel();
  const out = await new ChatCruxSummarizer(model).describeFile(denseInput(5));
  assert.equal(out.length, 5);
  assert.equal(model.calls, 1);
  assert.deepEqual(model.sizes, [5]);
});

test("#260: finish_reason=length is logged, not swallowed", async () => {
  const model = new TruncatedModel();
  const { result, err } = await withCapturedError(() =>
    new ChatCruxSummarizer(model).describeFile(denseInput(3)),
  );
  assert.equal(result.length, 0);
  assert.ok(
    err.some((l) => /truncated/i.test(l) && /finish_reason=length/.test(l)),
    `truncation must be logged, got: ${err.join(" | ") || "(silence)"}`,
  );
});

test("#260: empty chunks stay pending and are not cached as ready (#177)", async () => {
  const { nodes, sources } = denseNodes(DENSE);
  const summarizer = new ChatCruxSummarizer(new EmptyModel());
  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.computed, 0);
  assert.equal(stats.failedFiles, 1);
  assert.ok(stats.errors.length > 0);
  for (const n of nodes) {
    assert.equal(n.summary_state, "pending", "empty chunk must not flip the node to ready");
    assert.equal(n.summary, null);
  }
});

test("#260: a later empty chunk does not wipe earlier summaries or cache the empty ids", async () => {
  const { nodes, sources } = denseNodes(DENSE);
  const summarizer = new ChatCruxSummarizer(new FirstChunkOnlyModel());
  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.ok(stats.computed >= CRUX_CHUNK_SIZE, "first chunk's summaries must be kept");
  assert.ok(stats.pending > 0, "ids the later chunks missed must remain retryable");
  const ready = nodes.filter((n) => n.summary_state === "ready");
  const pending = nodes.filter((n) => n.summary_state === "pending");
  assert.equal(ready.length, stats.computed);
  assert.equal(pending.length, stats.pending);
  for (const n of pending) assert.equal(n.summary, null);
});

function denseInput(n: number): FileCruxInput {
  return {
    path: "dense.ts",
    source: "export const x = 1;\n",
    nodes: Array.from({ length: n }, (_, i) => ref(i)),
  };
}

function ref(i: number): NodeRef {
  return {
    id: `dense.ts#f${i}`,
    kind: "function",
    signature: `f${i}()`,
    startLine: 1,
    endLine: 1,
  };
}

function denseNodes(n: number): { nodes: NodeV1[]; sources: Map<string, string> } {
  const path = "dense.ts";
  return {
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `${path}#f${i}`,
      name: `f${i}`,
      kind: "function",
      path,
      span: "L1-L1",
      signature: `f${i}()`,
      exported: true,
      origin: "ast",
      body_hash: `h-${i}`,
      summary_state: "pending",
      summary: null,
      crux: null,
    })),
    sources: new Map([[path, "export const x = 1;\n"]]),
  };
}

function requestedIds(req: ChatRequest): string[] {
  const user = req.messages.find((m) => m.role === "user")?.content ?? "";
  return [...user.matchAll(/^- id=(\S+)/gm)].map((m) => m[1]);
}

function okReply(ids: string[]): ChatResponse {
  const toolCalls: ToolCall[] = [
    {
      id: "1",
      name: "record_symbols",
      args: {
        symbols: ids.map((id) => ({ id, summary: `purpose of ${id}`, crux_start: 0, crux_end: 0 })),
      },
    },
  ];
  return {
    text: "",
    toolCalls,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    stopReason: "stop",
    assistant: { role: "assistant", content: "", toolCalls },
  };
}

/** Same shape the OpenAI adapter yields when JSON.parse of truncated tool args fails. */
function truncatedReply(): ChatResponse {
  const toolCalls: ToolCall[] = [{ id: "1", name: "record_symbols", args: {} }];
  return {
    text: "",
    toolCalls,
    usage: { input: 0, output: 8192, cacheRead: 0, cacheCreate: 0 },
    stopReason: "length",
    assistant: { role: "assistant", content: "", toolCalls },
  };
}

function emptyReply(): ChatResponse {
  return {
    text: "",
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    stopReason: "stop",
    assistant: { role: "assistant", content: "" },
  };
}

/** Truncates (and drops) any call packed above the observed ~125-symbol cliff. */
class CeilingModel implements ChatModel {
  readonly label = "fake:ceiling";
  calls = 0;
  sizes: number[] = [];
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    const ids = requestedIds(req);
    this.sizes.push(ids.length);
    if (ids.length > TRUNCATE_ABOVE) return truncatedReply();
    return okReply(ids);
  }
}

class TruncatedModel implements ChatModel {
  readonly label = "fake:truncated";
  async create(_req: ChatRequest): Promise<ChatResponse> {
    return truncatedReply();
  }
}

class EmptyModel implements ChatModel {
  readonly label = "fake:empty";
  async create(_req: ChatRequest): Promise<ChatResponse> {
    return emptyReply();
  }
}

/** Succeeds only for f0..f79 — later chunks (and the collectFileCrux retry) stay empty. */
class FirstChunkOnlyModel implements ChatModel {
  readonly label = "fake:first-chunk";
  async create(req: ChatRequest): Promise<ChatResponse> {
    const ids = requestedIds(req).filter((id) => {
      const n = Number(/#f(\d+)$/.exec(id)?.[1]);
      return Number.isFinite(n) && n < CRUX_CHUNK_SIZE;
    });
    if (ids.length === 0) return emptyReply();
    return okReply(ids);
  }
}

async function withCapturedError<T>(fn: () => Promise<T>): Promise<{ result: T; err: string[] }> {
  const err: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    err.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: await fn(), err };
  } finally {
    console.error = orig;
  }
}
