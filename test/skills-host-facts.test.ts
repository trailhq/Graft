/**
 * What the skills hooks know about the host, in one place, and the test-only
 * switches that may change it: honoured only in a test home (a `.trail-lab`
 * marker in $HOME, or a TRAIL_HOME of its own), never in a real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { HOST_FACTS, hostFacts, isTestHome, labInteractive } from "../src/skills/host-facts.js";

/** A home with no lab marker and Trail in its usual place: a real home. */
function realHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = tmpRepo("home");
  return { home, env: { HOME: home } };
}
/** A lab box: its own HOME with the marker, and Trail's files in that HOME. */
function labHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = tmpRepo("lab");
  mkdirSync(join(home, ".trail-lab"));
  return { home, env: { HOME: home, TRAIL_HOME: join(home, ".trail") } };
}

test("the shipped host facts are the ones host-checks.md records", () => {
  assert.deepEqual(HOST_FACTS, {
    offerChannel: "stop", stopNotice: false, startNotice: false, promptNotice: true,
    promptBlockShown: false, askModes: ["default", "acceptEdits", "plan"], failureContext: true,
    postToolContext: true, // phase 2 (2.10): host-checks 4, PostToolUse additionalContext reaches the model
  });
  assert.throws(() => { (HOST_FACTS as { stopNotice: boolean }).stopNotice = true; });
  assert.throws(() => { HOST_FACTS.askModes.push("bypassPermissions"); });
});

test("isTestHome: a lab marker, or a TRAIL_HOME away from $HOME/.trail", () => {
  const real = realHome();
  assert.equal(isTestHome(real.env), false);
  assert.equal(isTestHome({ ...real.env, TRAIL_HOME: join(real.home, ".trail") }), false);
  assert.equal(isTestHome({ ...real.env, TRAIL_HOME: join(real.home, ".trail/") }), false);
  assert.equal(isTestHome({ ...real.env, TRAIL_HOME: join(real.home, "sandbox") }), true);
  assert.equal(isTestHome(labHome().env), true);
});

test("the person's own Trail home is never a test home, whatever HOME, TRAIL_HOME or a marker say", () => {
  const mine = join(userInfo().homedir, ".trail");
  const lab = labHome();
  const fixed = { TRAIL_TEST_NOW: "2026-10-27T10:44:05.000Z", TRAIL_HOST_FACTS: JSON.stringify({ stopNotice: true }), TRAIL_LAB_INTERACTIVE: "1" };
  const wrong: string[] = [];
  const check = (label: string, env: NodeJS.ProcessEnv) => {
    if (isTestHome(env)) wrong.push(`${label}: isTestHome`);
    if (labInteractive({ ...env, ...fixed })) wrong.push(`${label}: labInteractive`);
    if (hostFacts({ ...env, ...fixed }).stopNotice) wrong.push(`${label}: TRAIL_HOST_FACTS`);
  };
  // TRAIL_HOME named the real one, with HOME somewhere else (and a marker there).
  check("TRAIL_HOME is mine", { ...lab.env, TRAIL_HOME: mine });
  check("TRAIL_HOME is mine, with a slash", { ...lab.env, TRAIL_HOME: `${mine}/` });
  // A link to the real one.
  if (existsSync(mine)) {
    const link = join(lab.home, "link");
    symlinkSync(mine, link);
    check("TRAIL_HOME links to mine", { ...lab.env, TRAIL_HOME: link });
  }
  // A marker in HOME, but no TRAIL_HOME: Trail writes this process's ~/.trail, the real one when HOME is the account's.
  if (homedir() === userInfo().homedir) check("marker, no TRAIL_HOME", { HOME: lab.home });
  assert.deepEqual(wrong, []);
  // The lab box itself still is one.
  assert.equal(isTestHome(lab.env), true);
  assert.equal(labInteractive({ ...lab.env, TRAIL_LAB_INTERACTIVE: "1" }), true);
});

test("TRAIL_HOST_FACTS is merged in a test home only", () => {
  const facts = JSON.stringify({ offerChannel: "notice", stopNotice: true, askModes: ["default"] });
  const real = realHome();
  assert.deepEqual(hostFacts({ ...real.env, TRAIL_HOST_FACTS: facts }), HOST_FACTS);
  const lab = labHome();
  assert.deepEqual(hostFacts({ ...lab.env, TRAIL_HOST_FACTS: facts }), {
    ...HOST_FACTS, offerChannel: "notice", stopNotice: true, askModes: ["default"],
  });
  const sandbox = { ...real.env, TRAIL_HOME: join(real.home, "sandbox") };
  assert.equal(hostFacts({ ...sandbox, TRAIL_HOST_FACTS: facts }).offerChannel, "notice");
});

test("TRAIL_HOST_FACTS keeps only known fields of the right shape", () => {
  const lab = labHome();
  const odd = JSON.stringify({ offerChannel: "email", stopNotice: "yes", askModes: [1, "plan"], promptBlockShown: true, extra: 1 });
  assert.deepEqual(hostFacts({ ...lab.env, TRAIL_HOST_FACTS: odd }), { ...HOST_FACTS, promptBlockShown: true });
  assert.deepEqual(hostFacts({ ...lab.env, TRAIL_HOST_FACTS: "{not json" }), HOST_FACTS);
  assert.deepEqual(hostFacts({ ...lab.env, TRAIL_HOST_FACTS: "[1,2]" }), HOST_FACTS);
  // A caller can't change the shipped facts through what it got back.
  const got = hostFacts(lab.env);
  got.askModes.push("bypassPermissions");
  assert.deepEqual(hostFacts(lab.env).askModes, ["default", "acceptEdits", "plan"]);
});

test("labInteractive needs both the lab marker and TRAIL_LAB_INTERACTIVE=1 (D26)", () => {
  const real = realHome();
  const lab = labHome();
  assert.equal(labInteractive(real.env), false);
  assert.equal(labInteractive({ ...real.env, TRAIL_LAB_INTERACTIVE: "1" }), false);
  // A sandbox TRAIL_HOME is a test home, but not the lab: still no headless switch.
  assert.equal(labInteractive({ ...real.env, TRAIL_HOME: join(real.home, "sandbox"), TRAIL_LAB_INTERACTIVE: "1" }), false);
  assert.equal(labInteractive(lab.env), false);
  assert.equal(labInteractive({ ...lab.env, TRAIL_LAB_INTERACTIVE: "true" }), false);
  assert.equal(labInteractive({ ...lab.env, TRAIL_LAB_INTERACTIVE: "1" }), true);
});
