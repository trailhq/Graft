/**
 * #259: deepseek-chat echoes the whole TARGET line into `record_symbols.id`.
 * `summary` / crux ranges are fine; enrich then looks up `results.get(node.id)`,
 * matches nothing, and every file dies as "no usable symbol summaries".
 *
 * These tests replay the captured payload against a fake ChatModel — no API key,
 * no network. Rescue peels only the TARGET-line suffix onto a requested id;
 * garbage and empty summaries still fail and stay uncached (#177).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer, peelEchoedCruxId, looksLikeEchoedTargetLine } from "../src/ai/crux.js";
import { enrichGraph } from "../src/graph/enrich.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";
import type { CruxSummarizer, FileCruxInput, NodeCrux, NodeRef } from "../src/ai/crux.js";
import type { NodeV1 } from "../src/graph/types.js";

/** Issue #259 captured tool-call `id` — the whole TARGET line, not the node id. */
const ECHOED_CTOR =
  "app/User.php#User.__construct | method | lines L40-L58 | public function __construct($object = null)";
const ECHOED_CLASS = "app/User.php#User | class | lines L1-L80 | class User";
const CTOR_ID = "app/User.php#User.__construct";
const CLASS_ID = "app/User.php#User";
const CTOR_SUMMARY =
  "Builds an User from a source object, copying matching public properties and wrapping each Properties entry into an UserProperties instance.";
const CLASS_SUMMARY = "A user entity hydrated from a source object.";

class FakeChatModel implements ChatModel {
  readonly label = "fake:model";
  last?: ChatRequest;
  constructor(private reply: { text?: string; toolCalls?: ToolCall[] }) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.last = req;
    return {
      text: this.reply.text ?? "",
      toolCalls: this.reply.toolCalls ?? [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "stop",
      assistant: { role: "assistant", content: this.reply.text ?? "" },
    };
  }
}

const CTOR_REF: NodeRef = {
  id: CTOR_ID,
  kind: "method",
  signature: "public function __construct($object = null)",
  startLine: 40,
  endLine: 58,
};
const CLASS_REF: NodeRef = {
  id: CLASS_ID,
  kind: "class",
  signature: "class User",
  startLine: 1,
  endLine: 80,
};

function phpSource(): string {
  return Array.from({ length: 80 }, (_, i) => {
    const n = i + 1;
    if (n === 1) return "class User";
    if (n === 40) return "    public function __construct($object = null)";
    if (n === 47) return "        $this->hydrate($object);";
    return `        // line ${n}`;
  }).join("\n");
}

function phpNode(id: string, name: string, kind: NodeV1["kind"], span: string, signature: string | null): NodeV1 {
  return {
    id,
    name,
    kind,
    path: "app/User.php",
    span,
    signature,
    exported: true,
    origin: "ast",
    body_hash: `h-${id}`,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function phpNodes(): NodeV1[] {
  return [
    phpNode(CLASS_ID, "User", "class", "L1-L80", "class User"),
    phpNode(CTOR_ID, "__construct", "method", "L40-L58", "public function __construct($object = null)"),
  ];
}

function issuePayload(overrides: Partial<{ id: string; summary: string }>[] = []): { symbols: unknown[] } {
  const defaults = [
    { id: ECHOED_CTOR, summary: CTOR_SUMMARY, crux_start: 47, crux_end: 57 },
    { id: ECHOED_CLASS, summary: CLASS_SUMMARY, crux_start: 0, crux_end: 0 },
  ];
  return {
    symbols: defaults.map((d, i) => ({ ...d, ...overrides[i] })),
  };
}

test("#259: peelEchoedCruxId strips the captured TARGET-line suffix onto the node id", () => {
  assert.equal(peelEchoedCruxId(ECHOED_CTOR, [CTOR_ID, CLASS_ID]), CTOR_ID);
  assert.equal(peelEchoedCruxId(ECHOED_CLASS, [CTOR_ID, CLASS_ID]), CLASS_ID);
  assert.equal(peelEchoedCruxId(`id=${ECHOED_CTOR}`, [CTOR_ID]), CTOR_ID);
  assert.equal(peelEchoedCruxId(`"${ECHOED_CTOR}"`, [CTOR_ID]), CTOR_ID);
  assert.ok(looksLikeEchoedTargetLine(ECHOED_CTOR));
  assert.equal(looksLikeEchoedTargetLine(CTOR_ID), false);
});

test("#259: a lone pipe is not an echo — garbage ids are not rewritten", () => {
  assert.equal(peelEchoedCruxId("hello | world", [CTOR_ID]), "hello | world");
  assert.equal(
    peelEchoedCruxId("totally-wrong | method | lines L1-L2 | function zzz()", [CTOR_ID]),
    "totally-wrong | method | lines L1-L2 | function zzz()",
  );
  assert.equal(peelEchoedCruxId(CTOR_ID, [CTOR_ID]), CTOR_ID);
});

test("#259: prefix fallback picks the longest requested id when 'lines L' is missing", () => {
  const short = "src/a.ts#Foo";
  const long = "src/a.ts#Foo.bar";
  assert.equal(peelEchoedCruxId(`${long} | method | L1-L2`, [short, long]), long);
  assert.equal(peelEchoedCruxId(`${short} | method | L1-L2`, [short, long]), short);
});

test("#259: ChatCruxSummarizer recovers the issue sample without an API call", async () => {
  const m = new FakeChatModel({
    toolCalls: [{ id: "1", name: "record_symbols", args: issuePayload() }],
  });
  const out = await new ChatCruxSummarizer(m).describeFile({
    path: "app/User.php",
    source: phpSource(),
    nodes: [CTOR_REF, CLASS_REF],
  });
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((s) => s.id).sort(),
    [CTOR_ID, CLASS_ID].sort(),
  );
  assert.equal(out.find((s) => s.id === CTOR_ID)?.summary, CTOR_SUMMARY);
  assert.equal(out.find((s) => s.id === CTOR_ID)?.crux_start, 47);
  assert.equal(out.find((s) => s.id === CTOR_ID)?.crux_end, 57);
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_symbols" });
});

test("#259: a clean toolCalls payload is unchanged (regression)", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      {
        id: "1",
        name: "record_symbols",
        args: { symbols: [{ id: "sym1", summary: "does x", crux_start: 3.9, crux_end: 5 }] },
      },
    ],
  });
  const out = await new ChatCruxSummarizer(m).describeFile({
    path: "a.ts",
    source: "l1\nl2\nl3\nl4\nl5\n",
    nodes: [{ id: "sym1", kind: "function", signature: null, startLine: 1, endLine: 5 }],
  });
  assert.deepEqual(out, [{ id: "sym1", summary: "does x", crux_start: 3, crux_end: 5 }]);
});

test("#259: enrich applies echoed ids and does not leave the file pending", async () => {
  const summarizer = new ChatCruxSummarizer(
    new FakeChatModel({ toolCalls: [{ id: "1", name: "record_symbols", args: issuePayload() }] }),
  );
  const nodes = phpNodes();
  const sources = new Map([["app/User.php", phpSource()]]);

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.computed, 2);
  assert.equal(stats.pending, 0);
  assert.equal(stats.failedFiles, 0);
  assert.equal(stats.errors.length, 0);
  for (const n of nodes) {
    assert.equal(n.summary_state, "ready");
    assert.ok(n.summary && n.summary.trim().length > 0);
  }
  assert.equal(nodes.find((n) => n.id === CTOR_ID)?.summary, CTOR_SUMMARY);
});

test("#259: a rescued file is a cache hit on the next --deep, not a retry", async () => {
  const summarizer = new ChatCruxSummarizer(
    new FakeChatModel({ toolCalls: [{ id: "1", name: "record_symbols", args: issuePayload() }] }),
  );
  const nodes = phpNodes();
  const sources = new Map([["app/User.php", phpSource()]]);
  await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  const prior = new Map(nodes.map((n) => [n.id, structuredClone(n)]));
  let calls = 0;
  const counting: CruxSummarizer = {
    async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
      calls++;
      return input.nodes.map((n) => ({ id: n.id, summary: "should not run", crux_start: 0, crux_end: 0 }));
    },
  };
  const again = phpNodes();
  const second = await enrichGraph(again, prior, sources, { summarizer: counting, concurrency: 1 });
  assert.equal(calls, 0);
  assert.equal(second.cached, 2);
  assert.equal(second.computed, 0);
});

test("#259: an echo that peels to an id we did not ask for is a named failure, not a cache hit", async () => {
  const foreign =
    "app/Other.php#Other.boot | method | lines L1-L2 | public function boot()";
  const summarizer = new ChatCruxSummarizer(
    new FakeChatModel({
      toolCalls: [
        {
          id: "1",
          name: "record_symbols",
          args: { symbols: [{ id: foreign, summary: CLASS_SUMMARY, crux_start: 0, crux_end: 0 }] },
        },
      ],
    }),
  );
  const nodes = phpNodes();
  const sources = new Map([["app/User.php", phpSource()]]);
  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.computed, 0);
  assert.equal(stats.pending, 2);
  assert.equal(stats.failedFiles, 1);
  assert.match(stats.errors[0] ?? "", /echoed the target line/i);
  for (const n of nodes) {
    assert.equal(n.summary_state, "pending");
    assert.equal(n.summary, null);
  }
});

test("#259: echoed ids with blank summaries stay pending — not cached as ready (#177)", async () => {
  const summarizer = new ChatCruxSummarizer(
    new FakeChatModel({
      toolCalls: [{ id: "1", name: "record_symbols", args: issuePayload([{ summary: "  " }, { summary: "" }]) }],
    }),
  );
  const nodes = phpNodes();
  const sources = new Map([["app/User.php", phpSource()]]);
  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.computed, 0);
  assert.equal(stats.pending, 2);
  assert.match(stats.errors[0] ?? "", /no usable symbol summaries/i);
  for (const n of nodes) {
    assert.equal(n.summary_state, "pending", "blank summary must not flip the node to ready");
    assert.equal(n.summary, null);
  }
});

test("#259: unmatched ids that are not an echo say so, instead of the blank-summary string", async () => {
  const summarizer = new ChatCruxSummarizer(
    new FakeChatModel({
      toolCalls: [
        {
          id: "1",
          name: "record_symbols",
          args: { symbols: [{ id: "not-a-node", summary: "something coherent", crux_start: 0, crux_end: 0 }] },
        },
      ],
    }),
  );
  const nodes = phpNodes();
  const sources = new Map([["app/User.php", phpSource()]]);
  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.computed, 0);
  assert.equal(stats.failedFiles, 1);
  assert.match(stats.errors[0] ?? "", /did not match any target/i);
  assert.doesNotMatch(stats.errors[0] ?? "", /no usable symbol summaries/);
});

test("#259: empty tool args are a miss-class failure, not an echo", async () => {
  const summarizer = new ChatCruxSummarizer(
    new FakeChatModel({
      // Same shape the OpenAI adapter yields when JSON.parse of arguments fails.
      toolCalls: [{ id: "1", name: "record_symbols", args: {} }],
    }),
  );
  const nodes = phpNodes();
  const sources = new Map([["app/User.php", phpSource()]]);
  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });

  assert.equal(stats.computed, 0);
  assert.equal(stats.pending, 2);
  assert.equal(stats.failedFiles, 1);
  // #254 names this via miss class + finish_reason, not the old "empty or truncated" string.
  assert.match(stats.errors[0] ?? "", /\[(unparseable|empty-toolCalls|truncated)/);
  assert.doesNotMatch(stats.errors[0] ?? "", /echoed the target line/);
  for (const n of nodes) assert.equal(n.summary_state, "pending");
});
