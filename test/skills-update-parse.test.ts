/**
 * Phase 2 (design 4.11 step 2, R25): `trail skills update <name> --offer <id>`
 * is read exactly: one update, any Trail binary form, no root options, no
 * flags beside --offer, nothing chained, a plain name and an offer id, and a
 * command over 64 KB never read. The save gate's regex, on the fast path and
 * in the parser, now covers `update` too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillsUpdate, SAVE_GATE_RE, SKILLS_UPDATE_RE } from "../src/skills/save-parse.js";
import { SAVE_GATE } from "../src/claude/pre-bash-skills.js";
import { timeBar } from "./machine-speed.js";

const OK: Array<[string, string, string]> = [
  ["trail skills update release-npm --offer o-1a2b3c", "release-npm", "o-1a2b3c"],
  ["trail skills update release-npm --offer=o-1a2b3c", "release-npm", "o-1a2b3c"],
  ["graft skills update release-npm --offer o-1a2b3c", "release-npm", "o-1a2b3c"],
  ["npx @trailhq/trail-code skills update release-npm --offer o-1a2b3c", "release-npm", "o-1a2b3c"],
  ["node /home/dev/.npm/x/dist/bin/trail.js skills update release-npm --offer o-1a2b3c", "release-npm", "o-1a2b3c"],
  ["cd /home/dev/shop && trail skills update release-npm --offer o-1a2b3c", "release-npm", "o-1a2b3c"],
  ['bash -c "trail skills update release-npm --offer o-1a2b3c"', "release-npm", "o-1a2b3c"],
];

const BAD = [
  "trail skills update release-npm",
  "trail skills update --offer o-1a2b3c",
  "trail skills update release-npm --offer o-1a2b3c --force",
  "trail skills update release-npm other --offer o-1a2b3c",
  "trail --json skills update release-npm --offer o-1a2b3c",
  "trail skills --json update release-npm --offer o-1a2b3c",
  "true && trail skills update release-npm --offer o-1a2b3c",
  "trail skills update release-npm --offer o-1a2b3c && trail skills update ship --offer o-4d5e6f",
  "trail skills update release-npm --offer o-1a2b3c; rm -rf ~/.trail/receipts",
  "trail skills update release-npm --offer o-1a2b3c | tee /tmp/x",
  "trail skills update $x --offer o-1a2b3c",
  "trail skills update release-npm --offer $o",
  "trail skills update ../etc --offer o-1a2b3c",
  "trail skills update release-npm --offer not-an-offer",
  "trail skills add release-npm --run r-1027-3f9a; trail skills update release-npm --offer o-1a2b3c",
  "echo trail skills update release-npm --offer o-1a2b3c",
  `trail skills update release-npm --offer o-1a2b3c ${"#".repeat(64 * 1024)}`,
];

test("parseSkillsUpdate reads exactly `skills update <name> --offer <id>` in every Trail binary form", () => {
  for (const [cmd, name, offerId] of OK) assert.deepEqual(parseSkillsUpdate(cmd), { name, offerId }, cmd);
});

test("anything else is not an update the gate takes: missing parts, flags, root options, chains, variables, a 64 KB command", () => {
  for (const cmd of BAD) assert.equal(parseSkillsUpdate(cmd), null, cmd.slice(0, 120));
});

test("the save gate's regex covers add, lesson and update, the same on the fast path and in the parser", () => {
  assert.equal(SAVE_GATE.source, SAVE_GATE_RE.source);
  for (const cmd of ["trail skills add x --run r", "trail skills lesson --offer o-1a2b3c", "trail skills update x --offer o-1a2b3c"]) {
    assert.ok(SAVE_GATE.test(cmd), cmd);
  }
  assert.ok(SKILLS_UPDATE_RE.test("trail skills update x"));
  assert.ok(!SAVE_GATE.test("trail skills show x"));
});

test("the parser is linear: a 60 KB command of update words is read in milliseconds", () => {
  const c = `trail skills update ${"a ".repeat(30_000)}`;
  const t = Date.now();
  assert.equal(parseSkillsUpdate(c), null);
  assert.ok(Date.now() - t < timeBar(500, 2000));
});
