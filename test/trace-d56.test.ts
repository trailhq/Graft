/**
 * Decisions D56 and D58c, made after the fold met real sessions:
 * (a) a push that moved the remote ref is a checked success for a job whose
 *     last step is that push; a deploy seen still building after it is not;
 * (b) the tests job is asked for in the words people use ("run the tests",
 *     "rerun the e2e tests"), and questions about tests are not asks;
 * (c) a look call fails only by its exit code or the host's error flag, never
 *     by the text it read (a log full of errors is not a failed call);
 * (d) a block of history the transcript repeats folds once;
 * (D58c) a call over 2,000 characters is kept part by part, a part over
 *     2,000 characters (a heredoc body, an inline edit) as a work marker.
 * Synthetic repos, prompts and output only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { checkFamilyOf, callKind, classifyCheck, factsFromCalls, type RunFacts } from "../src/trace/checks.js";
import { matchJob, OFFER_FAMILIES } from "../src/trace/jobs.js";
import { checkedSuccess, costly, foldEvents } from "../src/trace/runs.js";
import { makeCall } from "../src/trace/run-calls.js";
import { readNewEvents } from "../src/trace/claude.js";
import type { CheckHit, RunCall } from "../src/trace/types.js";
import { compactBoundary, jsonl } from "./trace-fixtures.js";
import { ask, at, bash, emptyState, foldCtx, reply, runCall, runState, session } from "./trace-run-fixtures.js";

const OK = { failed: false, isError: false };
const NONE: RunFacts = { versions: [], shas: [], pushedBranches: [] };
const MOVED = "To github.com:acme/shop.git\n   1a2b3c4..5d6e7f8  beta -> beta\n";

/* ------------------------------------------------------------- (a) a push */

test("D56a: a push whose output shows the remote ref moved is a passing push check", () => {
  assert.deepEqual(classifyCheck("git push origin beta", MOVED, OK, NONE, "ship"),
    { family: "push", passed: true, facts: { sha: "5d6e7f8", branch: "beta", remote: "origin" } });
  assert.deepEqual(classifyCheck("git push -u origin feat/cart", "To github.com:acme/shop.git\n * [new branch]      feat/cart -> feat/cart\nbranch 'feat/cart' set up to track 'origin/feat/cart'.", OK, NONE, "ship"),
    { family: "push", passed: true, facts: { branch: "feat/cart", remote: "origin" } });
  // Webshop's form: beta, then beta to prod; a forced update moved the ref too.
  assert.equal(classifyCheck("git push origin beta:prod", "To github.com:acme/shop.git\n   1a2b3c4..5d6e7f8  beta -> prod", OK, NONE, "ship")?.facts.branch, "prod");
  assert.equal(classifyCheck("git push --force-with-lease origin beta", "To github.com:acme/shop.git\n + 1a2b3c4...9f8e7d6 beta -> beta (forced update)", OK, NONE, "ship")?.passed, true);
  assert.equal(classifyCheck("git push origin beta 2>&1 | tail -3", MOVED, OK, NONE, "ship")?.passed, true, "through an output filter");
});

test("D56a: nothing moved, a rejection, a dry run, a tag only, or a failed call is not a passing push", () => {
  const not = (cmd: string, out: string, r = OK) => assert.equal(classifyCheck(cmd, out, r, NONE, "ship")?.passed, false, `${cmd} / ${out}`);
  not("git push origin beta", "Everything up-to-date");
  not("git push origin beta", "To github.com:acme/shop.git\n ! [rejected]        beta -> beta (fetch first)\nerror: failed to push some refs to 'github.com:acme/shop.git'");
  not("git push origin beta prod", `${MOVED} ! [remote rejected] prod -> prod (protected branch hook declined)\nerror: failed to push some refs`);
  not("git push --dry-run origin beta", MOVED);
  not("git push -n origin beta", MOVED);
  not("git push origin v1.4.3", "To github.com:acme/shop.git\n * [new tag]         v1.4.3 -> v1.4.3");
  not("git push origin beta", MOVED, { failed: true, isError: true });
  not("git push origin beta", "");
});

test("D56a: a push is its own family and stays a step; it fits ship (and a job-less run), nothing else", () => {
  assert.equal(checkFamilyOf("git add -A && git commit -m x && git push origin beta", null), "push");
  assert.equal(checkFamilyOf("git push origin beta && gh api repos/acme/shop/commits/5d6e7f8/status", null), "deploy", "the last family wins");
  // A push in the same call as a read check or a test run yields to it, unless the push is what the job is.
  assert.equal(checkFamilyOf("npm view @acme/cli version && git push origin v1.4.3", "release"), "npm-view");
  assert.equal(checkFamilyOf("npm test && git push origin beta", null), "tests");
  assert.equal(checkFamilyOf("npm test && git push origin beta", "ship"), "push");
  assert.equal(classifyCheck("npm view @acme/cli version && git push origin v1.4.3", "1.4.3\n * [new tag] v1.4.3 -> v1.4.3", OK, { ...NONE, versions: ["1.4.3"] }, "release")?.passed, true);
  assert.equal(callKind("git push origin beta", "ship"), "step");
  assert.ok(OFFER_FAMILIES.ship!.includes("push"));
  assert.ok(!OFFER_FAMILIES.release!.includes("push"));
});

const pass = (family: CheckHit["family"]): CheckHit => ({ family, passed: true, facts: {} });
const notPassed = (family: CheckHit["family"], state?: string): CheckHit => ({ family, passed: false, facts: state ? { state } : {} });
const step = (cmd: string, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_${Math.random()}`, cmd, ...extra });
const look = (cmd: string, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_${Math.random()}`, cmd, kind: "look", ...extra });
const deployCmd = "gh api repos/acme/shop/commits/5d6e7f8/status --jq .state";

test("D56a: a ship run whose last step is a push that moved the ref is checked; a deploy seen still building after it is not", () => {
  const push = step("git push origin beta", { check: { family: "push", passed: true, facts: { branch: "beta", remote: "origin" } } }); // D64: the branch the ask named
  const pushed = checkedSuccess(runState({ job: "ship", jobWords: ["push", "beta"], calls: [step("git fetch origin"), push] }), "Pushed beta.");
  assert.deepEqual([pushed.checked, pushed.checkIndex], [true, 1]);
  for (const state of ["building", "queued", "UNKNOWN", "pending"]) {
    const v = checkedSuccess(runState({ job: "ship", jobWords: ["push", "beta"], calls: [push, look(deployCmd, { check: notPassed("deploy", state) })] }), "Pushed; the deploy is building.");
    assert.deepEqual([v.checked, v.why], [false, "unpassed-after-check"], state);
  }
  // Polled until ready: the ready deploy is the check.
  const ready = checkedSuccess(runState({ job: "ship", jobWords: ["push", "beta"], calls: [push, look(deployCmd, { check: notPassed("deploy", "pending") }), look(deployCmd, { check: pass("deploy") })] }), "Beta is live.");
  assert.deepEqual([ready.checked, ready.checkIndex], [true, 2]);
  assert.equal(checkedSuccess(runState({ job: "ship", jobWords: ["push", "beta"], calls: [push, step("npm run migrate")] }), "Done.").why, "step-after-check", "a step after the push");
  assert.equal(checkedSuccess(runState({ job: "release", calls: [step("npm publish"), push] }), "Done.").checked, false, "a push proves no release");
  const view = look("npm view @acme/cli version", { check: pass("npm-view") });
  const other = look("npm view left-pad version", { check: notPassed("npm-view") });
  assert.equal(checkedSuccess(runState({ job: "release", calls: [step("npm publish"), view, other] }), "Published.").checked, true, "a release is judged as 4.2 has it");
  // A job-less run: the push is its check, and a deploy still building after it undoes it the same way.
  assert.equal(checkedSuccess(runState({ job: null, calls: [push] }), "Pushed.").checked, true);
  assert.equal(checkedSuccess(runState({ job: null, calls: [push, look(deployCmd, { check: notPassed("deploy", "building") })] }), "Pushed.").checked, false);
});

test("D56a with D58a/b: only the run's essential steps (in its repo) after the check undo it", () => {
  const push = step("git push origin beta", { check: { family: "push", passed: true, facts: { branch: "beta", remote: "origin" } } }); // D64: the branch the ask named
  const elsewhere = { key: "github.com/acme/webshop", cwd: "" };
  const outside = { key: null, cwd: null };
  // Cleaning up another checkout, or a scratch folder, after the push: still the push run.
  assert.equal(checkedSuccess(runState({ job: "ship", jobWords: ["push", "beta"], calls: [push, step("rm -rf node_modules", elsewhere), step("rm -f /tmp/x", outside)] }), "Pushed.").checked, true);
  assert.equal(checkedSuccess(runState({ job: "ship", jobWords: ["push", "beta"], calls: [push, step("npm run clean", { ...elsewhere, failed: true })] }), "Pushed.").checked, true, "a failure elsewhere breaks nothing here");
  assert.equal(checkedSuccess(runState({ job: "ship", jobWords: ["push", "beta"], calls: [push, step("gh pr merge 9 --merge")] }), "Merged.").why, "step-after-check");
  assert.equal(checkedSuccess(runState({ job: "ship", jobWords: ["push", "beta"], calls: [push, step("git worktree prune", { key: "github.com/acme/shop", cwd: null })] }), "Pushed.").checked, true, "another checkout of the repo is not this one");
  // A session outside git: every step is somewhere else, so every step counts.
  const nowhere = runState({ job: null, repoKey: "home-dev-scratch", calls: [step("git push origin beta", { ...outside, check: pass("push") }), step("make deploy", outside)] });
  assert.equal(checkedSuccess(nowhere, "Done.").why, "step-after-check");
});

test("D56a: folded from a transcript, a beta-then-prod push run is a checked success at Stop", () => {
  const s = session("ship-push");
  s.fold([
    ask("push to beta then ff prod", 0),
    ...bash("git fetch origin && git status -sb", "## beta...origin/beta", { sec: 2 }),
    ...bash("git push origin beta", MOVED, { sec: 5 }),
    ...bash("git push origin beta:prod", "To github.com:acme/shop.git\n   0f0e0d0..5d6e7f8  beta -> prod", { sec: 9 }),
    reply("Beta and prod are both at 5d6e7f8.", 12),
  ]);
  const run = s.st.runs[0]!;
  const v = checkedSuccess(run, "Beta and prod are both at 5d6e7f8.");
  assert.deepEqual([run.job, v.checked, v.checkIndex, run.calls[2]!.check?.facts.branch], ["ship", true, 2, "prod"]);
});

/* ------------------------------------------------------- (b) the tests job */

test("D56b: asks to run the tests name the tests job", () => {
  for (const t of [
    "run the integration tests", "run the tests", "run tests again", "rerun the tests", "re-run the e2e tests please", "can you run the full test suite",
    "kick off the smoke tests", "run npm test", "can you run go test ./... in the billing package", "make sure the tests pass",
    "run the unit tests for the cart", "please test everything before pushing", "run the playwright tests on staging-two",
  ]) assert.equal(matchJob(t)?.job, "tests", t);
  assert.deepEqual(matchJob("run the integration tests")?.words, ["integration", "tests"]);
  assert.deepEqual(matchJob("rerun the e2e tests")?.words, ["e2e", "tests"]);
});

test("D56b: questions about tests, writing tests, test settings and feature checks are not the tests job", () => {
  for (const t of [
    "did the integration tests pass?", "are the tests passing", "integration tests green?", "the e2e tests passed, right?",
    "how do I run the tests?", "what tests should we add?", "add integration tests for the cart", "write unit tests for the parser",
    "can you set up a test env for beta", "use the test channel for now", "test this thoroughly end to end",
    "close all the tests you were doing", "what was the issue with the test run?", "can you give me the questions to test it myself",
  ]) assert.equal(matchJob(t)?.job === "tests" ? t : null, null);
  // Other jobs keep their turn first.
  assert.equal(matchJob("run the tests and push to beta")?.job, "ship");
  assert.equal(matchJob("run the tests then publish 1.4.3")?.job, "release");
  assert.equal(matchJob("fix the failing tests")?.job, "pr-green");
});

/* ------------------------------------------- (c) a look fails by its exit */

test("D56c: a look call never fails from the text it read, only from its exit or the host's error flag", () => {
  const s = session("look-text");
  s.fold([
    ask("why does the server keep dying", 0),
    ...bash("tail -50 logs/server.log", "ERROR: connection refused\nError: timeout after 30s\nFAILED to start", { sec: 1 }),
    ...bash("grep -n 'panic:' logs/worker.log", "12: panic: nil map", { sec: 2 }),
    ...bash("echo '--- FAIL ---'", "--- FAIL ---", { sec: 3 }),
    ...bash("grep -c timeout logs/missing.log", "grep: logs/missing.log: No such file or directory", { sec: 4, isError: true }),
    ...bash("npm run build", "Error: Cannot find module './cart'", { sec: 5 }),
  ]);
  const run = s.st.runs[0]!;
  assert.deepEqual(run.calls.map((c) => [c.kind, c.failed]), [["look", false], ["look", false], ["plumbing", false], ["look", true], ["step", true]]);
  assert.equal(run.failedCount, 2);
  const reading = session("look-only");
  reading.fold([ask("check the logs", 0), ...bash("cat logs/server.log", "Error: boom\nFATAL: out of memory", { sec: 1 })]);
  assert.equal(costly(reading.st.runs[0]!), false, "reading a log full of errors does not make the run costly");
});

/* ------------------------------------------ (d) repeated history, folded once */

test("D56d: a block of history the transcript repeats (same entry ids) makes no phantom runs, calls or epochs", () => {
  const first = [ask("push to beta", 0), ...bash("git push origin beta", MOVED, { sec: 2 }), reply("Pushed.", 3)];
  const compact = compactBoundary({ timestamp: at(50) });
  const s = session("repeat");
  s.fold([...first, compact]);
  assert.deepEqual([s.st.runs.length, s.st.epoch], [1, 1]);
  const res = s.fold([...first, compact, ask("run the integration tests", 100), ...bash("npm test", "Tests  4 passed (4)", { sec: 101 })]);
  assert.equal(s.st.runs.length, 2, "only the new ask starts a run");
  assert.deepEqual(s.st.runs.map((r) => [r.job, r.commands, r.typedCount]), [["ship", 1, 1], ["tests", 1, 1]]);
  assert.equal(s.st.epoch, 1, "the repeated compaction line bumps nothing");
  assert.deepEqual([res.compactions, res.typed.length], [0, 1], "the repeated ask is not a typed event again");
  // Old assistant text inside the block is not the last word; a newer reply after it is.
  const u = session("repeat-reply");
  u.fold(first);
  assert.equal(u.fold([...first]).lastAssistant, "", "the repeated reply is old");
  assert.equal(u.fold([...first, reply("Beta is live.", 400)]).lastAssistant, "Beta is live.");
  // The same block within one fold.
  const t = session("repeat-one");
  t.fold([...first, ...first]);
  assert.deepEqual([t.st.runs.length, t.st.runs[0]!.commands, t.st.runs[0]!.typedCount], [1, 1, 1]);
});

test("D56d: a transcript rewritten in place (the cursor starts over) folds nothing twice", () => {
  const s = session("rewrite");
  s.fold([ask("push to beta", 0), ...bash("git push origin beta", MOVED, { sec: 2 }), compactBoundary({ timestamp: at(50) }), ask("run the tests", 60), ...bash("npm test", "ok", { sec: 61 })]);
  const before = JSON.stringify(s.st.runs.map((r) => [r.id, r.commands, r.typedCount]));
  // Replaced with a new file holding the same lines plus one more ask: a new inode, so the read starts over.
  const lines = readFileSync(s.path, "utf8");
  writeFileSync(`${s.path}.new`, lines + jsonl([ask("publish 1.4.3", 200)]));
  renameSync(`${s.path}.new`, s.path);
  const res = s.fold([]);
  assert.equal(JSON.stringify(s.st.runs.slice(0, 2).map((r) => [r.id, r.commands, r.typedCount])), before);
  assert.deepEqual([s.st.runs.length, s.st.runs[2]!.job, s.st.epoch, res.compactions], [3, "release", 1, 0]);
});

test("D56d: the memory of what was folded is bounded and holds no ids in the clear", () => {
  const st = emptyState();
  const entries = [ask("run the tests", 0)];
  for (let i = 0; i < 7000; i++) entries.push(...bash(`echo ${i}`, "", { sec: 1, id: `toolu_mem_${i}` }));
  const path = `${process.env.TMPDIR ?? "/tmp"}/trace-d56-mem-${process.pid}.jsonl`;
  writeFileSync(path, jsonl(entries));
  foldEvents(st, readNewEvents(path, `${path}.cursor`, { firstReadBytes: Infinity }), foldCtx({ transcriptPath: path }));
  assert.ok(typeof st.seen === "string" && st.seen.length <= 6000 * 10, `seen ${st.seen?.length}`);
  assert.ok(!st.seen!.includes("toolu_"));
});

/* ------------------------------------------------- D58c: long calls, by part */

const BODY = `export const table = [\n${"  { id: 1, name: 'row' },\n".repeat(120)}];`;

test("D58c: a call over 2,000 characters is kept part by part; a part over 2,000 characters is a work marker", () => {
  const raw = `cd backend && cat > src/gen.ts <<'EOF'\n${BODY}\nEOF\nnpm run build && npm test 2>&1 | tail -5`;
  assert.ok(raw.length > 2000 && BODY.length > 2000);
  const call = makeCall({ id: "toolu_long", at: at(1), input: { command: raw }, cwd: "/home/dev/shop" }, raw, "tests", () => ({ key: "github.com/acme/shop", root: "/home/dev/shop" }), "/home/dev/shop");
  assert.deepEqual([call.cmd, call.truncated, call.secret], [null, true, undefined], "no longer refused whole");
  assert.deepEqual(call.parts, [
    { cmd: "cd backend", sep: "&&", kind: "plumbing" },
    { cmd: null, sep: ";", kind: "work", long: true },
    { cmd: "npm run build", sep: "&&", kind: "step" },
    { cmd: "npm test 2>&1", sep: "|", kind: "step" },
    { cmd: "tail -5", sep: "", kind: "look" },
  ]);
  const short = makeCall({ id: "toolu_short", at: at(1), input: { command: "npm test" } }, "npm test", "tests", () => ({ key: null, root: null }), null);
  assert.equal(short.parts, undefined, "a call of 2,000 characters or fewer is kept whole, as before");
});

test("D58c: each part is redacted on its own: a named secret is named, one that can't be named refuses that part only", () => {
  const raw = `NPM_TOKEN=npm_aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA2bC4 npm publish; curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" https://api.example.com/x; python3 - <<'EOF'\n${BODY}\nEOF`;
  const call = makeCall({ id: "toolu_sec", at: at(1), input: { command: raw } }, raw, null, () => ({ key: null, root: null }), null);
  assert.deepEqual(call.parts!.map((p) => [p.cmd, p.secret ?? null, p.long ?? false]), [
    ["NPM_TOKEN=${NPM_TOKEN:?set NPM_TOKEN} npm publish", "named", false],
    [null, "refused", false],
    [null, null, true],
  ]);
  assert.equal(call.secret, "refused", "the worst part's secret is the call's");
  assert.ok(!JSON.stringify(call).includes("npm_aB3dE5") && !JSON.stringify(call).includes("eyJhbGci"));
});

test("D58c: the fold, the run facts and the sheet read a long call's parts", () => {
  const s = session("long-push");
  const raw = `cat > notes.md <<'EOF'\n${BODY}\nEOF\ngit add notes.md && git commit -m notes && git push origin beta`;
  s.fold([ask("push to beta", 0), ...bash(raw, MOVED, { sec: 2 })]);
  const call = s.st.runs[0]!.calls[0]!;
  assert.equal(call.check?.family, "push");
  assert.equal(call.check?.passed, true);
  assert.deepEqual(factsFromCalls([{ ...call, tail: MOVED.trim() }], {}).pushedBranches, ["beta"]);
});
