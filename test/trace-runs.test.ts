/**
 * The fold (design 4.1): a run is the tool work serving one typed ask, plus
 * its short follow-ups, within one context epoch. These tests walk the rows
 * of the fold's table on synthetic transcripts shaped like Claude Code's,
 * folded the way the hooks fold them: a little at a time, into one state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { typedSha } from "../src/trace/typed.js";
import { compactBoundary, compactSummary, hookContext, taskNotification, toolResult, toolUse } from "./trace-fixtures.js";
import { ask, at, bash, emptyState, injection, reply, session } from "./trace-run-fixtures.js";

const PASS = "Test Files  3 passed (3)\n     Tests  42 passed (42)";

test("a typed job starts a run; its tool calls, results and reply fold into it", () => {
  const s = session("basic");
  const res = s.fold([
    ask("run the integration tests", 0),
    ...bash("npm run test:integration 2>&1 | tail -20", PASS, { sec: 5, branch: "feat/cart" }),
    toolUse("toolu_r1", "Read", { file_path: "/home/dev/shop/package.json" }, { timestamp: at(8) }),
    toolResult("toolu_r1", "{}", false, { timestamp: at(9) }),
    reply("All 42 tests pass.", 10),
  ]);
  assert.equal(s.st.runs.length, 1);
  const run = s.st.runs[0]!;
  assert.match(run.id, /^r-\d{4}-[0-9a-f]{4}$/);
  assert.deepEqual(
    { job: run.job, words: run.jobWords, typed: run.typedCount, tools: run.toolCalls, cmds: run.commands, steps: run.stepCalls, branch: run.branch,
      startedAt: run.startedAt, lastAt: run.lastAt, closed: run.closed, end: run.end, epoch: run.epoch, repoKey: run.repoKey },
    { job: "tests", words: ["integration", "tests"], typed: 1, tools: 2, cmds: 1, steps: 1, branch: "feat/cart",
      startedAt: at(0), lastAt: at(9), closed: false, end: "open", epoch: 0, repoKey: "github.com/acme/shop" },
  );
  const call = run.calls[0]!;
  assert.equal(call.cmd, "npm run test:integration 2>&1 | tail -20");
  assert.equal(call.check?.family, "tests");
  assert.equal(call.check?.passed, true);
  assert.equal(call.tail, "Test Files 3 passed (3)\nTests 42 passed (42)");
  assert.equal(res.lastAssistant, "All 42 tests pass.");
  assert.deepEqual(res.closed, []);
  assert.equal(res.typed.length, 1);
  assert.equal(res.typed[0]!.sha, typedSha("run the integration tests"));
  assert.ok(!JSON.stringify(s.st).includes("integration tests"), "typed text never reaches the state");
});

test("typed, same job within 30 minutes continues the run; another job, or the same after 30 minutes, starts one", () => {
  const s = session("jobs");
  s.fold([ask("publish 1.4.3", 0), ...bash("npm publish acme-cli-1.4.3.tgz", "+ acme-cli@1.4.3", { sec: 5 })]);
  s.fold([ask("redo the npm publish with --tag next", 600), ...bash("npm publish --tag next", "+ acme-cli@1.4.3", { sec: 610 })]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(s.st.runs[0]!.typedCount, 2);
  assert.deepEqual(s.st.runs[0]!.jobWords, ["publish", "npm"]);
  assert.deepEqual(s.st.runs[0]!.promptParams, { version: "1.4.3" });
  const res = s.fold([ask("push to beta", 700)]);
  assert.equal(s.st.runs.length, 2);
  assert.equal(res.closed[0]!.id, s.st.runs[0]!.id);
  assert.equal(s.st.runs[1]!.job, "ship");
  s.fold([ask("push to beta again", 700 + 31 * 60)]);
  assert.equal(s.st.runs.length, 3, "same job after more than 30 minutes is a new run");
  assert.equal(s.st.runs[1]!.closed, true);
});

test("typed, no job: a short follow-up continues within 30 minutes; after that, or over 25 words, it starts a job-less run", () => {
  const s = session("nojob");
  s.fold([ask("run the integration tests", 0), ...bash("go test ./...", "ok  acme/shop 0.2s", { sec: 3 })]);
  s.fold([ask("use the -race flag too", 60)]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(s.st.runs[0]!.typedCount, 2);
  s.fold([ask("and the vet step", 60 + 31 * 60)]);
  assert.equal(s.st.runs.length, 2);
  assert.equal(s.st.runs[1]!.job, null);
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  s.fold([ask(long, 60 + 32 * 60)]);
  assert.equal(s.st.runs.length, 3, "over 25 words always starts a run");
  assert.equal(s.st.runs[2]!.job, null);
  assert.equal(s.st.runs[1]!.closed, true);
});

test("typed status or history question: a follow-up within 30 minutes, never a run of its own", () => {
  const s = session("status");
  s.fold([ask("push to beta", 0), ...bash("git push origin main:beta", "To github.com:acme/shop.git\n   1f2e3d4..9c8b7a6  main -> beta", { sec: 5 })]);
  s.fold([ask("is it live?", 120)]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(s.st.runs[0]!.typedCount, 2);
  // Hours later: the old run is over and the question starts nothing; the agent's checks start a run of their own.
  s.fold([ask("did the deploy go out?", 4 * 3600), ...bash("gh run list --limit 1", "completed success", { sec: 4 * 3600 + 5 })]);
  assert.equal(s.st.runs.length, 2);
  assert.equal(s.st.runs[0]!.closed, true);
  assert.equal(s.st.runs[1]!.typedCount, 0);
  assert.equal(s.st.runs[1]!.job, null);
});

test("typed save request: closes the run, starts nothing, and fills the save request's typed line", () => {
  const s = session("save");
  s.fold([ask("publish 1.4.3", 0), ...bash("npm publish", "+ acme-cli@1.4.3", { sec: 5 })]);
  s.st.saveRequest = { runId: s.st.runs[0]!.id, at: at(98), typedSha: typedSha("save this as a skill"), scope: "this repo", typed: null };
  const res = s.fold([ask("save this as a skill", 100)]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(s.st.runs[0]!.closed, true);
  assert.equal(res.typed[0]!.save, true);
  assert.deepEqual(s.st.saveRequest!.typed, { offset: res.typed[0]!.offset, sha: typedSha("save this as a skill") });
  assert.ok(res.typed[0]!.offset > 0);
  // A different line, or one from before the request (minus 5 s), never fills it.
  const t = session("save2");
  t.st.saveRequest = { runId: "r-1001-aaaa", at: at(200), typedSha: typedSha("save this as a skill"), scope: "this repo", typed: null };
  t.fold([ask("save this as a skill", 100), ask("keep it as a skill", 300)]);
  assert.equal(t.st.saveRequest!.typed, null);
});

test("typed answer after a shown offer: closes the run and starts nothing; the consent window holds a show, then the answer", () => {
  const s = session("answer");
  s.fold([ask("push to beta", 0), ...bash("git push origin main:beta", "ok", { sec: 5 })]);
  s.st.pendingOffer = {
    offerId: "o-81c2aa", moment: "repeated", runId: s.st.runs[0]!.id, name: "ship-beta", key: "github.com/acme/shop|job:ship",
    lines: ["a", "b"], channel: "stop", shownAt: at(50), showMe: false, yes: null, typedAfter: [],
  };
  s.fold([ask("show me", 60)]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(s.st.runs[0]!.closed, true);
  s.fold([ask("show me", 70)]);
  s.fold([ask("yes", 80)]);
  assert.deepEqual(s.st.pendingOffer.typedAfter.map((t) => t.answer), ["show", "other"], "a second show me is not a second show");
  assert.equal(s.st.runs.length, 1, "answers start nothing");
  // Without an offer shown, "yes" is just a short follow-up.
  const t = session("answer2");
  t.fold([ask("push to beta", 0), ...bash("git push origin main:beta", "ok", { sec: 5 }), ask("yes", 30)]);
  assert.equal(t.st.runs[0]!.typedCount, 2);
  // A typed line from before the showing never enters the window.
  const u = session("answer3");
  u.st.pendingOffer = { ...s.st.pendingOffer, shownAt: at(500), typedAfter: [] };
  u.fold([ask("yes", 100), ask("yes", 600), ask("no", 700)]);
  assert.deepEqual(u.st.pendingOffer!.typedAfter.map((x) => x.answer), ["yes"], "only a show earns a second entry");
});

test("injected text never starts or continues a run; the install line spends the session's offer once", () => {
  const s = session("injected");
  s.fold([taskNotification(), hookContext("[trail] some context")]);
  assert.equal(s.st.runs.length, 0);
  s.fold([hookContext("Install trail to get this on every task: npm i -g acme")]);
  assert.equal(s.st.offerUsed, true);
  assert.equal(s.st.offerUsedBy, "install-line");
  const t = session("injected2", emptyState({ offerUsed: true, offerUsedBy: "offer" }));
  t.fold([hookContext("Install trail to get this on every task")]);
  assert.equal(t.st.offerUsedBy, "offer");
});

test("a tool call with no open run starts a job-less run with no typed ask (after a compaction or a task notice)", () => {
  const s = session("orphan");
  s.fold([taskNotification(), ...bash("npm test", "ok", { sec: 3 })]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(s.st.runs[0]!.typedCount, 0);
  assert.equal(s.st.runs[0]!.job, null);
  assert.equal(s.st.runs[0]!.commands, 1);
});

test("a compaction closes open runs and bumps the epoch once; injections of older epochs stop being live", () => {
  const s = session("compact", emptyState({ injected: [injection({ epoch: 0 })] }));
  s.fold([ask("publish 1.4.3", 0), ...bash("npm publish", "+ acme-cli@1.4.3", { sec: 5 })]);
  s.st.runs[0]!.end = "done"; // as the last Stop computed it
  const res = s.fold([compactBoundary({ timestamp: at(100) }), compactSummary({ timestamp: at(101) })]);
  assert.equal(res.compactions, 1, "a boundary and its summary are one compaction");
  assert.equal(s.st.epoch, 1);
  assert.equal(s.st.runs[0]!.closed, true);
  assert.equal(s.st.runs[0]!.end, "done", "its end stays as the last Stop computed it");
  assert.equal(s.st.injected[0]!.live, false);
  s.fold([ask("push to beta", 200)]);
  assert.equal(s.st.runs[1]!.epoch, 1);
});

test("SessionStart(compact) bumped the epoch first: runs before the compaction line get the old epoch, and the line bumps nothing", () => {
  const s = session("pending", emptyState({ epoch: 1, pendingBoundary: true }));
  s.fold([ask("publish 1.4.3", 0), ...bash("npm publish", "+ acme-cli@1.4.3", { sec: 5 })]);
  assert.equal(s.st.runs[0]!.epoch, 0);
  const res = s.fold([compactBoundary({ timestamp: at(100) }), ask("push to beta", 200)]);
  assert.equal(res.compactions, 1);
  assert.equal(s.st.epoch, 1);
  assert.equal(s.st.pendingBoundary, false);
  assert.equal(s.st.runs[1]!.epoch, 1);
});

test("after a /clear SessionStart (a new epoch, no boundary to wait for), runs fold into the new epoch", () => {
  const s = session("clear", emptyState({ epoch: 3, pendingBoundary: false }));
  s.fold([ask("run the integration tests", 0), ...bash("npm test", PASS, { sec: 2 })]);
  assert.equal(s.st.runs[0]!.epoch, 3);
});

test("a run block's injection belongs to the run of the first typed ask at or after it; a check line never claims a run", () => {
  const s = session("inj", emptyState({ injected: [injection({ at: at(98) }), injection({ injId: "i-0c0c0c", skillId: "s-111111", cue: "check", at: at(298), live: false })] }));
  s.fold([ask("publish 1.4.3", 100), ...bash("npm publish", "+ acme-cli@1.4.3", { sec: 105 })]);
  assert.equal(s.st.injected[0]!.runId, s.st.runs[0]!.id);
  assert.equal(s.st.runs[0]!.skillId, "s-7f3a2c");
  s.fold([ask("tell me if it is published", 300), ...bash("npm view acme-cli version", "1.4.3", { sec: 305 })]);
  assert.equal(s.st.injected[1]!.runId, s.st.runs[0]!.id);
  assert.equal(s.st.runs[0]!.skillId, "s-7f3a2c");
});

test("sharedWords: words both in the ask that started the run and in its commands, folded together", () => {
  const s = session("shared");
  s.fold([ask("refresh the pricing cache on staging-two", 0), ...bash("node scripts/refresh-cache.mjs --target pricing", "done", { sec: 3 })]);
  assert.deepEqual(s.st.runs[0]!.sharedWords, ["refresh", "pricing", "cache"]);
  s.fold([...bash("node scripts/refresh-cache.mjs --target staging", "done", { sec: 60 })]);
  assert.deepEqual(s.st.runs[0]!.sharedWords, ["refresh", "pricing", "cache"], "a later fold has no typed text to compare");
});

test("at most 20 runs in state: the oldest closed ones go", () => {
  const s = session("many");
  for (let i = 0; i < 25; i++) s.fold([ask(`refresh report number ${i} with the full numbers for the quarter please and then send it over to the team today`, i * 4000)]);
  assert.equal(s.st.runs.length, 20);
  assert.equal(s.st.runs.at(-1)!.closed, false);
});
