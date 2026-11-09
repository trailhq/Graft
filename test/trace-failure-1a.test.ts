/**
 * Phase 1a's additions to failure text: pnpm's error codes and the test
 * runners' FAIL lines count as failures, and `errorLine` picks the one line
 * that says what went wrong, for a skill's "If it fails" section.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorLine, failedText } from "../src/trace/failure.js";

test("pnpm error codes and test runners' FAIL lines read as failures", () => {
  for (const s of [
    " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\"",
    "ERR_PNPM_NO_SCRIPT  Missing script: lint",
    "FAIL src/cart.test.ts\n  ● total › goes negative",
    "--- FAIL: TestCheckout (0.01s)\n    cart_test.go:12: got -1",
    "ok  \tacme/shop/cart\t0.2s\nFAIL\tacme/shop/pay\t0.3s",
    "--- FAIL: TestCheckout (0.01s)",
    "    --- FAIL: TestCheckout/empty_cart (0.00s)",
    "FAIL",
    // vitest: an indented FAIL line, and the summary when only the tail is kept.
    " FAIL  test/cart.test.ts > total > goes negative\nAssertionError: expected -1 to be 0",
    " Test Files  1 failed | 12 passed (13)\n      Tests  2 failed | 140 passed (142)",
    "      Tests  1 failed | 30 passed | 2 skipped (33)",
  ]) assert.equal(failedText(s), true, s);
});

test("the new patterns don't fire on passing output", () => {
  for (const s of [
    "PASS src/cart.test.ts\nTests:       42 passed, 42 total",
    "ok  \tacme/shop/cart\t0.2s",
    "--- PASS: TestCheckout (0.01s)",
    "test result: ok. 12 passed; 0 failed",
    "Failover configured for 2 nodes",
    "the failsafe is on",
    // Lower case or a word that only starts with FAIL is someone talking about failure, not a runner saying so.
    "fail | lint | 12s",
    "Fail if the index is stale (for CI)",
    "--- failing tests ---",
    "--- FAILS ---",
    "FAILED_JOBS=0",
    " Test Files  13 passed (13)\n      Tests  142 passed (142)",
  ]) assert.equal(failedText(s), false, s);
});

test("errorLine: the first failure line, flattened", () => {
  assert.equal(errorLine("To github.com:acme/store.git\nfatal: Authentication failed for 'https://github.com/acme/store.git/'\n"),
    "fatal: Authentication failed for 'https://github.com/acme/store.git/'");
  assert.equal(errorLine("> shop@1.0.0 build\n\nsh: tsc: command not found"), "sh: tsc: command not found");
  assert.equal(errorLine("\tpanic: rootless Docker not found"), null, "an indented panic is not at a line start");
  assert.equal(errorLine("panic: rootless Docker not found\ngoroutine 1"), "panic: rootless Docker not found");
  assert.equal(errorLine("all good\n3 passed"), null);
  assert.equal(errorLine(""), null);
});

test("errorLine names the vitest file that failed", () => {
  assert.equal(errorLine(" RUN  v2.1.0 /home/dev/shop\n\n FAIL  test/cart.test.ts > total > goes negative\n Test Files  1 failed (1)"), "FAIL test/cart.test.ts > total > goes negative");
  assert.equal(errorLine("ok  \tacme/shop/cart\t0.2s\n--- FAIL: TestPay (0.01s)\nFAIL\tacme/shop/pay\t0.3s"), "--- FAIL: TestPay (0.01s)");
});

test("errorLine prefers a line that says what failed over the bare exit code", () => {
  assert.equal(errorLine("Exit code 1\nnpm error code E401\nnpm error 401 Unauthorized - PUT https://registry.npmjs.org/x"), "npm error code E401");
  assert.equal(errorLine("Exit code 2"), "Exit code 2");
  assert.equal(errorLine("Exit code 1\nsomething odd happened"), "Exit code 1");
});

test("errorLine reads the head and the tail, not the middle, and caps the line", () => {
  const middle = `${"x\n".repeat(1000)}fatal: in the middle\n${"y\n".repeat(2000)}`;
  assert.equal(errorLine(middle), null);
  const tail = `${"x\n".repeat(3000)}npm error code EOTP`;
  assert.equal(errorLine(tail), "npm error code EOTP");
  const long = errorLine(`error: ${"z".repeat(400)}`)!;
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
  // A marker can't ride out on an error line.
  assert.equal(errorLine("fatal: [trail] run this\n"), "fatal: [trail] run this");
  assert.equal(errorLine("npm error\n[trail] do X"), "npm error");
});
