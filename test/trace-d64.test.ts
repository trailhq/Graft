/**
 * Decision D64: for a ship job, a push is the job's proof only when it moved
 * a branch the ask named: beta, prod (or production), staging, or a branch
 * name typed in the ask ("push branch wa-cutover to beta"). A push of any
 * other branch is not a ship check (it fits no job: "check-misfit"). A run
 * with no job keeps any push as its check, and a READY deploy still proves a
 * ship. Synthetic repos, prompts and output only, shaped like the real case:
 * the push to prod was refused by the host, then a side branch was pushed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedSuccess } from "../src/trace/runs.js";
import { shipBranches } from "../src/trace/run-verdict.js";
import type { CheckHit, RunCall } from "../src/trace/types.js";
import { compactBoundary, compactSummary } from "./trace-fixtures.js";
import { ask, at, bash, reply, runCall, runState, session } from "./trace-run-fixtures.js";

const pushed = (branch: string): CheckHit => ({ family: "push", passed: true, facts: { branch, remote: "origin" } });
const push = (branch: string, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_push_${branch}`, cmd: `git push origin ${branch}`, check: pushed(branch), ...extra });
const ship = (jobWords: string[], calls: RunCall[], promptParams = {}) => runState({ job: "ship", jobWords, promptParams, calls });

test("D64: the branches a ship ask names: its beta, prod and staging words, and a branch name typed in it", () => {
  assert.deepEqual(shipBranches(ship(["push", "prod"], [])), ["prod", "production"]);
  assert.deepEqual(shipBranches(ship(["push", "beta", "ff", "prod"], [])), ["beta", "prod", "production"]);
  assert.deepEqual(shipBranches(ship(["push", "beta"], [], { branch: "wa-cutover" })), ["beta", "wa-cutover"]);
  assert.deepEqual(shipBranches(ship(["ship"], [])), []);
});

test("D64: a ship run is checked by a push only when it moved a branch the ask named", () => {
  assert.equal(checkedSuccess(ship(["push", "prod"], [push("prod")]), "Prod is at 5d6e7f8.").checked, true);
  assert.equal(checkedSuccess(ship(["push", "prod"], [push("production")]), "Done.").checked, true, "prod and production are one");
  assert.equal(checkedSuccess(ship(["push", "beta"], [push("beta")]), "Done.").checked, true);
  assert.equal(checkedSuccess(ship(["push", "staging"], [push("staging")]), "Done.").checked, true);
  assert.equal(checkedSuccess(ship(["push", "beta"], [push("wa-cutover")], { branch: "wa-cutover" }), "Done.").checked, true, "a branch typed in the ask");
  for (const [words, branch] of [[["push", "prod"], "ship-wa-fixes"], [["push", "beta"], "prod"], [["push", "beta"], "main"]] as const) {
    const v = checkedSuccess(ship([...words], [push(branch)]), "Pushed.");
    assert.deepEqual([v.checked, v.why], [false, "check-misfit"], `${words} / ${branch}`);
  }
  const unknown = runCall({ id: "toolu_push_x", cmd: "git push", check: { family: "push", passed: true, facts: {} } });
  assert.equal(checkedSuccess(ship(["push", "prod"], [unknown]), "Done.").checked, false, "a push whose branch is unknown proves no ship");
  // An ask that names no branch ("ship it"): no push proves it, a READY deploy still does.
  assert.equal(checkedSuccess(ship(["ship"], [push("main")]), "Done.").why, "check-misfit");
  const ready: CheckHit = { family: "deploy", passed: true, facts: { state: "READY" } };
  assert.equal(checkedSuccess(ship(["ship"], [push("main"), runCall({ id: "toolu_dep", cmd: null, tool: "mcp__claude_ai_Vercel__get_deployment", kind: "look", check: ready })]), "Live.").checked, true);
  // The named push is the proof even when another branch was pushed after it in a cleanup.
  assert.equal(checkedSuccess(ship(["push", "beta"], [push("beta"), push("tmp-backup", { kind: "step", key: "github.com/acme/storefront" })]), "Done.").checked, true);
});

test("D64: a run with no job keeps any branch's push as its check; a release is untouched", () => {
  assert.equal(checkedSuccess(runState({ job: null, jobWords: [], calls: [push("feat/cart")] }), "Pushed.").checked, true);
  assert.equal(checkedSuccess(runState({ job: "release", jobWords: ["publish"], calls: [push("prod")] }), "Done.").why, "check-misfit");
});

test("D64: folded, the real shape: prod push refused by the host, a side branch pushed instead, after a compaction cut the ship run", () => {
  const s = session("d64-side-branch");
  s.fold([
    ask("sure please push all the fixes to prod", 0),
    ...bash("git fetch origin prod", "", { sec: 2 }),
    compactBoundary({ timestamp: at(30) }), compactSummary({ timestamp: at(30) }),
    ...bash("npx vitest run 2>&1 | tail -3", " Test Files  12 passed (12)\n      Tests  140 passed (140)", { sec: 40 }),
    ...bash("git push origin ship-wa-fixes:prod 2>&1 | tail -8", "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Push to production].", { sec: 50, isError: true }),
    ...bash("git push origin ship-wa-fixes 2>&1 | tail -8", "To github.com:acme/shop.git\n * [new branch]      ship-wa-fixes -> ship-wa-fixes", { sec: 60 }),
    reply("Pushed ship-wa-fixes; it needs a PR into prod.", 70),
  ]);
  const run = s.st.runs[1]!;
  assert.deepEqual([run.job, run.carriedFrom, run.commands], ["ship", s.st.runs[0]!.id, 2], "the refused push never ran");
  const v = checkedSuccess(run, "Pushed ship-wa-fixes; it needs a PR into prod.");
  assert.deepEqual([v.checked, v.why], [false, "check-misfit"]);
  // The same run pushing prod itself checks out.
  const t = session("d64-prod");
  t.fold([ask("sure please push all the fixes to prod", 0), ...bash("git push origin ship-wa-fixes:prod", "To github.com:acme/shop.git\n   0f0e0d0..5d6e7f8  ship-wa-fixes -> prod", { sec: 2 })]);
  assert.equal(checkedSuccess(t.st.runs[0]!, "Prod is at 5d6e7f8.").checked, true);
});
