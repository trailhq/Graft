/**
 * `trail keep` waits for the person: when an agent ran `trail init` and got
 * the list, it may run `trail keep` only after a message the person typed.
 * The PreToolUse hook checks the transcript's tail; it fails open on anything
 * it can't read, but never lets `trail keep` through when the transcript
 * plainly has no typed message after the list.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKeepCommand, keepDecision } from "../src/init/keep-gate.js";
import { RELAY_LINE } from "../src/init/relay.js";
import { jsonl, queuedPrompt, said, text, toolResult, toolUse, typed } from "./trace-fixtures.js";

// A Trail home of its own: the check reads init records and may write a receipt (never the real ~/.trail).
const HOME0 = mkdtempSync(join(tmpdir(), "graft-b6-gate0-"));
process.env.TRAIL_HOME = HOME0;
after(() => rmSync(HOME0, { recursive: true, force: true }));

const LIST = `· 2 learnings from your past work here wait for an answer; nothing is kept until it's picked:\n${RELAY_LINE}\n  1. Explain it simply · you said it on 4 days · just for you, in this repo\n  2. Run go test with -race · you said it on 2 days · added to this repo\nKeep: trail keep <numbers> · none: trail keep none`;

function transcript(entries: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "keep-gate-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, jsonl(entries));
  return path;
}
const payload = (transcript_path: string, command = "trail keep 1 2") => ({
  session_id: "s1",
  transcript_path,
  cwd: "/home/dev/shop",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});
const ranInit = [typed("set up trail in this repo"), toolUse("tu1", "Bash", { command: "trail init --agents claude" }), toolResult("tu1", LIST), said(`Here's what trail found:\n${LIST}`)];

// 1b (design 4.9, R22): the rules after the list (names, numbers, receipt) are in init-keep-gate-1b.test.ts. What
// phase 0 let through changed there: no list, a list no record waits on, or a cut list is now denied.

test("a list no init record waits on is not the list: denied, answered or not", () => {
  assert.match(keepDecision(payload(transcript(ranInit)), "/home/dev/shop")!.reason, /isn't the one waiting/);
  assert.match(keepDecision(payload(transcript([...ranInit, typed("keep 1 and 2")])), "/x")!.reason, /isn't the one waiting/);
});

test("text that only quotes the list (the agent's own reply, a pasted copy) is not the list: nothing to keep from", () => {
  assert.match(keepDecision(payload(transcript([typed("hi"), said(LIST)])), "/x")!.reason, /wait for the person's answer/i);
});

test("a payload the check can't read lets the command through: no transcript, another host's payload, a non-keep command", () => {
  assert.equal(keepDecision(payload(join(tmpdir(), "no-such-transcript.jsonl")), "/x"), null);
  assert.equal(keepDecision({ ...payload(transcript(ranInit)), transcript_path: undefined }, "/x"), null);
  const cursor = { conversation_id: "c1", generation_id: "g1", cursor_version: "1.7.0", workspace_roots: ["/x"], hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "trail keep 1" }, transcript_path: transcript(ranInit) };
  assert.equal(keepDecision(cursor, "/x"), null, "only Claude Code transcripts are read as Claude's");
  assert.equal(keepDecision(payload(transcript(ranInit), "npm test"), "/x"), null);
  for (const bad of [null, undefined, "x", [], {}, { tool_input: null }]) assert.equal(keepDecision(bad, "/x"), null);
});

test("every way of spelling trail keep is caught; commands that only mention the words are not", () => {
  for (const c of [
    "trail keep 1 3",
    "trail keep none",
    "cd /home/dev/shop && trail keep 2",
    "npx trail keep 1",
    "/usr/local/bin/trail keep 1",
    "TRAIL_HOME=/tmp/x trail keep 1",
    "graft keep 1",
    "trail-code keep 1",
    "node dist/bin/trail.js keep 1",
    'bash -c "trail keep 1"',
    "trail  keep\t1",
    "trail --dir graft keep 1",
  ])
    assert.equal(isKeepCommand(c), true, c);
  for (const c of ["trail init", "git commit -m 'keep trail tidy'", "echo keep", "trail ask how do we keep sessions", "npm test"]) assert.equal(isKeepCommand(c), false, c);
});

test("init's output cut short (piped to tail, sent to a file) is no list to keep from: run init again plainly", () => {
  for (const command of ["trail init --agents claude 2>&1 | tail -3", "trail init --agents claude > /tmp/x/init.txt 2>&1"]) {
    const ran = [typed("set up trail in this repo"), toolUse("tu1", "Bash", { command }), toolResult("tu1", "Keep: trail keep <numbers> · none: trail keep none")];
    assert.match(keepDecision(payload(transcript([...ran, typed("keep the second one")])), "/x")!.reason, /without a pipe or redirect/, command);
  }
});

test("one command that runs init and keeps from it never waits for an answer, so it's denied", () => {
  for (const command of ["trail init --agents claude && trail keep 1 2", "trail init; trail keep none", "trail init --yes | tail -1; npx trail keep 1"]) {
    assert.equal(keepDecision(payload(transcript([typed("set up trail in this repo")]), command), "/x")?.permissionDecision, "deny", command);
  }
});
