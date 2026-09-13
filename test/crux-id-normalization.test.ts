/**
 * A target line used to read `- id=<id> | <kind> | lines L1-L9 | <signature>`,
 * so the `id=` field had no terminator. A model told to return the id "verbatim"
 * copied the whole line, the returned id matched no node, every summary was
 * dropped, and the file was recorded as a total miss (`empty-parsed`) even
 * though the summaries themselves were fine — observed with qwen3.x on Ollama.
 *
 * The fix is both ends: `id=` is the LAST field on the line, and a whole-line
 * echo is repaired on the way back in (either layout).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer } from "../src/ai/crux.js";
import type { FileCruxInput } from "../src/ai/crux.js";
import type { ChatModel, ChatRequest, ChatResponse } from "../src/ai/llm/types.js";

/** Answers every crux call with ids taken from `ids`, in order. */
class IdEchoModel implements ChatModel {
  readonly label = "fake:crux-ids";
  lastUserContent = "";
  constructor(private readonly ids: string[]) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    this.lastUserContent = req.messages.find((m) => m.role === "user")?.content ?? "";
    const symbols = this.ids.map((id, i) => ({
      id,
      summary: `summary ${i}`,
      crux_start: 0,
      crux_end: 0,
    }));
    return {
      text: "",
      toolCalls: [{ id: "call_1", name: "record_symbols", args: { symbols } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "tool_calls",
      assistant: { role: "assistant", content: "" },
    };
  }
}

const input: FileCruxInput = {
  path: "tts/jobs.cjs",
  source: "const a = 1;\nfunction cancel() {}\n",
  nodes: [
    { id: "tts/jobs.cjs", kind: "file", signature: null, startLine: 1, endLine: 2 },
    { id: "tts/jobs.cjs#cancel", kind: "method", signature: "cancel()", startLine: 2, endLine: 2 },
  ],
};

test("the target line terminates the id, so a verbatim echo is unambiguous", async () => {
  const model = new IdEchoModel(["tts/jobs.cjs", "tts/jobs.cjs#cancel"]);
  await new ChatCruxSummarizer(model).describeFile(input);
  for (const line of model.lastUserContent.split("\n").filter((l) => l.startsWith("- "))) {
    assert.match(line, /\| id=\S+$/, `target line must end with the id: ${line}`);
  }
});

test("a bare id is returned unchanged", async () => {
  const model = new IdEchoModel(["tts/jobs.cjs", "tts/jobs.cjs#cancel"]);
  const out = await new ChatCruxSummarizer(model).describeFile(input);
  assert.deepEqual(
    out.map((c) => c.id),
    ["tts/jobs.cjs", "tts/jobs.cjs#cancel"],
  );
});

test("a whole-line echo of the current layout is repaired", async () => {
  const model = new IdEchoModel([
    "file | lines L1-L2 | id=tts/jobs.cjs",
    "method | lines L2-L2 | cancel() | id=tts/jobs.cjs#cancel",
  ]);
  const out = await new ChatCruxSummarizer(model).describeFile(input);
  assert.deepEqual(
    out.map((c) => c.id),
    ["tts/jobs.cjs", "tts/jobs.cjs#cancel"],
  );
});

test("a whole-line echo of the previous layout is repaired too", async () => {
  const model = new IdEchoModel([
    "tts/jobs.cjs | file | lines L1-L168",
    "tts/jobs.cjs#cancel | method | lines L27-L27 | cancel()",
  ]);
  const out = await new ChatCruxSummarizer(model).describeFile(input);
  assert.deepEqual(
    out.map((c) => c.id),
    ["tts/jobs.cjs", "tts/jobs.cjs#cancel"],
  );
});

test("a repaired reply is not classified as a miss", async () => {
  const model = new IdEchoModel(["file | lines L1-L2 | id=tts/jobs.cjs"]);
  const summarizer = new ChatCruxSummarizer(model);
  const out = await summarizer.describeFile(input);
  assert.equal(out[0]?.id, "tts/jobs.cjs");
  assert.equal(summarizer.lastMiss, null);
});
