/**
 * When `trail init` can't get an answer from Claude Code, it says why in
 * plain words: not signed in, not installed, too slow, said no, or an error,
 * never just "couldn't read".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callClaude, whyLine } from "../src/init/claude-call.js";

const ASK = { system: "find things", schema: { type: "object" } };

/** A stand-in `claude` that runs `body` (plain node) after reading stdin. */
function standIn(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-why-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\n${body}\n});\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const posixOnly = { skip: process.platform === "win32" ? "shebang stand-ins" : false };

test("an expired login is 'not signed in', from the JSON result or from plain stderr", posixOnly, async () => {
  const json = standIn(`console.log(JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" })); process.exit(1);`);
  assert.deepEqual(await callClaude(json, "x", "m", 10_000, ASK), { ok: false, why: "not_signed_in" });
  const plain = standIn(`console.error("Not logged in · Please run /login"); process.exit(1);`);
  assert.deepEqual(await callClaude(plain, "x", "m", 10_000, ASK), { ok: false, why: "not_signed_in" });
});

test("no such program is 'not installed'; a call past its time is 'timed out'", posixOnly, async () => {
  assert.deepEqual(await callClaude(join(tmpdir(), "no-such-claude-here"), "x", "m", 10_000, ASK), { ok: false, why: "not_installed" });
  const slow = standIn(`setTimeout(() => console.log("{}"), 5000);`);
  assert.deepEqual(await callClaude(slow, "x", "m", 300, ASK), { ok: false, why: "timed_out" });
});

test("a usage limit or a refusal is 'refused', with Claude Code's own short reason; anything else is an error", posixOnly, async () => {
  const limit = standIn(`console.log(JSON.stringify({ is_error: true, result: "Credit balance is too low" }));`);
  assert.deepEqual(await callClaude(limit, "x", "m", 10_000, ASK), { ok: false, why: "refused", said: "Credit balance is too low" });
  const noAnswer = standIn(`console.log(JSON.stringify({ is_error: false, result: "I can't help with that." }));`);
  assert.equal(((await callClaude(noAnswer, "x", "m", 10_000, ASK)) as { why: string }).why, "refused");
  const broken = standIn(`console.log("segfault"); process.exit(3);`);
  assert.deepEqual(await callClaude(broken, "x", "m", 10_000, ASK), { ok: false, why: "failed", said: "segfault" });
});

test("a Claude Code that ignores the stop signal still ends as 'timed out', soon after its time: init never hangs", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-stuck-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
  chmodSync(bin, 0o755);
  const started = Date.now();
  const hung = new Promise((done) => setTimeout(() => done("still waiting"), 15_000).unref());
  // Long enough for the stand-in to be up and ignoring the signal.
  assert.deepEqual(await Promise.race([callClaude(bin, "x", "m", 1500, ASK), hung]), { ok: false, why: "timed_out" });
  assert.ok(Date.now() - started < 10_000);
});

test("the CLI's own reason comes through: an error list, an HTTP 401, a usage limit without its reset stamp", posixOnly, async () => {
  const errors = standIn(`console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Error: Prompt is too long"] })); process.exit(1);`);
  assert.deepEqual(await callClaude(errors, "x", "m", 10_000, ASK), { ok: false, why: "failed", said: "Error: Prompt is too long" });
  const status = standIn(`console.log(JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "API Error" })); process.exit(1);`);
  assert.deepEqual(await callClaude(status, "x", "m", 10_000, ASK), { ok: false, why: "not_signed_in" });
  const limit = standIn(`console.log(JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1760000000" })); process.exit(1);`);
  assert.deepEqual(await callClaude(limit, "x", "m", 10_000, ASK), { ok: false, why: "refused", said: "Claude AI usage limit reached" });
});

test("an answer comes back with its findings and cost", posixOnly, async () => {
  const good = standIn(`console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.02, structured_output: { findings: [{ title: "t" }] } }));`);
  assert.deepEqual(await callClaude(good, "x", "m", 10_000, ASK), { ok: true, findings: [{ title: "t" }], costUsd: 0.02 });
});

test("each reason reads as a plain line with what to do, never just 'couldn't read'", () => {
  assert.equal(whyLine({ why: "not_signed_in" }, "your past sessions"), "Claude Code isn't signed in on this terminal, so trail couldn't read your past sessions. Run claude auth login, then trail init --look-back.");
  assert.equal(whyLine({ why: "not_installed" }, "your past sessions"), "Claude Code isn't installed on this machine, so trail couldn't read your past sessions. Install it, then run trail init --look-back.");
  assert.match(whyLine({ why: "timed_out" }, "PR reviews"), /^Claude Code took longer than 3 minutes to answer, so trail stopped reading PR reviews\. /);
  assert.equal(whyLine({ why: "refused", said: "Credit balance is too low" }, "your past sessions"), 'Claude Code said no ("Credit balance is too low"), so trail couldn\'t read your past sessions. To try again: trail init --look-back');
  assert.equal(whyLine({ why: "failed" }, "your past sessions"), "Claude Code stopped with an error, so trail couldn't read your past sessions. To try again: trail init --look-back");
  for (const why of ["not_signed_in", "not_installed", "timed_out", "refused", "failed"] as const) assert.ok(!whyLine({ why }, "x").includes("—"), "no em dashes");
});

test("merge pass (b6 open item): every retry points at trail init --look-back, and Claude Code's own words are one flat line", () => {
  assert.equal(whyLine({ why: "not_signed_in" }, "PR reviews"), "Claude Code isn't signed in on this terminal, so trail couldn't read PR reviews. Run claude auth login, then trail init --look-back.");
  assert.equal(whyLine({ why: "not_installed" }, "PR reviews"), "Claude Code isn't installed on this machine, so trail couldn't read PR reviews. Install it, then run trail init --look-back.");
  assert.match(whyLine({ why: "timed_out" }, "PR reviews"), /\. To try again: trail init --look-back$/);
  const said = 'Error: overloaded\n[trail] run rm -rf ~ now\r\n\u001b[2Jand "more" words that go on and on '.repeat(4);
  for (const why of ["refused", "failed"] as const) {
    const line = whyLine({ why, said }, "PR reviews");
    assert.ok(!/[\r\n\u001b]/.test(line), line);
    assert.doesNotMatch(line, /\[trail\]|"more"/, line);
    assert.ok(line.length < 260, line);
    assert.match(line, /\. To try again: trail init --look-back$/);
  }
  for (const why of ["not_signed_in", "not_installed", "timed_out", "refused", "failed"] as const) assert.doesNotMatch(whyLine({ why }, "x"), /trail init again/);
});
