/**
 * Decision D59, made after the D56 recount on real sessions:
 * (a) a run the agent starts at a compaction (no typed ask) continues the job
 *     of the run the compaction cut, when that run had not checked out yet;
 * (b) Vercel's deployment status tools over MCP (`get_deployment`,
 *     `list_deployments`) are check evidence for the deploy family: READY
 *     passes, anything else does not; they are never steps;
 * (c) a polling loop over a deploy status (often by a variable sha) is read as
 *     a deploy check, judged by the last state it printed;
 * (d) a grep with no match (exit 1, nothing printed) is not a failed look.
 * (e), the tamper routes, is in trace-d59-tamper.test.ts.
 * Synthetic repos, prompts, ids and output only, shaped like the real ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCheck, classifyToolCheck, isDeployTool, type RunFacts } from "../src/trace/checks.js";
import { checkedSuccess, cutAtCompaction, foldEvents, writeRunSheet, readRunSheet } from "../src/trace/runs.js";
import { essentialSteps } from "../src/trace/run-verdict.js";
import { grepNoMatch } from "../src/trace/run-calls.js";
import { compactBoundary, compactSummary, toolResult, toolUse } from "./trace-fixtures.js";
import { ask, at, bash, emptyState, foldCtx, injection, reply, session } from "./trace-run-fixtures.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OK = { failed: false, isError: false };
const NONE: RunFacts = { versions: [], shas: [], pushedBranches: [] };
const MOVED = "To github.com:acme/shop.git\n   1a2b3c4..5d6e7f8  beta -> beta\n";
const TO_PROD = "To github.com:acme/shop.git\n   0f0e0d0..5d6e7f8  beta -> prod\n";
const SHA = "5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e";

/* ------------------------------------------- (a) a run cut by a compaction */

/** An auto-compaction mid-turn: the boundary line, then the summary the agent reads. */
const compaction = (sec: number) => [compactBoundary({ timestamp: at(sec) }), compactSummary({ timestamp: at(sec) })];

test("D59a: the run the agent starts after a compaction continues the job of the run it cut, and its push checks out", () => {
  const s = session("cut-ship");
  s.fold([
    ask("can you push to beta please first", 0),
    ...bash("git fetch origin && git status -sb", "## beta...origin/beta [behind 2]", { sec: 2 }),
    ...bash("git merge --ff-only origin/main", "Updating 0f0e0d0..5d6e7f8\nFast-forward", { sec: 4 }),
    ...compaction(60),
    ...bash("git push origin beta", MOVED, { sec: 70 }),
    reply("Pushed: beta is at 5d6e7f8.", 75),
  ]);
  const [cut, next] = s.st.runs;
  assert.equal(s.st.runs.length, 2);
  assert.deepEqual([cut!.job, cut!.closed, cut!.epoch], ["ship", true, 0]);
  assert.deepEqual([next!.job, next!.jobWords, next!.typedCount, next!.epoch, next!.carriedFrom], ["ship", cut!.jobWords, 0, 1, cut!.id]);
  const v = checkedSuccess(next!, "Pushed: beta is at 5d6e7f8.");
  assert.deepEqual([v.checked, next!.calls[v.checkIndex!]!.check?.family], [true, "push"]);
  assert.equal(s.st.cut, undefined, "the carry is spent once");
});

test("D59a: the carry holds across hook calls, and when SessionStart(compact) closed the run before the fold met the line", () => {
  // The compaction line in one fold, the agent's next calls in the next.
  const s = session("cut-two-folds");
  s.fold([ask("publish 1.4.3", 0), ...bash("npm run build", "built", { sec: 2 }), ...compaction(30)]);
  assert.equal(s.st.cut, s.st.runs[0]!.id);
  s.fold([...bash("npm publish acme-cli-1.4.3.tgz", "+ @acme/cli@1.4.3", { sec: 40 }), ...bash("npm view @acme/cli version", "1.4.3", { sec: 45 })]);
  const next = s.st.runs[1]!;
  assert.deepEqual([next.job, next.carriedFrom, next.promptParams.version], ["release", s.st.runs[0]!.id, "1.4.3"]);
  assert.equal(checkedSuccess(next, "Published 1.4.3.").checked, true);

  // SessionStart(compact) bumped first: it closes the run with the same rule, then the fold meets the line.
  const t = session("cut-session-start");
  t.fold([ask("can you push to beta please first", 0), ...bash("git fetch origin", "", { sec: 2 })]);
  const closed = cutAtCompaction(t.st);
  t.st.epoch += 1;
  t.st.pendingBoundary = true;
  assert.deepEqual(closed.map((r) => r.id), [t.st.runs[0]!.id]);
  t.fold([...compaction(30), ...bash("git push origin beta", MOVED, { sec: 40 })]);
  assert.deepEqual([t.st.epoch, t.st.runs[1]!.job, t.st.runs[1]!.epoch, t.st.runs[1]!.carriedFrom], [1, "ship", 1, t.st.runs[0]!.id]);
});

test("D59a: no carry when the cut run had checked out, had no job, the person typed first, or the agent came back after a long gap", () => {
  // Checked out before the compaction: the push passed and a Stop judged the turn done.
  const done = session("cut-done");
  done.fold([ask("push to beta", 0), ...bash("git push origin beta", MOVED, { sec: 2 })]);
  done.st.runs[0]!.end = "done";
  done.fold([...compaction(30), ...bash("ls", "src", { sec: 40 })]);
  assert.deepEqual([done.st.runs[1]!.job, done.st.runs[1]!.carriedFrom], [null, undefined]);

  const none = session("cut-null");
  none.fold([ask("why is the cart total wrong", 0), ...bash("npm run build", "ok", { sec: 2 }), ...compaction(30), ...bash("npm test", "ok", { sec: 40 })]);
  assert.deepEqual([none.st.runs[1]!.job, none.st.runs[1]!.carriedFrom], [null, undefined]);

  // A typed line after the compaction: runs start from the person's words again.
  const typed = session("cut-typed");
  typed.fold([ask("push to beta", 0), ...bash("git fetch origin", "", { sec: 2 }), ...compaction(30), ask("ok", 35), ...bash("git push origin beta", MOVED, { sec: 40 })]);
  assert.deepEqual([typed.st.runs[1]!.job, typed.st.runs[1]!.carriedFrom, typed.st.runs[1]!.typedCount], [null, undefined, 1]);
  // Even a typed line that starts no run (a status question with no open run) ends the carry.
  const asked = session("cut-asked");
  asked.fold([ask("push to beta", 0), ...bash("git fetch origin", "", { sec: 2 }), ...compaction(30), ask("is it done?", 35), ...bash("git push origin beta", MOVED, { sec: 40 })]);
  assert.deepEqual([asked.st.runs.length, asked.st.runs[1]!.job, asked.st.runs[1]!.typedCount], [2, null, 0]);

  // The agent came back after more than 30 minutes (a task notice woke it).
  const late = session("cut-late");
  late.fold([ask("push to beta", 0), ...bash("git fetch origin", "", { sec: 2 }), ...compaction(30), ...bash("git push origin beta", MOVED, { sec: 31 * 60 })]);
  assert.deepEqual([late.st.runs[1]!.job, late.st.runs[1]!.carriedFrom], [null, undefined]);

  // A run the person's own line closed before the compaction (a save) was not cut by it.
  const saved = session("cut-saved");
  saved.fold([ask("push to beta", 0), ...bash("git fetch origin", "", { sec: 2 }), ask("save this as a skill", 10), ...compaction(30), ...bash("git push origin beta", MOVED, { sec: 40 })]);
  assert.equal(saved.st.runs[1]!.job, null);
});

test("D59a: credit follows the job: a compaction re-inject gets the carried run, which keeps the skill that drove the cut run", () => {
  const s = session("cut-skill");
  s.st.injected.push(injection({ name: "ship-beta", skillId: "s-0a1b2c", cue: "job", at: at(0), steps: ["git fetch origin", "git push origin beta"], gated: [], check: null }));
  s.fold([ask("can you push to beta please first", 1), ...bash("git fetch origin", "", { sec: 2 }), ...compaction(30)]);
  assert.equal(s.st.runs[0]!.skillId, "s-0a1b2c");
  // SessionStart's re-inject for the new epoch, before the agent carries on.
  s.st.injected.push(injection({ injId: "i-0c0c0c", name: "ship-beta", skillId: "s-0a1b2c", cue: "compact", epoch: 1, at: at(31), steps: ["git push origin beta"], gated: [], check: null }));
  s.fold([...bash("git push origin beta", MOVED, { sec: 40 })]);
  const next = s.st.runs[1]!;
  assert.deepEqual([next.skillId, s.st.injected[1]!.runId], ["s-0a1b2c", next.id]);
  // With no re-inject (its skill was not re-offered), the carried run still ran from that skill.
  const u = session("cut-skill-no-reinject");
  u.st.injected.push(injection({ skillId: "s-0a1b2c", cue: "job", at: at(0), steps: ["git fetch origin"], gated: [], check: null }));
  u.fold([ask("can you push to beta please first", 1), ...bash("git fetch origin", "", { sec: 2 }), ...compaction(30), ...bash("git push origin beta", MOVED, { sec: 40 })]);
  assert.equal(u.st.runs[1]!.skillId, "s-0a1b2c");
  // A job cue never takes a carried run: it belongs to a typed ask.
  const t = session("cut-job-cue");
  t.fold([ask("push to beta", 0), ...bash("git fetch origin", "", { sec: 2 }), ...compaction(30)]);
  t.st.injected.push(injection({ cue: "job", epoch: 1, at: at(31) }));
  t.fold([...bash("git push origin beta", MOVED, { sec: 40 })]);
  assert.equal(t.st.injected[0]!.runId, null);
});

test("D59a: the carried run's sheet names the run it continues", () => {
  const home = mkdtempSync(join(tmpdir(), "trace-d59-sheet-"));
  const env = { ...process.env, TRAIL_HOME: home };
  const s = session("cut-sheet");
  s.fold([ask("can you push to beta please first", 0), ...bash("git fetch origin", "", { sec: 2 }), ...compaction(30), ...bash("git push origin beta", MOVED, { sec: 40 })], { trailHome: home });
  const next = s.st.runs[1]!;
  writeRunSheet(next, checkedSuccess(next, "Pushed."), { host: "claude", tier: "A", sessionHash: "e76b4ca7f1a0", helpers: [] }, env);
  assert.equal(readRunSheet(next.id, env)?.carriedFrom, s.st.runs[0]!.id);
});

/* ----------------------------------------- (b) deployment status over MCP */

const GET = "mcp__claude_ai_Vercel__get_deployment";
const LIST = "mcp__claude_ai_Vercel__list_deployments";
const deployment = (state: string, sha = SHA, extra: Record<string, unknown> = {}) => ({
  id: "dpl_Ab12Cd34Ef56Gh78", name: "shop", url: "shop-x1y2z3-acme.vercel.app", type: "LAMBDAS", state, readyState: state, target: "production",
  createdAt: 1790000000000, creator: { uid: "u1", username: "dev" }, meta: { githubCommitRef: "prod", githubCommitSha: sha }, alias: [], ...extra,
});
const getText = (state: string, sha?: string) => JSON.stringify({ result: { deployment: deployment(state, sha) } }, null, 2);
const listText = (...ds: object[]) => JSON.stringify({ result: { deployments: { pagination: { count: ds.length, next: null, prev: null }, deployments: ds } } }, null, 2);

test("D59b: Vercel's get_deployment and list_deployments are the deploy status tools; nothing else is", () => {
  assert.ok(isDeployTool(GET) && isDeployTool(LIST));
  assert.ok(isDeployTool("mcp__vercel__get_deployment"), "a local Vercel server");
  for (const name of ["mcp__claude_ai_Vercel__create_deployment", "mcp__claude_ai_Vercel__get_deployment_build_logs", "mcp__claude_ai_Vercel__deploy_to_vercel",
    "mcp__github__get_deployment", "Bash", "get_deployment"]) assert.equal(isDeployTool(name), false, name);
});

test("D59b: READY passes; BUILDING, QUEUED, INITIALIZING, ERROR, CANCELED and BLOCKED do not", () => {
  assert.deepEqual(classifyToolCheck(GET, getText("READY"), OK, NONE), { family: "deploy", passed: true, facts: { state: "READY", sha: SHA, branch: "prod" } });
  for (const state of ["BUILDING", "QUEUED", "INITIALIZING", "ERROR", "CANCELED", "BLOCKED"]) {
    assert.equal(classifyToolCheck(GET, getText(state), OK, NONE)?.passed, false, state);
  }
  assert.equal(classifyToolCheck(GET, getText("READY"), { failed: true, isError: true }, NONE)?.passed, false, "the tool failed");
  assert.equal(classifyToolCheck(GET, "Error: deployment not found", { failed: true, isError: true }, NONE)?.passed, false);
  assert.equal(classifyToolCheck("mcp__claude_ai_Vercel__create_deployment", getText("READY"), OK, NONE), null);
});

test("D59b: a list reads the newest deployment, or the one at a commit this run knows; get reads the one the agent named", () => {
  const older = deployment("READY", "0f0e0d0a1b2c3d4e5f60718293a4b5c6d7e8f901", { createdAt: 1789990000000 });
  assert.equal(classifyToolCheck(LIST, listText(deployment("BUILDING"), older), OK, NONE)?.passed, false, "the newest is still building");
  assert.equal(classifyToolCheck(LIST, listText(deployment("READY"), older), OK, NONE)?.passed, true);
  const pushed: RunFacts = { ...NONE, shas: ["5d6e7f8"] };
  assert.equal(classifyToolCheck(LIST, listText(deployment("READY"), older), OK, pushed)?.facts.sha, SHA);
  const elsewhere: RunFacts = { ...NONE, shas: ["9a9a9a9"] };
  assert.equal(classifyToolCheck(LIST, listText(deployment("READY"), older), OK, elsewhere)?.passed, false, "no deployment of the pushed commit yet");
  assert.equal(classifyToolCheck(GET, getText("READY"), OK, elsewhere)?.passed, true, "a deployment the agent created at a commit it never printed");
  assert.equal(classifyToolCheck(LIST, listText(), OK, NONE)?.passed, false, "nothing listed");
});

const mcp = (id: string, name: string, input: object, text: string, sec: number, isError?: boolean) => [
  toolUse(id, name, input, { timestamp: at(sec) }),
  toolResult(id, [{ type: "text", text }], isError, { timestamp: at(sec + 1) }),
];

test("D59b: folded, a READY deployment after the push checks the ship run out; it is a look, never a step or a command", () => {
  const s = session("mcp-ready");
  s.fold([
    ask("push to beta then ff prod", 0),
    ...bash("git push origin beta", MOVED, { sec: 2 }),
    ...bash("git push origin beta:prod", TO_PROD, { sec: 5 }),
    ...mcp("toolu_mcp_1", GET, { idOrUrl: "dpl_Ab12Cd34Ef56Gh78", teamId: "team_acme" }, getText("BUILDING"), 20),
    ...mcp("toolu_mcp_2", GET, { idOrUrl: "dpl_Ab12Cd34Ef56Gh78", teamId: "team_acme" }, getText("READY"), 80),
    reply("Prod is live at 5d6e7f8.", 90),
  ]);
  const run = s.st.runs[0]!;
  assert.deepEqual([run.commands, run.stepCalls, run.toolCalls, run.calls.length], [2, 2, 4, 4]);
  const tool = run.calls[3]!;
  assert.deepEqual([tool.tool, tool.cmd, tool.kind, tool.check?.passed, tool.check?.facts.state], [GET, null, "look", true, "READY"]);
  assert.ok(!essentialSteps(run.calls, run.repoKey).includes(tool));
  const v = checkedSuccess(run, "Prod is live at 5d6e7f8.");
  assert.deepEqual([v.checked, v.checkIndex], [true, 3]);
});

test("D59b: a deployment still building after the push undoes the push's proof; an error result is not a failed command", () => {
  const s = session("mcp-building");
  s.fold([
    ask("push to beta", 0),
    ...bash("git push origin beta", MOVED, { sec: 2 }),
    ...mcp("toolu_mcp_3", LIST, { projectId: "prj_shop", teamId: "team_acme", limit: 3 }, listText(deployment("BUILDING")), 20),
    ...mcp("toolu_mcp_4", GET, { idOrUrl: "dpl_missing" }, "Error: deployment not found", 30, true),
    reply("Pushed; the deploy is still building.", 40),
  ]);
  const run = s.st.runs[0]!;
  assert.deepEqual([run.failedCount, run.commands], [0, 1]);
  assert.equal(checkedSuccess(run, "Pushed; the deploy is still building.").why, "unpassed-after-check");
  // The host refused the tool: it never ran.
  const t = session("mcp-refused");
  t.fold([ask("push to beta", 0), ...mcp("toolu_mcp_5", GET, { idOrUrl: "dpl_x" }, "The user doesn't want to proceed with this tool use.", 2, true)]);
  assert.deepEqual([t.st.runs[0]!.calls.length, t.st.runs[0]!.toolCalls], [0, 0]);
});

/* -------------------------------------------- (c) a poll loop over a deploy */

const GH_LOOP = `SHA=${SHA}; for i in $(seq 1 50); do S=$(gh api repos/acme/shop/commits/$SHA/statuses --jq '[.[] | select(.context|test("shop-beta")) ][0] | "\\(.state) \\(.description) \\(.target_url)"' 2>/dev/null); case "$S" in success*|failure*|error*) echo "$S"; break;; esac; sleep 20; done; echo "last: $S"`;
const INSPECT_LOOP = `cd /home/dev/shop\nURL="https://shop-x1y2z3-acme.vercel.app"\nfor i in $(seq 1 40); do\n  S=$(vercel inspect "$URL" 2>&1 | grep -iE "^\\s*status" | head -1)\n  echo "poll $i: $S"\n  echo "$S" | grep -qiE "Ready|Error|Canceled" && break\n  sleep 15\ndone`;
const CASE_LOOP = `for i in $(seq 1 40); do\n  STATE=$(vercel inspect "$URL" 2>&1 | grep -i "status" | head -1)\n  echo "poll $i: $STATE"\n  case "$STATE" in\n    *Ready*|*READY*) echo "BUILD_READY"; break;;\n    *Error*|*ERROR*|*Canceled*) echo "BUILD_FAILED"; break;;\n  esac\n  sleep 15\ndone`;
const API_LOOP = `for i in $(seq 1 40); do S=$(curl -s "https://api.vercel.com/v6/deployments?teamId=team_acme&projectId=prj_shop&limit=1" -H "Authorization: Bearer $TOK" | python3 -c "import json,sys; d=json.load(sys.stdin)['deployments'][0]; print(d['meta'].get('githubCommitSha','')[:8], d['state'])"); echo "$S"; case "$S" in 5d6e7f8a\\ READY|5d6e7f8a\\ ERROR) break;; esac; sleep 20; done`;

test("D59c: a polling loop over a deploy status is a deploy check, judged by the last state it printed", () => {
  const ok = (cmd: string, out: string, facts = NONE) => classifyCheck(cmd, out, OK, facts, "ship");
  const gh = ok(GH_LOOP, "success Deployment has completed https://vercel.com/acme/shop-beta/AbC123\nlast: success Deployment has completed https://vercel.com/acme/shop-beta/AbC123");
  assert.deepEqual([gh?.family, gh?.passed, gh?.facts.sha], ["deploy", true, SHA], "the sha the loop's variable was set to");
  assert.equal(ok(INSPECT_LOOP, "poll 1:     status\t● Building\npoll 2:     status\t● Building\npoll 3:     status\t● Ready")?.passed, true);
  assert.equal(ok(CASE_LOOP, "poll 1: status ● Building\npoll 2: status ● Ready\nBUILD_READY")?.passed, true);
  assert.equal(ok(API_LOOP, "5d6e7f8a BUILDING\n5d6e7f8a BUILDING\n5d6e7f8a READY")?.passed, true);
  // Not passed: it timed out still building or unknown, it ended in an error, or it printed no state.
  assert.equal(ok(INSPECT_LOOP, "poll 1:     status\tUNKNOWN\npoll 2:     status\tUNKNOWN")?.passed, false);
  assert.equal(ok(CASE_LOOP, "poll 1: status ● Building\npoll 2: status ● Error\nBUILD_FAILED")?.passed, false);
  assert.equal(ok(GH_LOOP, "failure Deployment has failed https://vercel.com/acme/shop-beta/AbC123\nlast: failure Deployment has failed")?.passed, false);
  assert.equal(ok(GH_LOOP, "last: ")?.passed, false);
  assert.equal(ok(API_LOOP, "5d6e7f8a BUILDING\n5d6e7f8a READY", NONE)?.passed, true);
  assert.equal(classifyCheck(API_LOOP, "5d6e7f8a READY", { failed: true, isError: true }, NONE, "ship")?.passed, false, "the loop failed");
});

test("D59c: only a loop that sleeps and reads a deploy status; a later one-shot read decides; a push before the loop yields to it", () => {
  assert.equal(classifyCheck("for i in 1 2 3; do curl -s https://shop.example.com/api/health; sleep 5; done", "ok", OK, NONE, "ship"), null, "a health poll is no deploy status");
  assert.equal(classifyCheck(`for s in a b; do gh api repos/acme/shop/commits/$s/statuses; done`, '"state": "success"', OK, NONE, "ship"), null, "no sleep: not a poll");
  const after = `until [ "$(npx vercel ls --scope team_acme 2>/dev/null | grep -o 'Ready\\|Error\\|Building' | head -1)" != "Building" ]; do sleep 10; done; npx vercel ls --scope team_acme 2>&1 | head -6`;
  assert.equal(classifyCheck(after, "Age  Project  Deployment  Status\n2m  shop  https://shop-x1.vercel.app  ● Ready", OK, NONE, "ship")?.passed, true);
  assert.equal(classifyCheck(`${API_LOOP}; npm view @acme/cli version`, "5d6e7f8a READY\n1.4.3", OK, { ...NONE, versions: ["1.4.3"] }, "release")?.family, "npm-view", "a read after the loop");
  const pushThenPoll = `git push origin HEAD:prod 2>&1 | tail -1; ${API_LOOP}`;
  assert.equal(classifyCheck(pushThenPoll, "   0f0e0d0..5d6e7f8  HEAD -> prod\n5d6e7f8a BUILDING", OK, NONE, "ship")?.passed, false, "the deploy it waited for never got ready");
  assert.equal(classifyCheck(pushThenPoll, "   0f0e0d0..5d6e7f8  HEAD -> prod\n5d6e7f8a READY", OK, NONE, null)?.family, "deploy");
});

test("D59c: folded, a ship run that pushes and then polls the deploy until ready checks out on the poll", () => {
  const s = session("poll-ship");
  s.fold([
    ask("push to beta please", 0),
    ...bash("git push origin beta", MOVED, { sec: 2 }),
    ...bash(GH_LOOP, "success Deployment has completed https://vercel.com/acme/shop-beta/AbC123\nlast: success Deployment has completed https://vercel.com/acme/shop-beta/AbC123", { sec: 5 }),
  ]);
  const run = s.st.runs[0]!;
  const v = checkedSuccess(run, "Beta is live.");
  assert.deepEqual([v.checked, v.checkIndex, run.calls[1]!.check?.family], [true, 1, "deploy"]);
  assert.ok(run.calls[1]!.tail?.includes("last: success"), "the poll keeps its tail");
});

/* ------------------------------------------- (d) a grep that found nothing */

test("D59d: a grep with no match (exit 1, nothing printed) is not a failed look", () => {
  for (const cmd of ['grep -n "chargeCard" src/cart.ts', "cd backend && grep -rn TODO .", "rg -n chargeCard src", "git grep -n chargeCard", "cat src/cart.ts | grep -c refund | grep -v 0", "grep -q chargeCard src/cart.ts",
    'cd backend && grep -n "type cartTotal" -A16 src/cart.ts && echo "-----" && grep -n refund src/cart.ts | head']) {
    assert.equal(grepNoMatch(cmd, "Exit code 1"), true, cmd);
  }
  assert.equal(grepNoMatch("grep -n x src/cart.ts", "Error: Exit code 1"), true);
  assert.equal(grepNoMatch("grep -n x src/cart.ts", ""), true, "a mark with nothing in its tail");
  for (const [cmd, out] of [
    ["grep -n x src/missing.ts", "Exit code 2\ngrep: src/missing.ts: No such file or directory"],
    ["grep -rn x src --include=*.ts", "Exit code 1\n(eval):1: no matches found: --include=*.ts"],
    ["grep -n x src/cart.ts; ls missing", "Exit code 1\nls: missing: No such file or directory"],
    ["tail -3 logs/server.log", "Exit code 1"],
    ["which shopctl && shopctl --version", "Exit code 1"],
  ]) assert.equal(grepNoMatch(cmd!, out!), false, cmd);

  const s = session("grep-none");
  s.fold([
    ask("where do we charge the card", 0),
    ...bash('grep -rn "chargeCard" src', "Exit code 1", { sec: 1, isError: true }),
    ...bash("grep -n x src/missing.ts", "Exit code 2\ngrep: src/missing.ts: No such file or directory", { sec: 2, isError: true }),
  ]);
  const run = s.st.runs[0]!;
  assert.deepEqual(run.calls.map((c) => [c.kind, c.failed, c.isError]), [["look", false, true], ["look", true, true]]);
  assert.equal(run.failedCount, 1);
  // From a PostToolUseFailure mark (the transcript has no result yet): the same.
  const m = session("grep-mark");
  m.fold([ask("where do we charge the card", 0), toolUse("toolu_grep_m", "Bash", { command: 'grep -rn "chargeCard" src' }, { timestamp: at(1) })],
    { marks: [{ id: "toolu_grep_m", at: at(2), failed: true, tail: "" }] });
  assert.deepEqual([m.st.runs[0]!.calls[0]!.failed, m.st.runs[0]!.failedCount], [false, 0]);
});

/* ------------------------------------------------------------ state shape */

test("D59: a state written before D59 (no cut, no tool calls) folds as before", () => {
  const st = emptyState();
  foldEvents(st, [], foldCtx());
  assert.equal("cut" in st, false);
});
