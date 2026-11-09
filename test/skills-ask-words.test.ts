/**
 * fix-lab5: a skill's asks read as a natural ask in its description and saved line. The lab's Docker skill said
 * "Next time you ask to integration tests" and "Use when asked to integration tests": a noun phrase after "to".
 * A verb-led ask takes "to", a question stays bare, a gerund takes "about", anything else "for". Made-up skills.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { askedWords, describe } from "../src/skills/compile-words.js";
import { savedLines } from "../src/skills/save-gate.js";
import type { CompiledSkill } from "../src/skills/types.js";

const saved = (asks: string) => savedLines({ name: "integration-tests", meta: { asks, applies: "github.com/acme/shop" }, steps: [{ n: 1, cmd: "go test ./...", gated: null, bg: false, wait: false }], check: "", checkIsStep: false } as unknown as CompiledSkill,
  1, "2026-10-20T10:07:00.000Z", null, new Date("2026-10-20T11:00:00.000Z"))[1];

test("the lab's case: the saved line asks for the integration tests, not 'ask to integration tests'", () => {
  const line = saved("integration tests, run the integration tests");
  assert.match(line, /Next time you ask for integration tests, I start from them\./);
  assert.ok(!/ask to integration/.test(line), line);
  assert.match(saved("publish, release"), /Next time you ask to publish, I start from them\./);
});

test("the description joins the asks by how each reads", () => {
  assert.equal(describe("Runs shop's integration tests", "2026-10-18T10:00:00Z", ["integration tests", "run the integration tests"]),
    "Runs shop's integration tests, from the steps that worked on Oct 18. Use when asked for integration tests, or to run the integration tests.");
  assert.equal(askedWords(["publish", "release", "bump", "redo the publish"]), "to publish, release, bump or redo the publish");
  assert.equal(askedWords(["any new users", "new users", "how many users"]), "for any new users or new users, or how many users");
  assert.equal(askedWords(["regenerating api client"]), "about regenerating api client");
  assert.equal(askedWords(["go tests", "run the go tests"]), "for go tests, or to run the go tests");
  assert.equal(askedWords(["push to beta", "ship it"]), "to push to beta or ship it");
});
