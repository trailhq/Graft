/**
 * #298: `userContent` renders targets as `id=${n.id} | kind | lines Lx-Ly`.
 * File-node ids are bare paths, so models that "use that id verbatim" echo the
 * whole decoration. Matching must strip it — never apply by list order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer, normalizeCruxId } from "../src/ai/crux.js";
import { enrichGraph } from "../src/graph/enrich.js";
import type { CruxSummarizer, FileCruxInput, NodeCrux } from "../src/ai/crux.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall } from "../src/ai/llm/types.js";
import type { NodeV1 } from "../src/graph/types.js";

class CannedModel implements ChatModel {
  readonly label = "fake:file-id";
  last?: ChatRequest;
  constructor(private readonly symbols: unknown[]) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.last = req;
    const toolCalls: ToolCall[] = [
      { id: "1", name: "record_symbols", args: { symbols: this.symbols } },
    ];
    return {
      text: "",
      toolCalls,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "tool_calls",
      assistant: { role: "assistant", content: "" },
    };
  }
}

function fileNode(path: string, span = "L1-L243"): NodeV1 {
  return {
    id: path,
    name: path.split("/").pop() ?? path,
    kind: "file",
    path,
    span,
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: `h-${path}`,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

function fnNode(path: string, name: string): NodeV1 {
  return {
    id: `${path}#${name}`,
    name,
    kind: "function",
    path,
    span: "L1-L3",
    signature: `${name}()`,
    exported: true,
    origin: "ast",
    body_hash: `h-${name}`,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

test("#298: normalizeCruxId strips the TARGET decoration and leaves bare symbol ids", () => {
  assert.equal(
    normalizeCruxId("src/some/dir/file.py | file | lines L1-L243"),
    "src/some/dir/file.py",
  );
  assert.equal(normalizeCruxId("src/calc.py#add"), "src/calc.py#add");
  assert.equal(
    normalizeCruxId("src/calc.py#add | function | lines L1-L3 | add()"),
    "src/calc.py#add",
  );
});

test("#298: describeFile maps a decorated file-node echo onto the bare path", async () => {
  const path = "src/some/dir/file.py";
  const m = new CannedModel([
    {
      id: `${path} | file | lines L1-L243`,
      summary: "module that wires the parser",
      crux_start: 158,
      crux_end: 184,
    },
  ]);
  const out = await new ChatCruxSummarizer(m).describeFile({
    path,
    source: "x\n".repeat(243),
    nodes: [{ id: path, kind: "file", signature: null, startLine: 1, endLine: 243 }],
  });
  assert.equal(m.last?.maxTokens, 8192);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, path);
  assert.equal(out[0].summary, "module that wires the parser");
});

test("#298: describeFile keeps path#Symbol ids that were already echoed bare", async () => {
  const out = await new ChatCruxSummarizer(
    new CannedModel([
      { id: "src/calc.py#add", summary: "adds two numbers", crux_start: 0, crux_end: 0 },
    ]),
  ).describeFile({
    path: "src/calc.py",
    source: "def add(a, b):\n  return a + b\n",
    nodes: [{ id: "src/calc.py#add", kind: "function", signature: "add()", startLine: 1, endLine: 2 }],
  });
  assert.equal(out[0].id, "src/calc.py#add");
});

test("#298: enrich applies a decorated file-node id and a bare function id in the same file", async () => {
  const path = "src/calc.py";
  const nodes = [fileNode(path), fnNode(path, "add")];
  const sources = new Map([[path, "def add(a, b):\n  return a + b\n"]]);
  const summarizer: CruxSummarizer = {
    async describeFile(input: FileCruxInput): Promise<NodeCrux[]> {
      return input.nodes.map((n) =>
        n.kind === "file"
          ? {
              id: `${n.id} | file | lines L${n.startLine}-L${n.endLine}`,
              summary: "calc module",
              crux_start: 0,
              crux_end: 0,
            }
          : { id: n.id, summary: `purpose of ${n.id}`, crux_start: 0, crux_end: 0 },
      );
    },
  };

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });
  assert.equal(stats.computed, 2);
  assert.equal(stats.pending, 0);
  assert.equal(stats.failedFiles, 0);
  assert.equal(nodes[0].summary_state, "ready");
  assert.equal(nodes[0].summary, "calc module");
  assert.equal(nodes[1].summary_state, "ready");
  assert.equal(nodes[1].summary, "purpose of src/calc.py#add");
});

test("#298: unmatched ids are dropped, not applied by order, and stay uncached", async () => {
  const path = "src/calc.py";
  const nodes = [fileNode(path), fnNode(path, "add")];
  const sources = new Map([[path, "def add(a, b):\n  return a + b\n"]]);
  const summarizer: CruxSummarizer = {
    async describeFile(): Promise<NodeCrux[]> {
      return [
        {
          id: "other.py | file | lines L1-L10",
          summary: "must not land on the first node by position",
          crux_start: 0,
          crux_end: 0,
        },
      ];
    },
  };

  const stats = await enrichGraph(nodes, new Map(), sources, { summarizer, concurrency: 1 });
  assert.equal(stats.computed, 0);
  assert.equal(stats.pending, 2);
  assert.equal(stats.failedFiles, 1);
  assert.match(stats.errors[0] ?? "", /id-mismatch/);
  assert.match(stats.errors[0] ?? "", /matched no requested id/);
  for (const n of nodes) {
    assert.equal(n.summary_state, "pending");
    assert.equal(n.summary, null);
  }
});
