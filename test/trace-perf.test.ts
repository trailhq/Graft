/**
 * A hook reads only what a transcript gained since its last read, so the time
 * it takes follows the size of the tail, not of the file. The small test runs
 * always; the 200 MB one (a real transcript passed 233 MB) runs with
 * TRAIL_PERF=1 and deletes its file after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNewEvents } from "../src/trace/claude.js";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";

/** One turn: a prompt, a command, its output, a reply. About 3 KB. */
function turn(i: number): string {
  return jsonl([
    typed(`run the tests for module ${i}`),
    toolUse(`toolu_${i}`, "Bash", { command: `npm test -- module-${i}` }),
    toolResult(`toolu_${i}`, `PASS module-${i}\n${"ok line of test output\n".repeat(100)}`, false),
    said(`Module ${i} passes.`),
  ]);
}

/** Write `bytes` of turns to `path`, in big blocks. */
function build(path: string, bytes: number): void {
  const block = Array.from({ length: 200 }, (_, i) => turn(i)).join("");
  const fd = openSync(path, "w");
  try {
    for (let written = 0; written < bytes; written += Buffer.byteLength(block)) writeSync(fd, block);
  } finally {
    closeSync(fd);
  }
}

function p95(ms: number[]): number {
  const s = [...ms].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
}

/** Append a turn and time reading it back, `rounds` times. */
function timeTails(transcript: string, cursor: string, rounds: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    appendFileSync(transcript, turn(100_000 + i));
    const t0 = performance.now();
    const evs = readNewEvents(transcript, cursor);
    times.push(performance.now() - t0);
    assert.deepEqual(evs.map((e) => e.kind), ["typed", "tool_call", "tool_result", "assistant"], "only the appended turn");
  }
  return times;
}

test("reading an appended tail returns just that tail, quickly", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-perf-small-"));
  try {
    const transcript = join(dir, "s.jsonl");
    const cursor = join(dir, "cursor.json");
    build(transcript, 4 * 1024 * 1024);
    readNewEvents(transcript, cursor, { firstReadBytes: Infinity });
    const times = timeTails(transcript, cursor, 20);
    assert.ok(p95(times) < 300, `p95 ${p95(times).toFixed(1)} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on a 200 MB transcript an appended tail reads in under 300 ms p95", { skip: process.env.TRAIL_PERF === "1" ? false : "set TRAIL_PERF=1 to run" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-perf-big-"));
  try {
    const transcript = join(dir, "s.jsonl");
    const cursor = join(dir, "cursor.json");
    build(transcript, 200 * 1024 * 1024);
    assert.ok(statSync(transcript).size >= 200 * 1024 * 1024);
    // A hook meeting the session for the first time reads only the end of it.
    const t0 = performance.now();
    const first = readNewEvents(transcript, cursor);
    const firstMs = performance.now() - t0;
    assert.ok(first.length > 0);
    assert.ok(firstMs < 1000, `first read ${firstMs.toFixed(1)} ms`);
    const times = timeTails(transcript, cursor, 40);
    assert.ok(p95(times) < 300, `p95 ${p95(times).toFixed(1)} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
