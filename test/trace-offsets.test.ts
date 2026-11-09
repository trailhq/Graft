/**
 * Where each transcript line sits on disk. The save gate re-reads a step's
 * tool_use and tool_result lines, and the person's typed yes, at their byte
 * offsets, so every event carries the offset of the line it came from. Tool
 * calls also carry the folder and branch the host recorded for them, and a
 * result carries the host's own error flag apart from failure text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNewEvents, type TraceEvent } from "../src/trace/claude.js";
import { readAppended } from "../src/trace/cursor.js";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";

function scratch(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `trace-off-${tag}-`));
  return { dir, transcript: join(dir, "s.jsonl"), cursor: join(dir, "state", "s.json") };
}

/** The bytes of the line that starts at `offset`. */
function lineAt(path: string, offset: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const got = readSync(fd, buf, 0, buf.length, offset);
    const s = buf.subarray(0, got);
    const nl = s.indexOf(0x0a);
    return s.subarray(0, nl < 0 ? got : nl).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

test("onLine gets each line's byte offset, across reads and chunks", () => {
  const { transcript, cursor } = scratch("cursor");
  const lines = ["{\"a\":1}", "{\"b\":\"é ✓ 日本\"}", "{\"c\":3}"];
  writeFileSync(transcript, lines.slice(0, 2).join("\n") + "\n");
  const seen: Array<[string, number]> = [];
  readAppended(transcript, cursor, (line, _memo, offset) => seen.push([line, offset]), { firstReadBytes: Infinity });
  appendFileSync(transcript, lines[2] + "\n");
  readAppended(transcript, cursor, (line, _memo, offset) => seen.push([line, offset]));
  assert.deepEqual(seen.map(([l]) => l), lines);
  for (const [line, offset] of seen) assert.equal(lineAt(transcript, offset), line);
  assert.equal(seen[1]![1], Buffer.byteLength(lines[0]!) + 1);
});

test("a first read that starts mid-file still gives true file offsets", () => {
  const { transcript, cursor } = scratch("mid");
  const filler = jsonl(Array.from({ length: 400 }, (_, i) => said(`filler ${i} ${"x".repeat(200)}`)));
  writeFileSync(transcript, filler + jsonl([typed("deploy to beta please")]));
  const evs = readNewEvents(transcript, cursor, { firstReadBytes: 4096 });
  const t = evs.find((e) => e.kind === "typed")!;
  assert.ok(t.offset !== undefined && t.offset > 4096);
  assert.equal(JSON.parse(lineAt(transcript, t.offset!)).message.content, "deploy to beta please");
});

test("every event carries its line's offset; a call carries cwd and branch; a result its host error flag", () => {
  const { transcript, cursor } = scratch("events");
  writeFileSync(
    transcript,
    jsonl([
      typed("ship it to beta"),
      toolUse("toolu_a", "Bash", { command: "git push origin main:beta" }, { cwd: "/home/dev/shop/backend", gitBranch: "feature/x" }),
      toolResult("toolu_a", "Exit code 1\nfatal: could not read Username", true),
      toolUse("toolu_b", "Bash", { command: "npm test" }),
      toolResult("toolu_b", "FAIL src/cart.test.ts\nTests: 1 failed", false),
      said("The tests failed."),
    ]),
  );
  const evs = readNewEvents(transcript, cursor, { firstReadBytes: Infinity });
  for (const e of evs) {
    assert.equal(typeof e.offset, "number", e.kind);
    const entry = JSON.parse(lineAt(transcript, e.offset!));
    assert.equal(entry.timestamp, e.at);
  }
  const calls = evs.filter((e): e is Extract<TraceEvent, { kind: "tool_call" }> => e.kind === "tool_call");
  assert.equal(calls[0]!.cwd, "/home/dev/shop/backend");
  assert.equal(calls[0]!.branch, "feature/x");
  assert.equal(calls[1]!.cwd, "/home/dev/shop");
  assert.equal(calls[1]!.branch, "main");
  const results = evs.filter((e): e is Extract<TraceEvent, { kind: "tool_result" }> => e.kind === "tool_result");
  assert.deepEqual(results.map((r) => [r.ok, r.isError]), [[false, true], [false, false]]);
});

test("a line with no cwd or branch gives none; a result with no is_error is not a host error", () => {
  const { transcript, cursor } = scratch("bare");
  const call = toolUse("toolu_c", "Bash", { command: "ls" });
  delete (call as Record<string, unknown>).cwd;
  delete (call as Record<string, unknown>).gitBranch;
  writeFileSync(transcript, jsonl([call, toolResult("toolu_c", "a\nb")]));
  const evs = readNewEvents(transcript, cursor, { firstReadBytes: Infinity });
  const c = evs.find((e) => e.kind === "tool_call") as Extract<TraceEvent, { kind: "tool_call" }>;
  assert.equal(c.cwd, undefined);
  assert.equal(c.branch, undefined);
  const r = evs.find((e) => e.kind === "tool_result") as Extract<TraceEvent, { kind: "tool_result" }>;
  assert.equal(r.isError, false);
  assert.equal(r.ok, true);
});
