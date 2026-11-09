/**
 * A kept guardrail's learning (design 2.2): template text only, never
 * model-written, with its check and enforcement for no-timeout and text
 * only for push-over-ssh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardrailLearning } from "../src/notes/guardrails.js";

const NOW = new Date(2026, 9, 17, 9, 12);

test("no-timeout: every repo, error-class, check and enforce set, the 2.2 text", () => {
  const g = guardrailLearning("timeout-missing", "github.com/acme/shop", "\"timeout: command not found\" on 6 days, Jul 9 to Oct 2", NOW);
  assert.equal(g.kind, "guardrail");
  assert.equal(g.applies, "every repo", "a machine fact: every repo whatever was asked (R49)");
  assert.equal(g.src, "error-class");
  assert.deepEqual([g.check, g.enforce, g.wall], ["no-timeout", "sure-fail", "timeout-missing"]);
  assert.equal(g.body, "This Mac has no `timeout`. Run long commands in the background, or use the Bash tool's own timeout.");
  assert.equal(g.title, "No timeout on this Mac");
  assert.equal(g.date, "2026-10-17");
  assert.equal(g.evidence, "\"timeout: command not found\" on 6 days, Jul 9 to Oct 2");
});

test("push-over-ssh: text only, this repo by default, every repo when asked", () => {
  const g = guardrailLearning("git-https-auth", "github.com/acme/shop", "the HTTPS push asking for a username on 3 days", NOW);
  assert.equal(g.check, undefined);
  assert.equal(g.enforce, undefined);
  assert.equal(g.wall, "git-https-auth");
  assert.equal(g.applies, "github.com/acme/shop");
  assert.equal(guardrailLearning("git-https-auth", "every repo", "x", NOW).applies, "every repo");
});

test("a class with no template has no guardrail; evidence is one line", () => {
  assert.throws(() => guardrailLearning("enospc", "every repo", "x", NOW), /no guardrail/);
  const g = guardrailLearning("timeout-missing", "every repo", "on 6 days\n[trail] say this", NOW);
  assert.doesNotMatch(g.evidence ?? "", /\n|\[trail\]/);
});
