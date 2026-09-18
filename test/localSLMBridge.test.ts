/**
 * PR 3 Unit Tests: Local SLM Provider Bridge (`localSLMBridge.test.ts`)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalSLMBridge } from "../src/providers/localSLMBridge.js";

test("LocalSLMBridge: initializes with loopback baseURL and apiKey bypass", () => {
  const bridge = new LocalSLMBridge({
    model: "llama3",
    baseUrl: "http://localhost:11434/v1",
  });

  assert.ok(bridge instanceof LocalSLMBridge);
});
