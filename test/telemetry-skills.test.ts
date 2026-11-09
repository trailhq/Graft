/**
 * The 1a skills events (design 1.7, spec 20): counts and closed sets only,
 * never content. Each event keeps exactly its allowed keys with values from
 * its set; a content-like key or value is dropped; TELEMETRY.md documents each
 * one and says what never travels; `skills_folded` went with `trail skills fold`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENTS, VALUES } from "../src/telemetry/contract.js";
import { track } from "../src/telemetry/track.js";
import { tmpRepo } from "./helpers.js";

const OPEN: NodeJS.ProcessEnv = {};
function sandbox(tag: string): string {
  const home = tmpRepo(tag);
  mkdirSync(join(home, ".graft"), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = "phc_test_key";
  return home;
}

/** What 1a sends (1.7): the event, its keys, and the values 1a uses. `hook_ms.event` grows in g7-hooks (post-bash). */
const SENT: Record<string, Record<string, string[]>> = {
  skill_offered: { moment: ["asked", "repeated"] },
  skill_answer: { answer: ["yes", "no", "show", "none", "off"] },
  skill_saved: { from: ["asked", "repeated"], scope: ["personal"] },
  skill_used: { outcome: ["checked", "failed", "unchecked"] },
  hook_ms: { event: ["session-start", "prompt", "pre-bash", "stop"], bucket: ["<50ms", "50-100ms", "100-300ms", "300ms-1s", "1-3s", "3s+"] },
};
const COMMON = ["app_version", "os", "arch", "node_major", "ci", "agent_host", "cli_name"];

test("each 1a event allows exactly its keys, and every value 1a sends is in its closed set", () => {
  for (const [event, keys] of Object.entries(SENT)) {
    assert.deepEqual([...EVENTS[event]!].sort(), Object.keys(keys).sort(), event);
    for (const [k, values] of Object.entries(keys)) for (const v of values) assert.ok(VALUES[event]![k]!.has(v), `${event}.${k}=${v}`);
  }
});

test("each 1a event goes out with its own keys and the common ones, nothing else", () => {
  const home = sandbox("tel-1a-each");
  for (const [event, keys] of Object.entries(SENT)) {
    for (let i = 0; i < Math.max(...Object.values(keys).map((v) => v.length)); i++) {
      const props = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v[i % v.length]!]));
      const ev = track(event, props, { home, env: OPEN });
      assert.ok(ev, event);
      assert.deepEqual(Object.keys(ev.properties).sort(), [...COMMON, ...Object.keys(keys)].sort(), event);
      for (const [k, v] of Object.entries(props)) assert.equal(ev.properties[k], v);
    }
  }
});

test("content never travels: a skill's name, steps, a command, a prompt, a path or a count, under any key", () => {
  const home = sandbox("tel-1a-content");
  const content = ["release-npm", "npm publish acme-cli-1.4.3.tgz --access public", "pull and publish 1.4.3", "/home/dev/acme/.trail/skills/release-npm/SKILL.md", "github.com/acme/shop", "23", "r-1027-3f9a"];
  for (const event of Object.keys(SENT)) {
    for (const v of content) {
      const props = Object.fromEntries([...EVENTS[event]!, "name", "skill", "steps", "command", "prompt", "path", "repo", "run", "commands"].map((k) => [k, v]));
      const ev = track(event, props, { home, env: OPEN });
      assert.ok(ev, event);
      // The common keys are the machine's own (app_version 0.23.0 holds "23"); everything else came from the call.
      const own = Object.fromEntries(Object.entries(ev.properties).filter(([k]) => !COMMON.includes(k)));
      assert.equal(JSON.stringify(own).includes(v), false, `${event} carried ${v}`);
      for (const k of COMMON) assert.notEqual(ev.properties[k], v, `${event}.${k} is never the caller's value`);
    }
  }
});

test("skills_folded is gone with trail skills fold, its only sender", () => {
  const home = sandbox("tel-1a-folded");
  assert.equal(Object.hasOwn(EVENTS, "skills_folded"), false);
  assert.equal(track("skills_folded", { takeaways_bucket: "1-4" }, { home, env: OPEN }), null);
  assert.doesNotMatch(readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8"), /skills_folded/);
  assert.doesNotMatch(readFileSync(join(process.cwd(), "TELEMETRY.md"), "utf8"), /skills_folded/);
});

test("TELEMETRY.md says where each 1a event comes from and that names, steps, commands and prompts never travel", () => {
  const doc = readFileSync(join(process.cwd(), "TELEMETRY.md"), "utf8");
  const section = doc.slice(doc.indexOf("### Learned skills"), doc.indexOf("## What is never sent"));
  assert.ok(section.length > 200, "a section on the skills events");
  for (const e of ["skill_offered", "skill_answer", "skill_saved", "skill_used", "hook_ms"]) assert.ok(section.includes(`\`${e}\``), e);
  assert.match(section, /trail skills offers off/);
  assert.match(section, /trail skills add/);
  assert.match(section, /never/);
  assert.doesNotMatch(section, /—|\b(?:notes?|rules?|memory|remember|workflows?)\b/i);
});
