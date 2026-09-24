/**
 * Network-free tests for the Atlas Cloud provider. The Atlas Cloud gateway is
 * OpenAI-compatible, so the adapter reuses the OpenAI translation (verified in
 * llm-adapters.test.ts); here we assert the atlascloud-specific behavior: reuse
 * of that translation, the `atlascloud:` label, factory wiring, the default
 * base URL, and `/v1/models` auto-discovery. Stub clients mean no key and no
 * network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  AtlasCloudChatModel,
  listAtlasCloudModels,
  DEFAULT_ATLASCLOUD_BASE_URL,
} from "../src/ai/llm/atlascloud.js";
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

test("atlascloud: reuses OpenAI-compatible translation and labels as atlascloud", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new AtlasCloudChatModel({ apiKey: "x", model: "zai-org/glm-5", client });
  const res = await m.create({ messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(box.params.model, "zai-org/glm-5");
  assert.equal(box.params.temperature, 0); // OpenAI-compatible: temperature forwarded
  assert.equal(res.text, "ok");
  assert.equal(m.label, "atlascloud:zai-org/glm-5");
});

test("atlascloud: /v1/models auto-discovery returns the gateway's model ids", async () => {
  const client = {
    models: {
      list: async () => ({
        data: [{ id: "zai-org/glm-5" }, { id: "deepseek-ai/DeepSeek-V3.1" }],
      }),
    },
  } as unknown as OpenAI;
  const ids = await listAtlasCloudModels({ apiKey: "x", client });
  assert.deepEqual(ids, ["zai-org/glm-5", "deepseek-ai/DeepSeek-V3.1"]);
});

test("atlascloud: factory builds an AtlasCloudChatModel for provider 'atlascloud'", () => {
  const m = createChatModel({ provider: "atlascloud", apiKey: "x", model: "moonshotai/kimi-k2.6" });
  assert.ok(m instanceof AtlasCloudChatModel);
  assert.equal(m.label, "atlascloud:moonshotai/kimi-k2.6");
});

test("atlascloud: exposes a default gateway base URL", () => {
  assert.equal(DEFAULT_ATLASCLOUD_BASE_URL, "https://api.atlascloud.ai/v1");
});
