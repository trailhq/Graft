/**
 * D116 item 1 (and D118 a's second half): a skill's "to check" line comes
 * only from a read-only step: a status, a view, a log, a GET. A skill whose
 * only check is a step that changes things (a push that moved prod) gets no
 * check line; a status question then gets the last run's recorded result,
 * from this session's block when it has one, else the skill's ledger. The
 * lab's ship-prod check told the agent to run `git push origin beta:prod`
 * for "is it live yet?", and it did; only the gate stopped it.
 * Made-up repos (acme/webshop) only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptSkills, type PromptDeps } from "../src/claude/prompt-skills.js";
import { checkLine, readOnlyCheck } from "../src/skills/runblock.js";
import { appendLedger } from "../src/skills/ledger.js";
import { recordUse } from "../src/skills/state.js";
import type { LedgerUse } from "../src/skills/types.js";
import { cand, releaseSkill, shipSkill, WEBSHOP } from "./skills-recall-fixtures.js";
import { box, CWD, gateFor, grow, payload, ranIn, replyAt, save, typedIn, withNow, type Box } from "./skills-prompt-fixtures.js";

const FROM = "[trail] From Trail, the tool this person installed to keep commands that worked as skills.";

/** The lab's ship-prod in synthetic form: its only check is its own push of prod. */
const shipProd = () => shipSkill(
  { trail: "s-5d2e7a", check: "git push origin beta:prod", "check-shows": undefined, ready: undefined, "check-first": undefined, params: undefined,
    "confirm-before": "git push origin beta:prod", asks: "ff to prod, ship to prod, push beta to prod", "status-asks": "is it live, is prod updated" },
  { name: "ship-prod", title: "Ship prod", checkIsStep: true, params: [], ifFails: [],
    steps: [
      { n: 1, cmd: "git fetch origin", gated: null, bg: false, wait: false },
      { n: 2, cmd: "git push origin beta:prod", gated: "push-prod", bg: false, wait: false },
    ] },
);

const deps = (b: Box): Partial<PromptDeps> => ({ track: () => {}, gate: gateFor(b) });
const ask = (b: Box, prompt: string, iso: string) => promptSkills(payload(b, prompt), CWD, withNow(b, iso), deps(b));

test("only a read-only step makes a check line: a push that is the skill's own step does not; a view, a status API read do", () => {
  const ship = cand(shipProd()).skill;
  assert.equal(readOnlyCheck(ship), false);
  assert.equal(checkLine(cand(shipProd()), {}), "", "no line telling the agent to run the push");
  assert.equal(readOnlyCheck(cand(shipSkill()).skill), true, "gh api .../statuses is a GET");
  assert.equal(readOnlyCheck(cand(releaseSkill({ applies: WEBSHOP })).skill), true, "npm view is a view");
  assert.match(checkLine(cand(releaseSkill({ applies: WEBSHOP })), { version: "1.4.2" }), /^\[trail\] To check release-npm: npm view acme-cli version/);
});

test("the lab case: 'is it live yet?' after a ship whose push was stopped gets this session's result, never the push to run", () => {
  const b = box("ship-denied");
  save(b, shipProd());
  const block = ask(b, "now ff to prod please", "2026-10-20T10:00:00.000Z");
  assert.match(block.context ?? "", /Skill ship-prod fits/);
  grow(b, [
    typedIn(b, "now ff to prod please", 0),
    ...ranIn(b, "git fetch origin", "", 5),
    replyAt("Step 2 pushes prod and can't be undone. Could you run git push origin beta:prod yourself?", 20),
  ]);
  const out = ask(b, "is it live yet?", "2026-10-20T10:05:00.000Z");
  const text = out.context ?? "";
  assert.ok(!text.includes("To check"), text);
  assert.ok(!text.includes("git push"), `the push is never offered as a check: ${text}`);
  assert.ok(text.startsWith(FROM), text);
  assert.ok(text.includes('They typed: "is it live yet?".'), text);
  assert.match(text, /In this session step 1 ran and step 2 didn't, so Trail can't say it went out/);
  assert.match(text, /don't run its steps to find out/);
  assert.ok(!/\b(say|tell them|reply with)\b[^.]*"/i.test(text), "it never gives the agent words to recite");
});

test("after a ship whose push went through in this session, the status question hears that its check passed", () => {
  const b = box("ship-done");
  save(b, shipProd());
  ask(b, "now ff to prod please", "2026-10-20T10:00:00.000Z");
  grow(b, [
    typedIn(b, "now ff to prod please", 0),
    ...ranIn(b, "git fetch origin", "", 5),
    ...ranIn(b, "git push origin beta:prod", "To github.com:acme/webshop.git\n   1f2e3d4..9c8b7a6  beta -> prod", 10),
    replyAt("Shipped: prod is at 9c8b7a6.", 20),
  ]);
  const text = ask(b, "is it live yet?", "2026-10-20T10:05:00.000Z").context ?? "";
  assert.ok(!text.includes("git push") && !text.includes("To check"), text);
  assert.match(text, /In this session its check passed \(step 2\)/);
});

test("in a new session the status question answers from the ledger's last use of the skill", () => {
  const b = box("ship-ledger");
  save(b, shipProd());
  const use: LedgerUse = { at: "2026-10-18T09:30:00.000Z", event: "use", useId: "u-0a1b2c", skill: "ship-prod", v: "1", host: "claude", cue: "job",
    repo: "github.com/acme/webshop", stepsRan: [1, 2], failedStep: null, readyFailed: [], check: "passed", calls: 2, failed: 0 };
  appendLedger("s-5d2e7a", use, b.env);
  recordUse("s-5d2e7a", use, b.env);
  // A use within 24 hours makes the status question about this skill.
  const text = ask(b, "is prod updated?", "2026-10-18T10:00:00.000Z").context ?? "";
  assert.ok(!text.includes("git push"), text);
  assert.match(text, /Its last run here, on Oct 18, passed its check \(step 2\)/);
});
