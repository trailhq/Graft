/**
 * A check that went to the background is not a passed check (fix-lab5): Claude Code moves a command that runs past
 * its Bash timeout to the background ("Command did not complete within its 300s timeout and was moved to the
 * background ..."), and a `run_in_background` call's result says only that it started. Neither says the tests
 * passed, whichever way the result arrives (the transcript or a PostToolUse mark). Made-up repo and ids.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wentToBackground } from "../src/trace/run-calls.js";
import { toolResult, toolUse } from "./trace-fixtures.js";
import { ask, at, bash, session } from "./trace-run-fixtures.js";

const MOVED = "Command did not complete within its 300s timeout and was moved to the background (ID: b0a1b2c3d). Output is being written to: /tmp/x/tasks/b0a1b2c3d.output. You will be notified when it completes. To check interim output, use Read on that file path.";
const STARTED = "Command running in background with ID: b4e5f6a7b. Output is being written to: /tmp/x/tasks/b4e5f6a7b.output. You will be notified when it completes.";

test("Claude Code's background texts are known; a test summary or a log that quotes them is not", () => {
  assert.equal(wentToBackground(MOVED), true);
  assert.equal(wentToBackground(STARTED), true);
  assert.equal(wentToBackground("Command did not complete within its 120s timeout and was moved to the background (ID: bz9)."), true);
  assert.equal(wentToBackground(MOVED.slice(-200)), true, "a mark keeps only the tail");
  assert.equal(wentToBackground("Tests: 12 passed, 12 total"), false);
  assert.equal(wentToBackground(`Tests: 3 passed\nlog: ${MOVED}`), false, "only a result that is that text");
});

test("npm test moved to the background after its timeout: run, not failed, and not a passed tests check", () => {
  const s = session("bg-moved");
  s.fold([ask("run the tests then publish 1.4.3", 0), ...bash("npm test", MOVED, { sec: 1 })]);
  const call = s.st.runs[0]!.calls[0]!;
  assert.equal(call.failed, false);
  assert.ok(call.check, "still the tests check");
  assert.equal(call.check?.passed, false);
});

test("the same through a PostToolUse mark (its last 200 characters) before the transcript has the result", () => {
  const s = session("bg-mark");
  s.fold([ask("run the tests", 0), toolUse("toolu_t", "Bash", { command: "npm test" }, { timestamp: at(1) })], { marks: [{ id: "toolu_t", at: at(2), failed: false, tail: MOVED.slice(-200) }] });
  assert.equal(s.st.runs[0]!.calls[0]!.check?.passed, false);
  s.fold([toolResult("toolu_t", MOVED, false, { timestamp: at(3) })]);
  assert.equal(s.st.runs[0]!.calls[0]!.check?.passed, false);
});

test("run_in_background's start text is no pass either; the tests run again in the foreground and passing is", () => {
  const s = session("bg-start");
  s.fold([ask("run the tests", 0), ...bash("npm test", STARTED, { sec: 1, bg: true }), ...bash("npm test", "Tests: 12 passed, 12 total", { sec: 400 })]);
  const [first, again] = s.st.runs[0]!.calls;
  assert.equal(first!.check?.passed, false);
  assert.equal(again!.check?.passed, true);
});
