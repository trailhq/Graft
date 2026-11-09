/**
 * D117 (1): session start's intro names every command Trail may ask the agent to run that keeps something, so
 * none of them arrives unannounced (the H6 refusal shape D101 fixed for `trail skills add`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKILLS_INTRO } from "../src/claude/start-skills.js";
import { yesCommand } from "../src/skills/offer-words-1b.js";
import { KEEP_LINE } from "../src/init/relay.js";
import type { PendingOffer } from "../src/trace/types.js";

const offer = (o: Partial<PendingOffer>) => ({ offerId: "o-1a2b3c", name: "ship-it", runId: "r-1027-3f9a", ...o }) as PendingOffer;
/** The command's words before its first argument: `trail skills add`, `trail skills lesson`, `trail keep`. */
const head = (cmd: string) => cmd.split(" ").filter((w) => /^[a-z]+$/.test(w)).slice(0, cmd.startsWith("trail skills") ? 3 : 2).join(" ");

test("D117 (1): the intro names trail skills add, trail skills lesson and trail keep", () => {
  const asked = new Set([
    head(yesCommand(offer({ moment: "repeated" }))),
    head(yesCommand(offer({ moment: "correction" }))),
    head(yesCommand(offer({ moment: "repaired", repair: { as: "lesson" } as PendingOffer["repair"] }))),
    head(KEEP_LINE.replace(/^Keep: /, "")),
  ]);
  assert.deepEqual([...asked].sort(), ["trail keep", "trail skills add", "trail skills lesson"]);
  const intro = SKILLS_INTRO.join("\n");
  for (const cmd of asked) assert.ok(intro.includes(`run ${cmd} `), `${cmd} is named: ${intro}`);
});

test("D117 (1): each intro line is from Trail, says Trail checks the person's answer, and keeps the words rule", () => {
  assert.ok(SKILLS_INTRO.every((l) => l.startsWith("[trail] ") && /Trail/.test(l) && !l.includes("\n")));
  assert.match(SKILLS_INTRO.join(" "), /Trail checks their answer in this session before it keeps anything/);
  for (const l of SKILLS_INTRO) {
    assert.doesNotMatch(l, /—|\bnotes?\b|\brules?\b|\bmemory\b|\bworkflows?\b|don'?t ask|word for word|run this now/i, l);
    assert.ok(l.length <= 320, l);
  }
});
