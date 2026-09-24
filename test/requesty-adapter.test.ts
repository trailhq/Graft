/**
 * Network-free tests for the Requesty provider. The Requesty router is
 * OpenAI-compatible, so the adapter reuses the OpenAI translation (verified in
 * llm-adapters.test.ts); here we assert the requesty-specific behavior: reuse
 * of that translation, the `requesty:` label, factory wiring, the default
 * base URL, and model auto-discovery that merges `/v1/models/managed` with
 * `/v1/models`. Stub clients mean no key and no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  RequestyChatModel,
  listRequestyModels,
  DEFAULT_REQUESTY_BASE_URL,
} from "../src/ai/llm/requesty.js";
import { createChatModel } from "../src/ai/llm/factory.js";
import { resolveConfig } from "../src/ai/providers.js";

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

test("requesty: reuses OpenAI-compatible translation and labels as requesty", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new RequestyChatModel({ apiKey: "x", model: "openai/gpt-4o-mini", client });
  const res = await m.create({ messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(box.params.model, "openai/gpt-4o-mini");
  assert.equal(box.params.temperature, 0); // OpenAI-compatible: temperature forwarded
  assert.equal(res.text, "ok");
  assert.equal(m.label, "requesty:openai/gpt-4o-mini");
});

test("requesty: auto-discovery lists managed policies first, then the catalog, chat only, de-duplicated", async () => {
  const paths: string[] = [];
  const client = {
    get: async (path: string) => {
      paths.push(path);
      return {
        data: [
          { id: "claude-sonnet-4-5", api: "chat" },
          { id: "gpt-5-mini@eu", api: "chat" },
          { id: "openai/gpt-4o-mini", api: "chat" },
        ],
      };
    },
    models: {
      list: async () => ({
        data: [
          { id: "openai/gpt-4o-mini", api: "chat" },
          { id: "openai/text-embedding-3-small", api: "embedding" },
          { id: "anthropic/claude-sonnet-4-5", api: "chat" },
        ],
      }),
    },
  } as unknown as OpenAI;
  const ids = await listRequestyModels({ apiKey: "x", client });
  assert.deepEqual(paths, ["/models/managed"]);
  assert.deepEqual(ids, [
    "claude-sonnet-4-5",
    "gpt-5-mini@eu",
    "openai/gpt-4o-mini",
    "anthropic/claude-sonnet-4-5",
  ]);
});

test("requesty: auto-discovery falls back to the catalog when the managed endpoint fails", async () => {
  const client = {
    get: async () => {
      throw new Error("managed unavailable");
    },
    models: { list: async () => ({ data: [{ id: "openai/gpt-4o-mini", api: "chat" }] }) },
  } as unknown as OpenAI;
  const ids = await listRequestyModels({ apiKey: "x", client });
  assert.deepEqual(ids, ["openai/gpt-4o-mini"]);
});

test("requesty: auto-discovery rejects only when both endpoints fail", async () => {
  const client = {
    get: async () => {
      throw new Error("managed unavailable");
    },
    models: {
      list: async () => {
        throw new Error("catalog unavailable");
      },
    },
  } as unknown as OpenAI;
  await assert.rejects(listRequestyModels({ apiKey: "x", client }), /managed unavailable/);
});

test("requesty: factory builds a RequestyChatModel for provider 'requesty'", () => {
  const m = createChatModel({ provider: "requesty", apiKey: "x", model: "openai/gpt-4o-mini" });
  assert.ok(m instanceof RequestyChatModel);
  assert.equal(m.label, "requesty:openai/gpt-4o-mini");
});

test("requesty: exposes a default router base URL", () => {
  assert.equal(DEFAULT_REQUESTY_BASE_URL, "https://router.requesty.ai/v1");
});

test("requesty: resolveConfig honors REQUESTY_* env only for the requesty provider", () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^(GRAFT_|REQUESTY_|OPENROUTER_|ORCAROUTER_)/.test(k)) delete process.env[k];
  }
  try {
    process.env.REQUESTY_API_KEY = "sk-requesty";
    process.env.REQUESTY_BASE_URL = "https://router.eu.requesty.ai/v1";

    const rq = resolveConfig({ provider: "requesty" });
    assert.equal(rq.apiKey, "sk-requesty");
    assert.equal(rq.baseUrl, "https://router.eu.requesty.ai/v1");
    assert.equal(rq.model, "openai/gpt-4o-mini");
    assert.equal(rq.usedLegacyEnv, false);
    assert.deepEqual(rq.headers, { "X-Title": "graft" });

    delete process.env.REQUESTY_BASE_URL;
    assert.equal(resolveConfig({ provider: "requesty" }).baseUrl, "https://router.requesty.ai/v1");

    const oa = resolveConfig({ provider: "openai" });
    assert.equal(oa.apiKey, undefined);
    assert.equal(oa.baseUrl, undefined);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
