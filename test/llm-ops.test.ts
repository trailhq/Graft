/**
 * The three engine ops (summarize / synthesize / crux) over a fake transport —
 * proves each builds the right ChatRequest and parses the response, with no key
 * and no network. Structured ops (synthesize, crux) ride forced tool-calling;
 * summarize is plain text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatSummarizer } from "../src/ai/summarize.js";
import { ChatSynthesizer } from "../src/ai/synthesize.js";
import { ChatCruxSummarizer, normalizeTargetId } from "../src/ai/crux.js";
import { recoverToolArgsFromContent } from "../src/ai/llm/recover-tool.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";

/** Records the last request and replays a canned response. */
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

test("ChatSummarizer sends plain text and returns trimmed content", async () => {
  const m = new FakeChatModel({ text: "  a prose summary  " });
  const out = await new ChatSummarizer(m).summarize("code", { path: "a.ts" });
  assert.equal(out, "a prose summary");
  assert.equal(m.last?.responseFormat, undefined); // plain text
  assert.equal(m.last?.messages[0].role, "system");
});

test("ChatSynthesizer forces record_graph and cleans parsed args", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      {
        id: "1",
        name: "record_graph",
        args: { nodes: [{ name: "Auth", type: "system", summary: "s", sources: ["a.ts"], links: [] }] },
      },
    ],
  });
  const nodes = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_graph" });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
});

test("ChatCruxSummarizer forces record_symbols and normalizes numbers", async () => {
  const m = new FakeChatModel({
    toolCalls: [
      { id: "1", name: "record_symbols", args: { symbols: [{ id: "sym1", summary: "does x", crux_start: 3.9, crux_end: 5 }] } },
    ],
  });
  const out = await new ChatCruxSummarizer(m).describeFile({
    path: "a.ts",
    source: "l1\nl2\nl3\nl4\nl5\n",
    nodes: [{ id: "sym1", kind: "function", signature: null, startLine: 1, endLine: 5 }],
  });
  assert.deepEqual(m.last?.responseFormat, { kind: "tool", name: "record_symbols" });
  assert.deepEqual(out, [{ id: "sym1", summary: "does x", crux_start: 3, crux_end: 5 }]);
});

test("ChatCruxSummarizer tolerates a model echoing the whole target line as the id (#327)", async () => {
  // Grok copies `id=<id> | <kind> | lines L1-L5` verbatim into `id`; the summary must still land on the node.
  const m = new FakeChatModel({
    toolCalls: [
      {
        id: "1",
        name: "record_symbols",
        args: {
          symbols: [
            { id: "a.ts | file | lines L1-L5", summary: "whole file", crux_start: 1, crux_end: 5 },
            { id: "id=sym1", summary: "does x", crux_start: 2, crux_end: 3 },
            { id: "  sym2  ", summary: "does y", crux_start: 4, crux_end: 5 },
            // Not a requested id: the ` | ` is not an echoed target line, so it stays as returned.
            { id: "nope | function | lines L1-L2", summary: "unknown", crux_start: 1, crux_end: 2 },
          ],
        },
      },
    ],
  });
  const out = await new ChatCruxSummarizer(m).describeFile({
    path: "a.ts",
    source: "l1\nl2\nl3\nl4\nl5\n",
    nodes: [
      { id: "a.ts", kind: "file", signature: null, startLine: 1, endLine: 5 },
      { id: "sym1", kind: "function", signature: null, startLine: 2, endLine: 3 },
      { id: "sym2", kind: "function", signature: null, startLine: 4, endLine: 5 },
    ],
  });
  assert.deepEqual(
    out.map((r) => r.id),
    ["a.ts", "sym1", "sym2", "nope | function | lines L1-L2"],
  );
});

test("normalizeTargetId peels the echoed target line and the id= prefix", () => {
  assert.equal(normalizeTargetId("src/a.ts#f"), "src/a.ts#f");
  assert.equal(normalizeTargetId("src/a.ts#f | function | lines L3-L9"), "src/a.ts#f");
  assert.equal(normalizeTargetId("id=src/a.ts#f | function | lines L3-L9"), "src/a.ts#f");
  assert.equal(normalizeTargetId("id=src/a.ts#f"), "src/a.ts#f");
  // deepseek (#259) also appends the signature, which may itself contain ` | `.
  assert.equal(
    normalizeTargetId("app/User.php#User.__construct | method | lines L40-L58 | public function __construct($object = null)"),
    "app/User.php#User.__construct",
  );
});

test("normalizeTargetId only rewrites onto a requested id when given the expected set", () => {
  const expected = new Set(["src/a.ts#f", "odd | id"]);
  assert.equal(normalizeTargetId("src/a.ts#f | function | lines L3-L9", expected), "src/a.ts#f");
  assert.equal(normalizeTargetId("id=src/a.ts#f", expected), "src/a.ts#f");
  // A requested id is returned verbatim even when it contains the separator.
  assert.equal(normalizeTargetId("odd | id", expected), "odd | id");
  // Garbage that merely contains ` | ` is not truncated into something we never asked for.
  assert.equal(normalizeTargetId("garbage | x", expected), "garbage | x");
  assert.equal(normalizeTargetId("id=other#g | function | lines L1-L2", expected), "id=other#g | function | lines L1-L2");
});

test("structured ops degrade gracefully when the model returns no tool call", async () => {
  const empty = new FakeChatModel({ toolCalls: [] });
  const { err } = await withCapturedError(async () => {
    assert.deepEqual(await new ChatSynthesizer(empty).synthesize([{ path: "a.ts", summary: "x" }]), []);
    assert.deepEqual(
      await new ChatCruxSummarizer(empty).describeFile({
        path: "a.ts",
        source: "x",
        nodes: [{ id: "s", kind: "function", signature: null, startLine: 1, endLine: 1 }],
      }),
      [],
    );
  });
  assert.ok(err.some((l) => /synthesize:.*no tool call and no content/.test(l)));
  assert.ok(err.some((l) => /crux:.*no tool call and no content/.test(l)));
});

const AUTH_NODE = { name: "Auth", type: "system", summary: "s", sources: ["a.ts"], links: [] as [] };
const AUTH_PAYLOAD = { nodes: [AUTH_NODE] };

test("#129: ChatSynthesizer recovers nodes from content JSON when toolCalls is empty", async () => {
  const m = new FakeChatModel({
    text: JSON.stringify([{ name: "emit_json", parameters: AUTH_PAYLOAD }]),
    toolCalls: [],
  });
  const { result: nodes, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
  assert.equal(err.length, 0);
});

test("#129: ChatSynthesizer recovers a single-object wrapper and a fenced JSON payload", async () => {
  const objectWrap = new FakeChatModel({
    text: JSON.stringify({ name: "record_graph", parameters: AUTH_PAYLOAD }),
    toolCalls: [],
  });
  assert.equal((await new ChatSynthesizer(objectWrap).synthesize([{ path: "a.ts", summary: "x" }]))[0]?.name, "Auth");

  const fenced = new FakeChatModel({
    text: "```json\n" + JSON.stringify(AUTH_PAYLOAD) + "\n```",
    toolCalls: [],
  });
  assert.equal((await new ChatSynthesizer(fenced).synthesize([{ path: "a.ts", summary: "x" }]))[0]?.name, "Auth");
});

test("#129: unparseable content warns and does not throw", async () => {
  const m = new FakeChatModel({ text: "The architecture is a layered monolith.", toolCalls: [] });
  const { result: nodes, err } = await withCapturedError(() =>
    new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]),
  );
  assert.deepEqual(nodes, []);
  assert.ok(err.some((l) => /synthesize:.*not parseable tool-call JSON/.test(l)));
});

test("#129: a real toolCalls payload is preferred over content JSON", async () => {
  const m = new FakeChatModel({
    text: JSON.stringify({ nodes: [{ name: "WRONG", type: "system", summary: "s", sources: ["a.ts"], links: [] }] }),
    toolCalls: [{ id: "1", name: "record_graph", args: AUTH_PAYLOAD }],
  });
  const nodes = await new ChatSynthesizer(m).synthesize([{ path: "a.ts", summary: "x" }]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Auth");
});

const RECOVER_OPTS = { toolNames: ["record_graph", "emit_json"] as const, payloadKey: "nodes" };

test("#129: recoverToolArgsFromContent accepts the three issue shapes and refuses the rest", () => {
  const payload = { nodes: [{ name: "Auth" }] };
  assert.deepEqual(
    recoverToolArgsFromContent(JSON.stringify([{ name: "emit_json", parameters: payload }]), RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  assert.deepEqual(
    recoverToolArgsFromContent(JSON.stringify({ name: "record_graph", parameters: payload }), RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  assert.deepEqual(
    recoverToolArgsFromContent("```json\n" + JSON.stringify(payload) + "\n```", RECOVER_OPTS)?.nodes,
    payload.nodes,
  );
  // CodeQL js/polynomial-redos: spaces around a fence must stay linear and still parse.
  const padded =
    " ".repeat(8_000) + "```json" + " ".repeat(8_000) + JSON.stringify(payload) + " ".repeat(8_000) + "```";
  assert.deepEqual(recoverToolArgsFromContent(padded, RECOVER_OPTS)?.nodes, payload.nodes);
  assert.equal(recoverToolArgsFromContent("The architecture is a layered monolith.", RECOVER_OPTS), undefined);
  assert.equal(recoverToolArgsFromContent("", RECOVER_OPTS), undefined);
  assert.equal(
    recoverToolArgsFromContent('[{"name":"emit_json","parameters":{"nodes":[', RECOVER_OPTS),
    undefined,
  );
  assert.equal(
    recoverToolArgsFromContent(JSON.stringify([{ name: "other_tool", parameters: payload }]), RECOVER_OPTS),
    undefined,
  );
});

/** Capture console.error so tests can assert the #129 warnings without leaking them. */
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
