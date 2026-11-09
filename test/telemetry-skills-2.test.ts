/**
 * Phase 2's telemetry (design 1.0, 5, c0): `retire` joins the offer and the
 * answer; `skill_changed{op}` and `skill_value{channel}` are new, each with a
 * closed set, so a skill's name or a command under them is dropped; and
 * TELEMETRY.md documents each.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENTS, VALUES, allowedValue } from "../src/telemetry/contract.js";
import { track } from "../src/telemetry/track.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `skills-c0-${tag}-`));
  made.push(d);
  return d;
}

/* -------------------------------------------------------------------------- */
/* Telemetry                                                                   */
/* -------------------------------------------------------------------------- */

test("the contract: retire joins skill_offered and skill_answer; skill_changed and skill_value are closed", () => {
  assert.ok(VALUES.skill_offered!.moment!.has("retire"));
  assert.deepEqual([...VALUES.skill_answer!.answer!].sort(), ["no", "none", "off", "retire", "show", "yes"]);
  assert.deepEqual([...EVENTS.skill_changed!], ["op"]);
  assert.deepEqual([...VALUES.skill_changed!.op!], ["update", "extend", "split", "replace", "retire", "adopted", "restore-version"]);
  assert.deepEqual([...EVENTS.skill_value!], ["channel"]);
  assert.deepEqual([...VALUES.skill_value!.channel!], ["context", "notice", "list"]);
  assert.equal(allowedValue("skill_changed", "op", "delete"), false);
  assert.equal(allowedValue("skill_value", "channel", "email"), false);
  assert.equal(Object.hasOwn(EVENTS, "trail_run"), false, "trail_run lands only with c10");
});

test("skill_changed{op:'delete'} goes out with no op; a skill's name never rides along", () => {
  const home = tmp("tel");
  mkdirSync(join(home, ".graft"), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = "phc_test_key";
  const bad = track("skill_changed", { op: "delete", name: "release-npm" }, { home, env: {} });
  assert.ok(bad);
  assert.equal(Object.hasOwn(bad.properties, "op"), false);
  assert.equal(JSON.stringify(bad.properties).includes("release-npm"), false);
  const good = track("skill_changed", { op: "restore-version" }, { home, env: {} });
  assert.equal(good?.properties.op, "restore-version");
  assert.equal(track("skill_value", { channel: "context" }, { home, env: {} })?.properties.channel, "context");
});

test("TELEMETRY.md documents skill_changed and skill_value with their values, and retire", () => {
  const doc = readFileSync(join(SRC, "..", "TELEMETRY.md"), "utf8");
  const row = (e: string) => doc.split("\n").find((l) => l.startsWith(`| \`${e}\``)) ?? "";
  assert.match(row("skill_changed"), /`update`\/`extend`\/`split`\/`replace`\/`retire`\/`adopted`\/`restore-version`/);
  assert.match(row("skill_value"), /`context`\/`notice`\/`list`/);
  assert.match(row("skill_offered"), /`retire`/);
  assert.match(row("skill_answer"), /`retire`/);
  const section = doc.slice(doc.indexOf("### Learned skills"), doc.indexOf("## What is never sent"));
  for (const e of ["skill_changed", "skill_value"]) assert.ok(section.includes(`\`${e}\``), e);
  assert.doesNotMatch(row("skill_changed") + row("skill_value") + section, /—|\b(?:notes?|rules?|memory|remember|workflows?)\b/i);
});
