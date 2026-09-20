/**
 * The one failure in forking a read that no protocol test would catch: the
 * entry path being wrong, or the read stack failing to load in a child.
 *
 * Everything else about the child protocol is the reviewer's, tested next door
 * in app-review-process.test.ts. What is specific here is that a deployed App
 * forks THIS module, and that importing it pulls in the same nine tree-sitter
 * native addons at graph/extract.ts's module scope. A grammar that cannot load
 * in a forked child dies during import — silently, at runtime, on every read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import { brainBuildWorkerEntry } from "../src/app/brain-build-process.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("the brain build worker is where a deployed App looks for it, and it comes up", async () => {
  const entry = brainBuildWorkerEntry();
  assert.ok(existsSync(entry), `${entry} must exist — it is what a deployed App forks`);

  const child = fork(entry, ["load-probe"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (c) => {
    stderr += String(c);
  });
  const ended = new Promise<string>((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ? `signal ${signal}` : `code ${code}`));
  });
  try {
    // No read runs — a read wants a clone and a token. Still waiting for work
    // after this long means the stack imported cleanly, which is the assertion.
    const outcome = await Promise.race([ended, sleep(2500).then(() => "still waiting for work")]);
    assert.equal(outcome, "still waiting for work", `the brain build worker did not come up: ${stderr}`);
  } finally {
    child.kill("SIGKILL");
  }
});
