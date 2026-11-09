/**
 * Phase 2's host facts (design 1.0, 2.10, c0): Codex has its own facts
 * object, each value the safe one until a host check written up in
 * host-checks.md says otherwise; `hostFacts(env, host)` picks it; the test
 * switch TRAIL_HOST_FACTS is keyed by host and honoured in a test home only.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_FACTS, HOST_FACTS, hostFacts } from "../src/skills/host-facts.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `skills-c0-${tag}-`));
  made.push(d);
  return d;
}

/* -------------------------------------------------------------------------- */
/* Host facts                                                                  */
/* -------------------------------------------------------------------------- */

/** A home with no lab marker and Trail in its usual place: a real home. */
function realHome(): NodeJS.ProcessEnv {
  const home = tmp("real");
  return { HOME: home, TRAIL_HOME: join(home, ".trail") };
}
/** A unit-test home: TRAIL_HOME away from $HOME/.trail. */
function testHome(): NodeJS.ProcessEnv {
  const home = tmp("test");
  return { HOME: home, TRAIL_HOME: join(home, "sandbox") };
}
function labHome(): NodeJS.ProcessEnv {
  const home = tmp("lab");
  mkdirSync(join(home, ".trail-lab"));
  return { HOME: home, TRAIL_HOME: join(home, ".trail") };
}

test("CODEX_FACTS are the safe values 2.10 lists, frozen", () => {
  assert.deepEqual(CODEX_FACTS, {
    offerChannel: "stop", stopNotice: false, startNotice: false, promptNotice: false, promptBlockShown: false,
    askModes: [], failureContext: false, postToolContext: false,
  });
  assert.ok(Object.isFrozen(CODEX_FACTS));
  assert.ok(Object.isFrozen(CODEX_FACTS.askModes));
  assert.throws(() => { (CODEX_FACTS as { postToolContext: boolean }).postToolContext = true; });
  assert.throws(() => { CODEX_FACTS.askModes.push("default"); });
});

test("hostFacts(env, 'codex') returns Codex's facts; no host, or Claude, returns Claude's as before", () => {
  const env = realHome();
  assert.deepEqual(hostFacts(env, "codex"), CODEX_FACTS);
  assert.deepEqual(hostFacts(env), HOST_FACTS);
  assert.deepEqual(hostFacts(env, "claude"), HOST_FACTS);
  assert.equal(HOST_FACTS.postToolContext, true, "Claude Code: PostToolUse additionalContext reaches the model (host-checks 4)");
  // What comes back is a copy: changing it changes no later answer.
  const got = hostFacts(env, "codex");
  got.askModes.push("default");
  got.offerChannel = "notice";
  assert.deepEqual(hostFacts(env, "codex"), CODEX_FACTS);
});

test("TRAIL_HOST_FACTS with a codex key merges into Codex's facts in a test home only", () => {
  const facts = JSON.stringify({ codex: { postToolContext: true, stopNotice: true, offerChannel: "post-tool" } });
  assert.deepEqual(hostFacts({ ...realHome(), TRAIL_HOST_FACTS: facts }, "codex"), CODEX_FACTS, "a real home ignores it");
  const want = { ...CODEX_FACTS, askModes: [], postToolContext: true, stopNotice: true, offerChannel: "post-tool" };
  assert.deepEqual(hostFacts({ ...testHome(), TRAIL_HOST_FACTS: facts }, "codex"), want);
  assert.deepEqual(hostFacts({ ...labHome(), TRAIL_HOST_FACTS: facts }, "codex"), want);
  // The codex key never reaches Claude's facts, and the old flat object never reaches Codex's.
  assert.deepEqual(hostFacts({ ...testHome(), TRAIL_HOST_FACTS: facts }), HOST_FACTS);
  const flat = JSON.stringify({ stopNotice: true, postToolContext: false });
  assert.deepEqual(hostFacts({ ...testHome(), TRAIL_HOST_FACTS: flat }, "codex"), CODEX_FACTS);
  assert.deepEqual(hostFacts({ ...testHome(), TRAIL_HOST_FACTS: flat }), { ...HOST_FACTS, stopNotice: true, postToolContext: false });
  // Only known fields of the right shape.
  const odd = JSON.stringify({ codex: { askModes: [1], postToolContext: "yes", offerChannel: "email", extra: 1 } });
  assert.deepEqual(hostFacts({ ...testHome(), TRAIL_HOST_FACTS: odd }, "codex"), CODEX_FACTS);
  assert.deepEqual(hostFacts({ ...testHome(), TRAIL_HOST_FACTS: JSON.stringify({ codex: [1] }) }, "codex"), CODEX_FACTS);
});

test("host-facts.ts still loads only node:path and node:os (the PreToolUse fast path imports it)", () => {
  const src = read("skills/host-facts.ts");
  const imports = [...src.matchAll(/^import (?!type\b)[^;]*from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["node:os", "node:path"]);
});
