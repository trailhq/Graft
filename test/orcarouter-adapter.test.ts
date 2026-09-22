/**
 * Network-free tests for the OrcaRouter provider. The OrcaRouter gateway is
 * OpenAI-compatible, so the adapter reuses the OpenAI translation (verified in
 * llm-adapters.test.ts); here we assert the orcarouter-specific behavior: reuse
 * of that translation, the `orcarouter:` label, factory wiring, the default
 * base URL, and `/v1/models` auto-discovery. Stub clients mean no key and no
 * network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  OrcaRouterChatModel,
  listOrcaRouterModels,
  DEFAULT_ORCAROUTER_BASE_URL,
} from "../src/ai/llm/orcarouter.js";
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

test("orcarouter: reuses OpenAI-compatible translation and labels as orcarouter", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new OrcaRouterChatModel({ apiKey: "x", model: "openai/gpt-4o-mini", client });
  const res = await m.create({ messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(box.params.model, "openai/gpt-4o-mini");
  assert.equal(box.params.temperature, 0); // OpenAI-compatible: temperature forwarded
  assert.equal(res.text, "ok");
  assert.equal(m.label, "orcarouter:openai/gpt-4o-mini");
});

test("orcarouter: /v1/models auto-discovery returns the gateway's model ids", async () => {
  const client = {
    models: {
      list: async () => ({
        data: [{ id: "openai/gpt-4o-mini" }, { id: "anthropic/claude-sonnet-5" }],
      }),
    },
  } as unknown as OpenAI;
  const ids = await listOrcaRouterModels({ apiKey: "x", client });
  assert.deepEqual(ids, ["openai/gpt-4o-mini", "anthropic/claude-sonnet-5"]);
});

test("orcarouter: factory builds an OrcaRouterChatModel for provider 'orcarouter'", () => {
  const m = createChatModel({ provider: "orcarouter", apiKey: "x", model: "gpt-4o-mini" });
  assert.ok(m instanceof OrcaRouterChatModel);
  assert.equal(m.label, "orcarouter:gpt-4o-mini");
});

test("orcarouter: exposes a default gateway base URL", () => {
  assert.equal(DEFAULT_ORCAROUTER_BASE_URL, "https://api.orcarouter.ai/v1");
});
