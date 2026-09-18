/**
 * Network-free tests for the Opper provider. The Opper gateway is
 * OpenAI-compatible, so the adapter reuses the OpenAI translation (verified in
 * llm-adapters.test.ts); here we assert the opper-specific behavior: reuse of
 * that translation, the `opper:` label, factory wiring, the default base URL,
 * `/models` auto-discovery, and the opt-in `OPPER_API_KEY` resolution. Stub
 * clients mean no key and no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { OpperChatModel, listOpperModels, DEFAULT_OPPER_BASE_URL } from "../src/ai/llm/opper.js";
import { createChatModel } from "../src/ai/llm/factory.js";
import { resolveConfig, DEFAULT_MODELS } from "../src/ai/providers.js";

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

/** Run `fn` with a scrubbed provider environment, restoring it afterwards. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const keys = [
    "GRAFT_PROVIDER", "GRAFT_API_KEY", "GRAFT_MODEL", "GRAFT_BASE_URL",
    "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "GRAFT_OPENROUTER_MODEL",
    "ORCAROUTER_API_KEY", "ORCAROUTER_BASE_URL", "ORCAROUTER_MODEL",
    "OPPER_API_KEY", "OPPER_BASE_URL",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("opper: reuses OpenAI-compatible translation and labels as opper", async () => {
  const { client, box } = fakeOpenAI(openAiResp());
  const m = new OpperChatModel({ apiKey: "x", model: "claude-sonnet-4-6", client });
  const res = await m.create({ messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(box.params.model, "claude-sonnet-4-6");
  assert.equal(box.params.temperature, 0); // OpenAI-compatible: temperature forwarded
  assert.equal(res.text, "ok");
  assert.equal(m.label, "opper:claude-sonnet-4-6");
});

test("opper: /models auto-discovery returns pool names and pinned routes alike", async () => {
  const client = {
    models: {
      list: async () => ({
        data: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.5" }, { id: "anthropic/claude-sonnet-4-6" }],
      }),
    },
  } as unknown as OpenAI;
  const ids = await listOpperModels({ apiKey: "x", client });
  assert.deepEqual(ids, ["claude-sonnet-4-6", "gpt-5.5", "anthropic/claude-sonnet-4-6"]);
});

test("opper: factory builds an OpperChatModel for provider 'opper'", () => {
  const m = createChatModel({ provider: "opper", apiKey: "x", model: "gpt-5.4-mini" });
  assert.ok(m instanceof OpperChatModel);
  assert.equal(m.label, "opper:gpt-5.4-mini");
});

test("opper: exposes the gateway base URL and a pool-name default model", () => {
  assert.equal(DEFAULT_OPPER_BASE_URL, "https://api.opper.ai/v3/compat");
  assert.equal(DEFAULT_MODELS.opper, "claude-sonnet-4-6");
  assert.ok(!DEFAULT_MODELS.opper.includes("/"), "default is a bare pool name, not a pinned route");
});

test("opper: resolveConfig honors OPPER_API_KEY and defaults the base URL only for provider 'opper'", () => {
  const r = withEnv({ GRAFT_PROVIDER: "opper", OPPER_API_KEY: "op-key" }, () => resolveConfig());
  assert.equal(r.provider, "opper");
  assert.equal(r.apiKey, "op-key");
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.baseUrl, DEFAULT_OPPER_BASE_URL);
  assert.equal(r.usedLegacyEnv, false);
});

test("opper: OPPER_BASE_URL pins a regional endpoint; GRAFT_* still wins", () => {
  const pinned = withEnv(
    { GRAFT_PROVIDER: "opper", OPPER_API_KEY: "op-key", OPPER_BASE_URL: "https://eu.example.test/v3/compat" },
    () => resolveConfig(),
  );
  assert.equal(pinned.baseUrl, "https://eu.example.test/v3/compat");
  const explicit = withEnv(
    { GRAFT_PROVIDER: "opper", GRAFT_API_KEY: "graft-key", OPPER_API_KEY: "op-key", GRAFT_MODEL: "gpt-5.5" },
    () => resolveConfig(),
  );
  assert.equal(explicit.apiKey, "graft-key");
  assert.equal(explicit.model, "gpt-5.5");
});

test("opper: OPPER_API_KEY is ignored under the default provider (never sent to another endpoint)", () => {
  const r = withEnv({ OPPER_API_KEY: "op-key" }, () => resolveConfig());
  assert.equal(r.provider, "openai");
  assert.equal(r.apiKey, undefined);
  assert.equal(r.baseUrl, undefined);
});
