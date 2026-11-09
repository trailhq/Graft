/**
 * Reading a session's transcript from where the last hook left off. Hooks run
 * on every turn and one real transcript passes 200 MB, so each read starts at a
 * saved byte offset, keeps a half-written last line for next time, and starts
 * over when the file shrank or was replaced. Tool calls and their results are
 * paired so a failed command is known as one, even across reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readNewEvents, type TraceEvent } from "../src/trace/claude.js";
import { readAppended } from "../src/trace/cursor.js";
import { splitEpochs } from "../src/trace/epochs.js";
import { failedText } from "../src/trace/failure.js";
import {
  compactBoundary, compactSummary, hookContext, hookSuccess, ideOpened, jsonl, said, sidechain, taskNotification, text, thinking, title, toolResult,
  toolUse, typed,
} from "./trace-fixtures.js";

function scratch(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `trace-${tag}-`));
  return { dir, transcript: join(dir, "s.jsonl"), cursor: join(dir, "state", "s.json") };
}

const kinds = (evs: TraceEvent[]) => evs.map((e) => e.kind);

test("a transcript becomes one stream of events: typed, injected, calls, results, compactions", () => {
  const { transcript, cursor } = scratch("stream");
  writeFileSync(
    transcript,
    jsonl([
      title(),
      typed([ideOpened(), text("run the integration tests")]),
      thinking(),
      said("Running them now."),
      toolUse("toolu_a", "Bash", { command: "npm run test:integration" }),
      toolResult("toolu_a", "Exit code 1\nError: connect ECONNREFUSED 127.0.0.1:5432", true),
      toolUse("toolu_b", "Bash", { command: "npm run test:integration 2>&1 | tail -5" }),
      toolResult("toolu_b", "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1", false),
      toolUse("toolu_c", "Bash", { command: "docker compose up -d db && npm run test:integration" }),
      toolResult("toolu_c", "Tests: 42 passed, 42 total", false),
      hookSuccess(),
      sidechain(),
      taskNotification(true),
      hookContext("[trail] 1 learning for this repo"),
      compactBoundary(),
      compactSummary(),
      typed("now ship it"),
    ]),
  );
  const evs = readNewEvents(transcript, cursor);
  assert.deepEqual(kinds(evs), [
    "typed", "injected", "assistant",
    "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result",
    "injected", "injected",
    "compaction", "injected",
    "typed",
  ]);
  const typedOnes = evs.filter((e) => e.kind === "typed").map((e) => (e as { text: string }).text);
  assert.deepEqual(typedOnes, ["run the integration tests", "now ship it"]);
  // The IDE tag stripped from the prompt is still text the agent saw.
  assert.match((evs[1] as { text: string }).text, /ide_opened_file/);
  const results = evs.filter((e): e is Extract<TraceEvent, { kind: "tool_result" }> => e.kind === "tool_result");
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [["toolu_a", false], ["toolu_b", false], ["toolu_c", true]]);
  const call = evs.find((e) => e.kind === "tool_call") as Extract<TraceEvent, { kind: "tool_call" }>;
  assert.deepEqual([call.id, call.name, call.input], ["toolu_a", "Bash", { command: "npm run test:integration" }]);
  assert.equal(call.at, "2026-10-01T10:00:00.000Z");
  // Nothing new: nothing returned.
  assert.deepEqual(readNewEvents(transcript, cursor), []);
});

test("only what was appended since the last read comes back", () => {
  const { transcript, cursor } = scratch("append");
  writeFileSync(transcript, jsonl([typed("bump the version"), said("Bumped to 1.4.0.")]));
  assert.deepEqual(kinds(readNewEvents(transcript, cursor)), ["typed", "assistant"]);
  appendFileSync(transcript, jsonl([typed("now publish"), toolUse("toolu_p", "Bash", { command: "npm publish" })]));
  const next = readNewEvents(transcript, cursor);
  assert.deepEqual(kinds(next), ["typed", "tool_call"]);
  assert.equal((next[0] as { text: string }).text, "now publish");
});

test("a half-written last line waits for the next read", () => {
  const { transcript, cursor } = scratch("partial");
  const line = JSON.stringify(typed("tag the release"));
  writeFileSync(transcript, jsonl([said("Done.")]) + line.slice(0, 40));
  assert.deepEqual(kinds(readNewEvents(transcript, cursor)), ["assistant"]);
  assert.deepEqual(readNewEvents(transcript, cursor), [], "still half-written");
  appendFileSync(transcript, line.slice(40) + "\n");
  const evs = readNewEvents(transcript, cursor);
  assert.deepEqual(kinds(evs), ["typed"]);
  assert.equal((evs[0] as { text: string }).text, "tag the release");
});

test("a file that shrank, or was replaced, is read again from the start", () => {
  const { dir, transcript, cursor } = scratch("shrink");
  writeFileSync(transcript, jsonl([typed("one"), typed("two"), typed("three")]));
  assert.equal(readNewEvents(transcript, cursor).length, 3);
  writeFileSync(transcript, jsonl([typed("fresh")]));
  assert.deepEqual(readNewEvents(transcript, cursor).map((e) => (e as { text: string }).text), ["fresh"]);
  // Rewritten in place, longer than before: same file, different bytes before the offset.
  writeFileSync(transcript, jsonl([typed("rewritten one"), typed("rewritten two")]));
  assert.deepEqual(readNewEvents(transcript, cursor).map((e) => (e as { text: string }).text), ["rewritten one", "rewritten two"]);
  // Replaced by a different, longer file: not the same file, so not the same offset.
  const other = join(dir, "other.jsonl");
  writeFileSync(other, jsonl([typed("alpha"), typed("beta"), typed("gamma"), typed("delta")]));
  renameSync(other, transcript);
  assert.deepEqual(readNewEvents(transcript, cursor).map((e) => (e as { text: string }).text), ["alpha", "beta", "gamma", "delta"]);
});

test("a result read later is still paired with its call", () => {
  const { transcript, cursor } = scratch("pair");
  writeFileSync(transcript, jsonl([toolUse("toolu_r", "Read", { file_path: "/home/dev/shop/NOTES.md" }), toolUse("toolu_s", "Bash", { command: "git push" })]));
  assert.deepEqual(kinds(readNewEvents(transcript, cursor)), ["tool_call", "tool_call"]);
  // A file that says "fatal:" is a file, not a failure; a command that says it failed.
  appendFileSync(transcript, jsonl([toolResult("toolu_r", "fatal: example line in a notes file"), toolResult("toolu_s", "fatal: could not read Username for 'https://example.test'", false)]));
  const evs = readNewEvents(transcript, cursor) as Extract<TraceEvent, { kind: "tool_result" }>[];
  assert.deepEqual(evs.map((e) => [e.id, e.ok]), [["toolu_r", true], ["toolu_s", false]]);
  // A result whose call was never seen is judged as a command.
  appendFileSync(transcript, jsonl([toolResult("toolu_unknown", "npm ERR! code E401")]));
  const lone = readNewEvents(transcript, cursor) as Extract<TraceEvent, { kind: "tool_result" }>[];
  assert.deepEqual(lone.map((e) => e.ok), [false]);
});

test("result text: arrays of parts are joined, and a huge result keeps its head and tail", () => {
  const { transcript, cursor } = scratch("big");
  const big = `START ${"x".repeat(200_000)} END`;
  writeFileSync(
    transcript,
    jsonl([toolUse("toolu_1", "Bash", { command: "cat build.log" }), toolResult("toolu_1", [text("part one"), { type: "image", source: { type: "base64", data: "AAAA" } }, text("part two")]), toolResult("toolu_2", big)]),
  );
  const [, parts, huge] = readNewEvents(transcript, cursor) as Extract<TraceEvent, { kind: "tool_result" }>[];
  assert.equal(parts!.text, "part one\npart two");
  assert.ok(huge!.text.length < 50_000);
  assert.ok(huge!.text.startsWith("START") && huge!.text.endsWith("END"));
});

test("a missing transcript or a broken cursor never throws", () => {
  const { dir, transcript, cursor } = scratch("broken");
  assert.deepEqual(readNewEvents(join(dir, "nope.jsonl"), cursor), []);
  assert.equal(existsSync(cursor), false, "no cursor for a file that isn't there");
  writeFileSync(transcript, jsonl([typed("hello there")]) + "{not json\n" + jsonl([typed("still read")]));
  writeFileSync(join(dir, "bad.json"), "{{{");
  const evs = readNewEvents(transcript, join(dir, "bad.json"));
  assert.deepEqual(evs.map((e) => (e as { text: string }).text), ["hello there", "still read"]);
  assert.deepEqual(readNewEvents(transcript, join(dir, "bad.json")), [], "the cursor was rewritten");
});

test("the cursor lives beside other session state without clobbering it, private to the person", (t) => {
  const { transcript, cursor } = scratch("cursor");
  writeFileSync(transcript, jsonl([typed("hi")]));
  readNewEvents(transcript, cursor);
  const shared = JSON.parse(readFileSync(cursor, "utf8"));
  shared.offer = { pending: true };
  writeFileSync(cursor, JSON.stringify(shared));
  appendFileSync(transcript, jsonl([typed("again")]));
  assert.equal(readNewEvents(transcript, cursor).length, 1);
  const after = JSON.parse(readFileSync(cursor, "utf8"));
  assert.deepEqual(after.offer, { pending: true });
  assert.equal(after.trace.offset, statSync(transcript).size);
  // No prompt text in the cursor: only offsets and tool ids.
  assert.ok(!readFileSync(cursor, "utf8").includes("again"));
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  assert.equal(statSync(cursor).mode & 0o777, 0o600);
});

test("state another hook saves while a read is running is kept", () => {
  const { transcript, cursor } = scratch("race");
  writeFileSync(transcript, jsonl([typed("one"), typed("two")]));
  mkdirSync(dirname(cursor), { recursive: true });
  let n = 0;
  readAppended(transcript, cursor, () => {
    // A Stop hook records a pending offer in the same session file mid-read.
    if (n++ === 0) writeFileSync(cursor, JSON.stringify({ offer: { pending: true } }));
  });
  const after = JSON.parse(readFileSync(cursor, "utf8"));
  assert.deepEqual(after.offer, { pending: true });
  assert.equal(after.trace.offset, statSync(transcript).size);
});

test("a read that finishes after a faster one never moves the offset back", () => {
  const { dir, transcript, cursor } = scratch("behind");
  writeFileSync(transcript, jsonl([typed("one")]));
  mkdirSync(dirname(cursor), { recursive: true });
  let n = 0;
  readAppended(transcript, cursor, () => {
    if (n++) return;
    // While this read runs, the transcript grows and another hook reads all of it.
    appendFileSync(transcript, jsonl([typed("two")]));
    const other = join(dir, "other.json");
    readNewEvents(transcript, other, { firstReadBytes: Infinity });
    writeFileSync(cursor, readFileSync(other, "utf8"));
  });
  assert.equal(JSON.parse(readFileSync(cursor, "utf8")).trace.offset, statSync(transcript).size);
  assert.deepEqual(readNewEvents(transcript, cursor), [], "nothing is read twice");
});

test("a stale offset from before a rewrite never wins over a fresh read", () => {
  const { transcript, cursor } = scratch("stale");
  writeFileSync(transcript, jsonl([typed("old one"), typed("old two")]));
  readNewEvents(transcript, cursor);
  // Rewritten in place: longer, with a half-written last line past the old offset.
  const last = JSON.stringify(typed("new three"));
  writeFileSync(transcript, jsonl([typed("new one")]) + last);
  assert.ok(statSync(transcript).size > JSON.parse(readFileSync(cursor, "utf8")).trace.offset);
  assert.deepEqual(readNewEvents(transcript, cursor).map((e) => (e as { text: string }).text), ["new one"]);
  appendFileSync(transcript, "\n");
  assert.deepEqual(readNewEvents(transcript, cursor).map((e) => (e as { text: string }).text), ["new three"]);
});

test("a first read of a long transcript starts near the end, on a line boundary", () => {
  const { transcript, cursor } = scratch("first");
  const lines = Array.from({ length: 200 }, (_, i) => typed(`prompt number ${i}`));
  writeFileSync(transcript, jsonl(lines));
  const evs = readNewEvents(transcript, cursor, { firstReadBytes: 3000 }) as { kind: string; text: string }[];
  assert.ok(evs.length > 0 && evs.length < 20, `read ${evs.length}`);
  assert.equal(evs[evs.length - 1]!.text, "prompt number 199");
  for (const e of evs) assert.match(e.text, /^prompt number \d+$/);
  // The whole file, when asked for.
  const all = readNewEvents(transcript, join(cursor + ".all"), { firstReadBytes: Infinity });
  assert.equal(all.length, 200);
});

test("a first window that starts right on a line boundary keeps that line", () => {
  const { transcript, cursor } = scratch("edge");
  const tail = jsonl([typed("last but one"), typed("last")]);
  writeFileSync(transcript, jsonl([typed("early")]) + tail);
  const evs = readNewEvents(transcript, cursor, { firstReadBytes: Buffer.byteLength(tail) }) as { text: string }[];
  assert.deepEqual(evs.map((e) => e.text), ["last but one", "last"]);
});

test("lines with multi-byte characters survive a read split across chunks", () => {
  const { transcript, cursor } = scratch("utf8");
  const word = "é✓日本".repeat(250);
  const lines = Array.from({ length: 2500 }, () => said(word));
  writeFileSync(transcript, jsonl(lines));
  assert.ok(statSync(transcript).size > 4 * 1024 * 1024, "spans more than one chunk");
  const evs = readNewEvents(transcript, cursor, { firstReadBytes: Infinity });
  assert.equal(evs.length, 2500);
  for (const e of evs) assert.equal((e as { text: string }).text, word);
});

test("context epochs: a session's start and every compaction begin one", () => {
  const t = (s: string): TraceEvent => ({ kind: "typed", text: s, at: "" });
  const c: TraceEvent = { kind: "compaction", at: "" };
  assert.deepEqual(splitEpochs([]), []);
  assert.deepEqual(splitEpochs([t("a"), t("b")]), [[t("a"), t("b")]]);
  assert.deepEqual(splitEpochs([t("a"), c, t("b"), c]), [[t("a")], [c, t("b")], [c]]);
  assert.deepEqual(splitEpochs([c, t("a")]), [[c, t("a")]]);
});

test("a command's failure is read from its text when its exit code was piped away", () => {
  for (const s of ["npm ERR! code E401", "Exit code 1", "Exit code: 2", "exit status 1", "fatal: not a git repository", "zsh: command not found: timeout", "Process exited with code 3", "Error: Cannot find module 'x'", "Error: EACCES: permission denied", "npm error code E404"]) {
    assert.equal(failedText(s), true, s);
  }
  for (const s of [
    "Tests: 42 passed", "Exit code 0", "no errors found", "0 errors, 0 warnings", "see error: below",
    // Error codes are upper case; a UUID's hex block is not one.
    "created run 123e4567-e404-42d3-a456-426614174000", "id 9f8e7d6c-5b4a-4c2d-e401-a9b8c7d6e5f4",
  ]) {
    assert.equal(failedText(s), false, s);
  }
});

test("onEntry sees each line once, in order, with a memo that lasts as long as the cursor", () => {
  const { transcript, cursor } = scratch("on-entry");
  writeFileSync(transcript, jsonl([typed("run the tests"), said("Running them.")]) + "not json\n");
  const seen: string[] = [];
  const count = (e: Record<string, unknown>, memo: Record<string, unknown>) => {
    seen.push(String(e.type));
    memo.mine = ((memo.mine as number | undefined) ?? 0) + 1;
  };
  const evs = readNewEvents(transcript, cursor, { onEntry: count });
  assert.deepEqual(kinds(evs), ["typed", "assistant"], "the events are unchanged by it");
  assert.deepEqual(seen, ["user", "assistant"], "objects only: the broken line is skipped");
  appendFileSync(transcript, jsonl([said("Done.")]));
  readNewEvents(transcript, cursor, { onEntry: count });
  assert.deepEqual(seen, ["user", "assistant", "assistant"], "only the appended line the second time");
  assert.equal(JSON.parse(readFileSync(cursor, "utf8")).trace.memo.mine, 3, "the caller's key is saved with the cursor");
  writeFileSync(transcript, jsonl([typed("start over")]));
  readNewEvents(transcript, cursor, { onEntry: count });
  assert.equal(JSON.parse(readFileSync(cursor, "utf8")).trace.memo.mine, 1, "a rewritten file starts the memo over");
});
