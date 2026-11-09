/**
 * D116 item 3: a run spans turns when the typed line between them is a
 * go-ahead (yes, ok, continue, go on, do it, proceed) or answers a question
 * the agent's previous reply ended with; any other typed line still starts
 * a new run. The lab's release took four person turns (an answer about the
 * sandbox, a go-ahead, a publish-anyway) and was saved as its last turn.
 *
 * Guards: a go-ahead never lets a run that already checked out absorb the
 * next job's steps, never folds in another job it names, and never makes a
 * turn that ended in failure look checked without a check after it. The
 * fold stays the same folded at once or a piece at a time; offsets and the
 * compaction cut keep working. Made-up repos and prompts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedSuccess } from "../src/trace/runs.js";
import { isGoAhead } from "../src/trace/typed.js";
import { compactBoundary, compactSummary } from "./trace-fixtures.js";
import { ask, at, bash, emptyState, reply, session } from "./trace-run-fixtures.js";

const compaction = (sec: number) => [compactBoundary({ timestamp: at(sec) }), compactSummary({ timestamp: at(sec) })];
const LONG_ANSWER = "the vendor folder is restored and the registry in this box is a stand-in that writes to a file, so nothing real goes out; build, test and then go on";

/** The lab's release in synthetic form, as [entries per hook call]. */
function release(): object[][] {
  return [
    [ask("publish 1.4.3 to npm", 0), ...bash("git pull --ff-only origin main", "Already up to date.", { sec: 5 }),
      ...bash("npm run build", "sh: tsc: command not found", { sec: 10, isError: true }),
      reply("The build needs node_modules, which aren't here. Should I run npm install first, or will you restore them?", 20)],
    [ask(LONG_ANSWER, 60), ...bash("npm run build", "built", { sec: 65 }), ...bash("npm test", "# pass 41\n# fail 3", { sec: 70, isError: true }),
      reply("3 tests fail in ways that look like this sandbox's layout. Want me to publish anyway?", 80)],
    [ask("yes", 120), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 125 }),
      ...bash("npm view acme-cli version", "1.4.3\n", { sec: 130 }), reply("Published acme-cli 1.4.3; npm shows 1.4.3.", 140)],
  ];
}

const shape = (st: ReturnType<typeof emptyState>) => st.runs.map((r) => ({ job: r.job, typed: r.typedCount, cmds: r.calls.map((c) => c.cmd), closed: r.closed }));

test("go-ahead words: yes, ok, continue, go on, do it, proceed, go ahead, also opening a longer line; not a new ask", () => {
  for (const t of ["yes", "ok", "okay", "continue", "go on", "do it", "proceed", "Proceed.", "go ahead: pull, then publish", "ok, the failures are the sandbox's, carry on and publish it and check that it went out after that please"]) {
    assert.equal(isGoAhead(t), true, t);
  }
  for (const t of ["publish 1.4.3", "okay what does this function do", "yesterday's build broke", "continue the docs page from scratch with a new layout", "no"]) {
    assert.equal(isGoAhead(t), false, t);
  }
});

test("the lab case: a release over three turns (an answer, then a yes) is one run, saved whole and checked", () => {
  const s = session("multi");
  for (const part of release()) s.fold(part);
  assert.equal(s.st.runs.length, 1, JSON.stringify(shape(s.st)));
  const run = s.st.runs[0]!;
  assert.equal(run.job, "release");
  assert.equal(run.typedCount, 3);
  assert.deepEqual(run.calls.map((c) => c.cmd), ["git pull --ff-only origin main", "npm run build", "npm run build", "npm test", "npm publish --access public", "npm view acme-cli version"]);
  assert.equal(checkedSuccess(run, "Published acme-cli 1.4.3; npm shows 1.4.3.").checked, true);
});

test("replay parity: the same transcript folded at once gives the same runs as a piece at a time", () => {
  const a = session("parity-a");
  for (const part of release()) a.fold(part);
  const b = session("parity-b");
  b.fold(release().flat());
  assert.deepEqual(shape(b.st), shape(a.st));
  assert.deepEqual(b.st.runs.map((r) => r.promptParams), a.st.runs.map((r) => r.promptParams));
});

test("a go-ahead after a plain reply (no question) continues the run, at any length, within 30 minutes", () => {
  const s = session("goahead");
  s.fold([ask("run the integration tests", 0), ...bash("go test ./...", "FAIL acme/shop 0.2s", { sec: 3, isError: true }), reply("One test fails on a missing env var.", 10)]);
  s.fold([ask("ok, set TEST_DB to the local one and carry on with the rest of the suite after that, then tell me what still fails at the end of it all", 60), ...bash("TEST_DB=local go test ./...", "ok  acme/shop 0.3s", { sec: 65 })]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(s.st.runs[0]!.typedCount, 2);
});

test("any other typed line still starts a new run: a long line after a plain reply, another job after a question", () => {
  const s = session("other");
  s.fold([ask("run the integration tests", 0), ...bash("go test ./...", "ok  acme/shop 0.2s", { sec: 3 }), reply("All tests pass.", 10)]);
  s.fold([ask(LONG_ANSWER.replace("go on", "tell me what changed"), 60)]);
  assert.equal(s.st.runs.length, 2, "a long line after a reply with no question");
  s.fold([...bash("ls", "a", { sec: 61 }), reply("Done. Should I also push it?", 70), ask("now push to beta", 80)]);
  assert.equal(s.st.runs.length, 3, "another job named after a question");
  assert.equal(s.st.runs[2]!.job, "ship");
});

test("a go-ahead never lets a run that already checked out absorb the next job's steps", () => {
  const s = session("absorb");
  s.fold([ask("publish 1.4.3", 0), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 5 }), ...bash("npm view acme-cli version", "1.4.3\n", { sec: 8 }),
    reply("Published 1.4.3. Want me to deploy the docs site too?", 10)]);
  s.fold([ask("yes", 30), ...bash("vercel deploy --prod", "Production: https://docs.acme.dev", { sec: 35 })]);
  assert.equal(s.st.runs.length, 2, JSON.stringify(shape(s.st)));
  const first = s.st.runs[0]!;
  assert.equal(first.closed, true);
  assert.deepEqual(first.calls.map((c) => c.cmd), ["npm publish --access public", "npm view acme-cli version"]);
  assert.equal(checkedSuccess({ ...first, end: "done" }, null).checked, true, "the release it closed still checks out");
  assert.deepEqual(s.st.runs[1]!.calls.map((c) => c.cmd), ["vercel deploy --prod"]);
});

test("an ok after a plain reply to a finished job only acknowledges it: the run (and its offer) stay as they were", () => {
  const s = session("ack");
  s.fold([ask("publish 1.4.3", 0), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 5 }), ...bash("npm view acme-cli version", "1.4.3\n", { sec: 8 }),
    reply("Published 1.4.3; npm shows it.", 10)]);
  s.fold([ask("ok", 30), reply("Anything else, just say.", 32)]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(s.st.runs[0]!.typedCount, 2);
  assert.equal(checkedSuccess(s.st.runs[0]!, "Anything else, just say.").checked, true);
});

test("a go-ahead after a turn that ended in failure: the run stays unchecked until a check passes after it", () => {
  const s = session("failed");
  s.fold([ask("publish 1.4.3", 0), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 5 }), ...bash("npm view acme-cli version", "1.4.3\n", { sec: 8 }),
    reply("The publish didn't go through: the registry still serves the old tarball.", 10)]);
  s.fold([ask("ok", 30), reply("Understood, I'll leave it there.", 35)]);
  assert.equal(s.st.runs.length, 1);
  const run = s.st.runs[0]!;
  assert.equal(checkedSuccess(run, "Understood, I'll leave it there.").checked, false, "an ok to a failure is not a pass");
  s.fold([ask("go on, try it again", 60), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 65 }), ...bash("npm view acme-cli version", "1.4.3\n", { sec: 70 }),
    reply("Published; npm shows 1.4.3.", 80)]);
  assert.equal(s.st.runs.length, 1);
  assert.equal(checkedSuccess(s.st.runs[0]!, "Published; npm shows 1.4.3.").checked, true, "a check after the go-ahead counts");
});

test("offsets: every typed line is still reported once, with its own offset", () => {
  const s = session("offsets");
  const seen: number[] = [];
  for (const part of release()) for (const t of s.fold(part).typed) seen.push(t.offset);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((o) => o >= 0) && new Set(seen).size === 3, JSON.stringify(seen));
});

test("the compaction cut holds: a go-ahead typed after a compaction starts from the person's words, nothing carried (D59a)", () => {
  const s = session("cut");
  s.fold([ask("publish 1.4.3", 0), ...bash("npm run build", "built", { sec: 5 }), reply("Built. Should I publish it now?", 8)]);
  s.fold(compaction(20));
  s.fold([ask("continue", 40), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 45 })]);
  assert.equal(s.st.runs.length, 2);
  assert.equal(s.st.runs[0]!.closed, true);
  assert.deepEqual([s.st.runs[1]!.carriedFrom, s.st.runs[1]!.typedCount, s.st.runs[1]!.epoch], [undefined, 1, 1]);
  assert.equal(s.st.cut, undefined);
  assert.equal(s.st.replyEnd, undefined, "the compaction forgets how the reply ended");
});

import { promptSkills } from "../src/claude/prompt-skills.js";
import { gateFilePath } from "../src/trace/gate-file.js";
import { existsSync } from "node:fs";
import { shipSkill } from "./skills-recall-fixtures.js";
import { box, CWD, gateFor, grow, payload, ranIn, replyAt, save, SID, stateOf, typedIn, withNow } from "./skills-prompt-fixtures.js";

test("a run block stays live for its run: a long answer to the agent's question keeps it, and its gated step still asks", () => {
  const b = box("live-answer");
  save(b, shipSkill());
  const deps = { track: () => {}, gate: gateFor(b) };
  promptSkills(payload(b, "now ff to prod please"), CWD, b.env, deps);
  const answer = "leave it as it is, the two commits behind are docs only and they can wait for the next round, and keep the tag the way it was last time please, thanks a lot";
  grow(b, [typedIn(b, "now ff to prod please", 0), ...ranIn(b, "git fetch origin", "", 5),
    replyAt("Beta is 2 commits behind main. Should I merge main first, or ship beta as it is?", 10), typedIn(b, answer, 60)]);
  promptSkills(payload(b, answer), CWD, withNow(b, "2026-10-20T10:01:00.000Z"), deps);
  const st = stateOf(b);
  assert.ok(answer.split(" ").length > 25);
  assert.equal(st.injected.length, 1);
  assert.equal(st.runs.length, 1, "the answer continues the run");
  assert.equal(st.injected[0]!.live, true, "and its block with it");
  assert.equal(existsSync(gateFilePath(SID, b.env)), true, "the gated step still asks");
});
