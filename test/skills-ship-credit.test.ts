/**
 * D71 c: a ship skill's deploy check can earn credit. A skill keeps the
 * commit as `{sha}` with the default `$(git rev-parse HEAD)`; the agent runs
 * it either as written or with the commit written out. The check family
 * reads a commit's statuses at `$(git rev-parse HEAD)` as a deploy check, and
 * credit matches the skill's steps and check against the literal sha the run
 * used, and the other way round. Synthetic: the made-up acme/webshop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckHit, RunCall, SkillInjection } from "../src/trace/types.js";
import { callKind, checkFamilyOf, classifyCheck, type RunFacts } from "../src/trace/checks.js";
import { creditRun } from "../src/skills/ledger.js";
import { fillParams } from "../src/skills/params.js";
import { at, injection, runCall } from "./trace-run-fixtures.js";

const OK = { failed: false, isError: false };
const FACTS: RunFacts = { versions: [], shas: ["4e1c9a2"], pushedBranches: ["beta"] };
const HEAD = "$(git rev-parse HEAD)";
const STATUS = "gh api repos/acme/webshop/commits/{sha}/statuses --jq '.[0].state'";
const STEPS = [
  "git fetch origin",
  "git push git@github.com:acme/webshop.git {sha}:refs/heads/beta",
  "git merge-base --is-ancestor origin/prod {sha}",
  "git push git@github.com:acme/webshop.git {sha}:refs/heads/prod",
];

test("checks: a commit's statuses at $(git rev-parse HEAD) is a deploy check, judged by the state it shows", () => {
  for (const sha of [HEAD, "$(git rev-parse --short HEAD)", "$(git rev-parse --verify HEAD)"]) {
    const cmd = fillParams(STATUS, { sha });
    assert.equal(checkFamilyOf(cmd, "ship"), "deploy", cmd);
    assert.equal(callKind(cmd, "ship"), "look", cmd);
    assert.deepEqual(classifyCheck(cmd, "success\n", OK, FACTS, "ship"), { family: "deploy", passed: true, facts: { state: "success" } }, cmd);
    assert.equal(classifyCheck(cmd, "pending\n", OK, FACTS, "ship")?.passed, false, cmd);
  }
  // Quoted, as agents often write it; and the skill's own wait loop.
  assert.equal(classifyCheck(`gh api "repos/acme/webshop/commits/${HEAD}/statuses" --jq '.[0].state'`, "success", OK, FACTS, "ship")?.passed, true);
  const wait = `s=$SECONDS; until [ "$(gh api repos/acme/webshop/commits/${HEAD}/statuses --jq '.[0].state')" = "success" ]; do [ $((SECONDS-s)) -ge 300 ] && break; sleep 10; done; echo success`;
  assert.equal(checkFamilyOf(wait, "ship"), "deploy");
  // Anything else worked out when it runs is still not a commit: no check.
  assert.equal(checkFamilyOf("gh api repos/acme/webshop/commits/$(cat sha.txt)/statuses", "ship"), null);
  assert.equal(checkFamilyOf("gh api repos/acme/webshop/commits/$(git rev-parse HEAD~1)/statuses", "ship"), null);
});

let n = 0;
const call = (cmd: string, sec: number, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_c${++n}`, cmd, at: at(sec), ...extra });
const ran = (sha: string) => STEPS.map((s, i) => call(fillParams(s, { sha }), 110 + i * 10));
/** The check call as the fold would have read it. */
function checkCall(sha: string, out: string, sec = 200): RunCall {
  const cmd = fillParams(STATUS, { sha });
  const hit = classifyCheck(cmd, out, OK, FACTS, "ship");
  return call(cmd, sec, { kind: "look", ...(hit ? { check: hit as CheckHit } : {}) });
}
const block = (sha: string): SkillInjection => injection({
  skillId: "s-4c91e0", name: "ship-beta-then-prod", at: at(100), params: { sha },
  steps: STEPS.map((s) => fillParams(s, { sha })), gated: [{ step: 4, kind: "push-prod" }], check: fillParams(STATUS, { sha }),
});

test("credit: the skill's $(git rev-parse HEAD) against the literal sha the run used", () => {
  const credit = creditRun(block(HEAD), [...ran("4e1c9a2"), checkCall("4e1c9a2", "success")]);
  assert.deepEqual([credit.stepsRan, credit.failedStep, credit.check], [[1, 2, 3, 4], null, "passed"]);
  // The full 40-character commit, too.
  const full = "4e1c9a2b7d3e9f0a1b2c3d4e5f60718293a4b5c6";
  assert.deepEqual(creditRun(block(HEAD), [...ran(full), checkCall(full, "success")]).check, "passed");
});

test("credit: the skill run as written, $(git rev-parse HEAD) and all, earns its check", () => {
  const credit = creditRun(block(HEAD), [...ran(HEAD), checkCall(HEAD, "success")]);
  assert.deepEqual([credit.stepsRan, credit.check], [[1, 2, 3, 4], "passed"]);
  assert.equal(creditRun(block(HEAD), [...ran(HEAD), checkCall(HEAD, "pending")]).check, "failed");
});

test("credit: a block about a commit the ask named, run with $(git rev-parse HEAD)", () => {
  const credit = creditRun(block("4e1c9a2"), [...ran(HEAD), checkCall(HEAD, "success")]);
  assert.deepEqual([credit.stepsRan, credit.check], [[1, 2, 3, 4], "passed"]);
  // A short sha in the block and the full one in the run.
  assert.deepEqual(creditRun(block("4e1c9a2"), ran("4e1c9a2b7d3e9f0a1b2c3d4e5f60718293a4b5c6")).stepsRan, [1, 2, 3, 4]);
});

test("credit: another commit, or no commit, is not the skill's step", () => {
  assert.deepEqual(creditRun(block("4e1c9a2"), [...ran("9f8e7d6"), checkCall("9f8e7d6", "success")]).stepsRan, [1]);
  assert.equal(creditRun(block("4e1c9a2"), [...ran("9f8e7d6"), checkCall("9f8e7d6", "success")]).check, "none");
  const branch = [call("git fetch origin", 110), call("git push git@github.com:acme/webshop.git main:refs/heads/prod", 120)];
  assert.deepEqual(creditRun(block(HEAD), branch).stepsRan, [1]);
  // A word that only looks like hex is not a commit.
  assert.deepEqual(creditRun(block(HEAD), [call("git push git@github.com:acme/webshop.git defaced:refs/heads/beta", 120)]).stepsRan, []);
});

test("end to end: a ship block, its steps run with the commit written out and its check as written, is a checked use", async () => {
  const { promptSkills } = await import("../src/claude/prompt-skills.js");
  const { readLedger } = await import("../src/skills/ledger.js");
  const { shipSkill } = await import("./skills-recall-fixtures.js");
  const { box, CWD, gateFor, grow, payload, ranIn, replyAt, save, typedIn, withNow } = await import("./skills-prompt-fixtures.js");
  const b = box("shipcredit");
  save(b, shipSkill());
  const used: Array<[string, Record<string, string>]> = [];
  const d = { gate: gateFor(b), track: (e: string, p: Record<string, string>) => used.push([e, p]) };
  assert.match(promptSkills(payload(b, "now ff to prod please"), CWD, b.env, d).context ?? "", /^\[trail\] Skill ship-beta-then-prod fits/);
  grow(b, [
    typedIn(b, "now ff to prod please", 0),
    ...ranIn(b, "git fetch origin", "", 5),
    ...ranIn(b, "git push git@github.com:acme/webshop.git 4e1c9a2:refs/heads/beta", "   1a2b3c4..4e1c9a2  4e1c9a2 -> beta", 10),
    ...ranIn(b, "git merge-base --is-ancestor origin/prod 4e1c9a2", "", 20),
    ...ranIn(b, "git push git@github.com:acme/webshop.git 4e1c9a2:refs/heads/prod", "   1a2b3c4..4e1c9a2  4e1c9a2 -> prod", 30),
    ...ranIn(b, "gh api repos/acme/webshop/commits/$(git rev-parse HEAD)/statuses --jq '.[0].state'", "success", 40),
    replyAt("Prod is at 4e1c9a2 and the deploy is success. Used skill ship-beta-then-prod", 45),
    typedIn(b, "now look at the cart page styles", 120),
  ]);
  promptSkills(payload(b, "now look at the cart page styles"), CWD, withNow(b, "2026-10-20T10:02:00.000Z"), d);
  const uses = readLedger("s-4c91e0", b.env).filter((l) => l.event === "use") as Array<{ stepsRan: number[]; check: string }>;
  assert.deepEqual(uses.map((u) => [u.stepsRan, u.check]), [[[1, 2, 4, 5], "passed"]]);
  assert.deepEqual(used.filter(([e]) => e === "skill_used"), [["skill_used", { outcome: "checked" }]]);
});
