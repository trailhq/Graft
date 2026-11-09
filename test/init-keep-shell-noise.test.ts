/**
 * Agents add shell noise to every call: `trail keep 1 2>&1`, `trail keep --help 2>&1`, `| cat`, `; echo done`,
 * `&& echo ok`. Both halves of `trail keep` read past it the same way (the PreToolUse gate's numbers and help, the
 * CLI's own arguments). A chained second command that runs `trail init` or another `trail keep` is still denied
 * where 1b denied it. Synthetic repo, list and session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { keepCommandAnswer, keepDecision, keepHelp, NEED_NUMBERS, WAIT } from "../src/init/keep-gate.js";
import { keepArgs } from "../src/init/keep-answer.js";
import { keepCommand, KEEP_USAGE } from "../src/init/keep.js";
import { updateInitRecord } from "../src/init/init-record.js";
import { relayLines } from "../src/init/review-screen.js";
import { repoPlace } from "../src/notes/home.js";
import { factsOf, guardrailCandidate, withHome } from "./init-screen-fixtures.js";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";
import type { InitItem } from "../src/init/types.js";

const SESSION = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const REPLY = "Trail looked back over your past sessions here:\n1. no-timeout (guardrail), hit on 11 days\nReply 1 to keep it, or none.";

function world(home: string, env: NodeJS.ProcessEnv) {
  const dir = join(home, "acme-cli");
  spawnSync("mkdir", ["-p", dir]);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const repoKey = repoPlace(dir, env).key;
  const items: InitItem[] = [{ ...guardrailCandidate(), n: 1, title: "no-timeout", description: "" }];
  updateInitRecord(repoKey, (r) => {
    r.pending = items.map((i) => ({ ...i }));
    r.pendingFrom = "ir-5a5b";
    r.shownAt = new Date().toISOString();
  }, env);
  const listText = `✓ wired claude\n${relayLines(items, factsOf({ agent: true })).join("\n")}`;
  const decide = (command: string, init = "trail init --agents claude --verbose 2>&1") => {
    const d = mkdtempSync(join(home, "sess-"));
    const path = join(d, `${SESSION}.jsonl`);
    writeFileSync(path, jsonl([typed("set up trail in this repo"), toolUse("tu1", "Bash", { command: init }), toolResult("tu1", listText), said(REPLY), typed("1")]));
    return keepDecision({ session_id: SESSION, transcript_path: path, cwd: dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_k1", tool_input: { command } }, dir, env);
  };
  return { dir, decide };
}

const NOISE = ["2>&1", "2>/dev/null", "> /dev/null 2>&1", "&>/dev/null", "| cat", "2>&1 | tail -5", "; echo done", "&& echo ok", "|| true"];

test("the numbers read past redirections and trailing shell noise", () => {
  for (const n of NOISE) assert.deepEqual(keepCommandAnswer(`trail keep 1 ${n}`), { numbers: [1] }, n);
  assert.deepEqual(keepCommandAnswer("cd /home/dev/acme-cli && trail keep 1 3 2>&1"), { numbers: [1, 3] });
  assert.deepEqual(keepCommandAnswer("trail keep none 2>&1"), { none: true });
  assert.deepEqual(keepCommandAnswer("trail keep all >/dev/null"), { all: true });
  assert.equal(keepCommandAnswer("trail keep 1 2>&1 x"), null, "a word after the redirect is still an argument");
});

test("--help and -h count as help with a redirect or a reader after them, not with a second keep or an init", () => {
  for (const n of NOISE) assert.equal(keepHelp(`trail keep --help ${n}`), true, n);
  assert.equal(keepHelp("trail keep -h 2>&1"), true);
  for (const c of ["trail keep --help; trail keep 1", "trail keep --help && trail keep all", "trail keep --help 2>&1 | trail keep 1"]) assert.equal(keepHelp(c), false, c);
});

test("the lab's case: after a relay of trail init ... 2>&1 and the person's 1, trail keep 1 2>&1 runs, and --help 2>&1 too", async () => {
  await withHome("keep-noise", ({ home, env }) => {
    const w = world(home, env);
    assert.equal(w.decide("trail keep --help 2>&1"), null);
    for (const n of NOISE) assert.equal(w.decide(`trail keep 1 ${n}`), null, n);
  });
});

test("a chained second command is still denied where 1b denied it", async () => {
  await withHome("keep-chain", ({ home, env }) => {
    const w = world(home, env);
    for (const c of ["trail keep 1 2>&1 && trail init --agents claude", "trail keep --help 2>&1; trail init", "trail init --agents claude && trail keep 1 2>&1"])
      assert.equal(w.decide(c)?.reason, WAIT, c);
    for (const c of ["trail keep 1 2>&1; trail keep all", "trail keep --help; trail keep 1 2"]) assert.equal(w.decide(c)?.permissionDecision, "deny", c);
    assert.equal(w.decide("trail keep 1 2>&1 x")?.reason, NEED_NUMBERS, "a word after the redirect is still an argument: not numbers");
  });
});

test("the CLI half reads its own arguments the same way", async () => {
  assert.deepEqual(keepArgs(["1", "2>&1"]), { numbers: [1] });
  assert.deepEqual(keepArgs(["1", "3", "|", "cat"]), { numbers: [1, 3] });
  assert.deepEqual(keepArgs(["none", ";", "echo", "done"]), { none: true });
  assert.equal(keepArgs(["1", "x"]), null);
  await withHome("keep-noise-cli", ({ env }) => {
    assert.deepEqual(keepCommand(["--help", "2>&1"], env).lines, [KEEP_USAGE]);
    assert.deepEqual(keepCommand(["-h", ">/dev/null"], env), { code: 0, lines: [KEEP_USAGE] });
  });
});
