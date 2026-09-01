/**
 * Network-free tests for the LiteLLM provider. A LiteLLM proxy is
 * OpenAI-compatible, so the adapter reuses the OpenAI translation (verified in
 * llm-adapters.test.ts); here we assert the litellm-specific behavior: reuse of
 * that translation, the `litellm:` label, factory wiring, and `/v1/models`
 * auto-discovery. Stub clients mean no key and no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { LiteLLMChatModel, listLiteLLMModels, DEFAULT_LITELLM_BASE_URL } from "../src/ai/llm/litellm.js";
import { createChatModel } from "../src/ai/llm/factory.js";

function fakeOpenAI(resp: unknown) {
  const box: { params?: any } = {};
  const client = {
    chat: { completions: { create: async (params: any) => ((box.params = params), resp) } },
  } as unknown as OpenAI;
  return { client, box };
}

function openAiResp(over: Partial<any> = {}): any {
  return {
    choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...over,
  };
}

test("litellm: reuses OpenAI-compatible translation and labels as litellm", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new LiteLLMChatModel({ apiKey: "x", model: "anthropic/claude-3-5-sonnet", client });
  const res = await m.create({ messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(box.params.model, "anthropic/claude-3-5-sonnet");
  assert.equal(box.params.temperature, 0); // OpenAI-compatible: temperature forwarded
  assert.equal(res.text, "ok");
  assert.equal(m.label, "litellm:anthropic/claude-3-5-sonnet");
});

test("litellm: /v1/models auto-discovery returns the proxy's model ids", async () => {
  const client = {
    models: {
      list: async () => ({
        data: [{ id: "openai/gpt-4o-mini" }, { id: "anthropic/claude-3-5-sonnet" }],
      }),
    },
  } as unknown as OpenAI;
  const ids = await listLiteLLMModels({ apiKey: "x", client });
  assert.deepEqual(ids, ["openai/gpt-4o-mini", "anthropic/claude-3-5-sonnet"]);
});

test("litellm: factory builds a LiteLLMChatModel for provider 'litellm'", () => {
  const m = createChatModel({ provider: "litellm", apiKey: "x", model: "gpt-4o-mini" });
  assert.ok(m instanceof LiteLLMChatModel);
  assert.equal(m.label, "litellm:gpt-4o-mini");
});

test("litellm: exposes a default proxy base URL", () => {
  assert.equal(DEFAULT_LITELLM_BASE_URL, "http://localhost:4000");
});
