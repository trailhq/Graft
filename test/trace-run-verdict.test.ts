/**
 * When a run is a checked success (design 4.2), and which run "save this"
 * means (4.7): the newest run of this epoch with a step in it, unless it came
 * from a skill or ended in a failure. An older good run is never used: the
 * person means the job that just ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedSuccess, costly, lastGoodRun, newRunId, readRunSheet, writeRunSheet } from "../src/trace/runs.js";
import type { CheckHit, RunCall } from "../src/trace/types.js";
import { emptyState, injection, runCall, runState } from "./trace-run-fixtures.js";

const pass = (family: CheckHit["family"]): CheckHit => ({ family, passed: true, facts: {} });
const step = (cmd: string, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_${cmd.length}_${Math.random()}`, cmd, ...extra });
const look = (cmd: string, check?: CheckHit, extra: Partial<RunCall> = {}) => runCall({ cmd, kind: "look", ...(check ? { check } : {}), ...extra });

test("condition 1: no passing check, no checked success", () => {
  const v = checkedSuccess(runState({ job: "ship", calls: [step("git push origin main:beta")] }), "Pushed.");
  assert.deepEqual(v, { checked: false, checkIndex: null, end: "done", why: "no-check" });
});

test("condition 2: the check fits the job; judgement and local-run jobs are never checked", () => {
  const deploy = look("gh api repos/acme/shop/commits/4e1c9a2/status", pass("deploy"));
  const cases: Array<[string | null, CheckHit["family"], boolean]> = [
    ["ship", "deploy", true], ["ship", "ls-remote", true], ["release", "npm-view", true], ["tests", "tests", true], ["report", "query", true],
    ["release", "deploy", false], ["ship", "npm-view", false], ["tests", "gh-checks", false], [null, "gh-checks", true],
    ["pr-green", "gh-checks", false], ["sweep", "gh-checks", false], ["run-local", "tests", false],
  ];
  for (const [job, family, checked] of cases) {
    const check = family === "tests" || family === "query" ? step("npm test", { check: pass(family) }) : look("x", pass(family));
    const v = checkedSuccess(runState({ job: job as never, calls: [step("git push"), check] }), "Done.");
    assert.equal(v.checked, checked, `${job} ${family}`);
  }
  // The last check that fits wins, even with a passing check of another family after it.
  const v = checkedSuccess(runState({ job: "ship", calls: [step("git push"), deploy, look("gh pr checks 12", pass("gh-checks"))] }), "Done.");
  assert.deepEqual([v.checked, v.checkIndex], [true, 1]);
});

test("conditions 3 and 4: no step after the check, and nothing failed after it; a test run is its own check", () => {
  const view = look("npm view acme-cli version", pass("npm-view"));
  assert.equal(checkedSuccess(runState({ job: "release", calls: [step("npm publish"), view, step("git tag v1.4.3")] }), "Done.").why, "step-after-check");
  assert.equal(checkedSuccess(runState({ job: "release", calls: [step("npm publish"), view, step("git push --tags", { failed: true })] }), "Done.").why, "failed-after-check");
  assert.equal(checkedSuccess(runState({ job: "release", calls: [step("npm publish"), view, look("git log -1")] }), "Done.").checked, true, "a look after is fine");
  const t = checkedSuccess(runState({ job: "tests", calls: [step("npm run build"), step("npm test", { check: pass("tests") })] }), "All tests pass.");
  assert.deepEqual([t.checked, t.checkIndex], [true, 1]);
});

test("condition 5: how the turn ended, from the last step, the agent's last words, or what the last Stop stored", () => {
  const calls = [step("npm publish"), look("npm view acme-cli version", pass("npm-view"))];
  const ends: Array<[string | null, string, boolean]> = [
    ["Published 1.4.3; npm shows it.", "done", true],
    ["The publish failed with E401. Can you tap your key?", "failure", false],
    ["Published. Want me to tag it too?", "question", false],
    ["Published, 0 errors.", "done", true],
  ];
  for (const [last, end, checked] of ends) {
    const v = checkedSuccess(runState({ job: "release", calls }), last);
    assert.deepEqual([v.end, v.checked], [end, checked], String(last));
  }
  assert.deepEqual(checkedSuccess(runState({ job: "release", calls, end: "open" }), null).checked, false, "never judged by a Stop: not done");
  assert.deepEqual(checkedSuccess(runState({ job: "release", calls, end: "done" }), null).checked, true);
  const lastFailed = [step("npm run build"), step("npm test", { check: pass("tests") }), step("npm run lint", { failed: true })];
  assert.equal(checkedSuccess(runState({ job: null, calls: lastFailed, end: "done" }), "All good.").end, "failure", "a failed last step is a failure whatever is said");
});

test("costly: 5 tool calls or a failure; run ids", () => {
  assert.equal(costly(runState({ toolCalls: 4, failedCount: 0 })), false);
  assert.equal(costly(runState({ toolCalls: 5, failedCount: 0 })), true);
  assert.equal(costly(runState({ toolCalls: 1, failedCount: 1 })), true);
  assert.match(newRunId(new Date(2026, 9, 27, 10)), /^r-1027-[0-9a-f]{4}$/);
});

function home(): NodeJS.ProcessEnv {
  return { ...process.env, TRAIL_HOME: join(mkdtempSync(join(tmpdir(), "trace-good-")), ".trail") };
}

test("last good run, leg B: nothing in this epoch with a step (a run from before the compaction never counts)", () => {
  const env = home();
  assert.deepEqual(lastGoodRun(emptyState(), env), { none: "nothing" });
  assert.deepEqual(lastGoodRun(emptyState({ epoch: 1, runs: [runState({ epoch: 0 })] }), env), { none: "nothing" });
  assert.deepEqual(lastGoodRun(emptyState({ runs: [runState({ stepCalls: 0, calls: [look("ls")] })] }), env), { none: "nothing" });
});

test("last good run, from a skill: nothing new to keep", () => {
  const st = emptyState({ injected: [injection({ runId: "r-1001-3f9a" })], runs: [runState({ skillId: "s-7f3a2c" })] });
  assert.deepEqual(lastGoodRun(st, home()), { none: "skill", skillName: "release-npm" });
});

test("last good run, leg A: the newest run failed, and an older good one is not used", () => {
  const env = home();
  const good = runState({ id: "r-1001-0001", end: "done", calls: [step("npm test", { check: pass("tests") })] });
  const failedStep = runState({ id: "r-1001-0002", closed: false, end: "open", calls: [step("npm test", { failed: true })] });
  assert.deepEqual(lastGoodRun(emptyState({ runs: [good, failedStep] }), env), { none: "failed" });
  const saidFailure = runState({ id: "r-1001-0003", closed: false, end: "failure", calls: [step("npm test")] });
  assert.deepEqual(lastGoodRun(emptyState({ runs: [good, saidFailure] }), env), { none: "failed" });
});

test("last good run: the open run gets its sheet now; a closed one is read from its sheet; a question is fine", () => {
  const env = home();
  const open = runState({ id: "r-1001-0004", closed: false, end: "question", calls: [step("npm run build"), step("npm test", { check: pass("tests") })] });
  const st = emptyState({ runs: [open] });
  const got = lastGoodRun(st, env);
  assert.ok("sheet" in got);
  assert.equal(got.run.id, "r-1001-0004");
  assert.equal(got.sheet.checked, false, "a question isn't a checked success, but it can be saved when asked");
  assert.equal(open.sheet, "draft");
  assert.deepEqual(readRunSheet("r-1001-0004", env), got.sheet);

  const closed = runState({ id: "r-1001-0005", end: "done", calls: [step("npm test", { check: pass("tests") })] });
  writeRunSheet(closed, checkedSuccess(closed, null), { host: "claude", tier: "A", sessionHash: "e76b4ca7f1a0", helpers: [] }, env);
  closed.calls = [];
  const again = lastGoodRun(emptyState({ runs: [closed] }), env);
  assert.ok("sheet" in again && again.sheet.checked);
  const brokenClosed = runState({ id: "r-1001-0006", end: "done", calls: [step("npm test", { failed: true })] });
  writeRunSheet(brokenClosed, checkedSuccess(brokenClosed, null), { host: "claude", tier: "A", sessionHash: "e76b4ca7f1a0", helpers: [] }, env);
  brokenClosed.calls = [];
  assert.deepEqual(lastGoodRun(emptyState({ runs: [brokenClosed] }), env), { none: "failed" });
  const lost = runState({ id: "r-1001-0007", calls: [] });
  assert.deepEqual(lastGoodRun(emptyState({ runs: [lost] }), env), { none: "nothing" }, "a closed run whose sheet is gone");
});
