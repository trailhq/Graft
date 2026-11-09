/**
 * The fold's 1b additions (design 0.2, R8, R52): a call's wall class is set
 * where the fold still holds the result text, and a run's repairs are
 * filled when it closes, while it still has its calls. Synthetic sessions in
 * acme/shop only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedSuccess, cutAtCompaction, readRunSheet, writeRunSheet } from "../src/trace/runs.js";
import { compactBoundary } from "./trace-fixtures.js";
import { ask, at, bash, session } from "./trace-run-fixtures.js";

const DOCKER = "Error: rootless Docker not found\n--- FAIL: TestCart (0.01s)\nFAIL\tacme/shop/cart\t0.2s";
const PASS = "ok  \tacme/shop/cart\t0.4s";
const SOCK = "DOCKER_HOST=unix:///var/run/colima.sock";

/** A failed `go test` on the Docker wall, `colima start`, and the retry that worked, from `sec` on. */
const repairAt = (sec: number, pkg = "./...") => [
  ...bash(`go test ${pkg}`, DOCKER, { sec, isError: true, cwd: "/home/dev/shop" }),
  ...bash("colima start", "INFO[0001] starting colima", { sec: sec + 2, cwd: "/home/dev/shop" }),
  ...bash(`${SOCK} go test ${pkg}`, PASS, { sec: sec + 4, cwd: "/home/dev/shop" }),
];

test("a failed result on a wall sets RunCall.wall; an ordinary failure doesn't", () => {
  const s = session("wall");
  s.fold([ask("run the integration tests", 0), ...bash("go test ./...", DOCKER, { sec: 1, isError: true }), ...bash("go vet ./...", "vet: bad\nExit code 1", { sec: 3, isError: true })]);
  const [walled, plain] = s.st.runs[0]!.calls;
  assert.equal(walled!.failed, true);
  assert.equal(walled!.wall, "docker-rootless");
  assert.equal(plain!.failed, true);
  assert.equal(plain!.wall, undefined);
});

test("exit-0 results: only the three classes, never a look-only call, never a CI log read", () => {
  const s = session("exit0");
  s.fold([
    ask("run the integration tests", 0),
    ...bash("go test ./... 2>&1 | tail -5", "rootless Docker not found\nok", { sec: 1 }),
    ...bash("claude -p hello", "Invalid API key · Please run /login", { sec: 3 }),
    ...bash("cat ci.log", "rootless Docker not found", { sec: 5 }),
    ...bash("gh run view 812 --log-failed", "rootless Docker not found", { sec: 7, isError: true }),
  ]);
  const calls = s.st.runs[0]!.calls;
  assert.deepEqual(calls.map((c) => [c.failed, c.wall ?? null]), [
    [false, "docker-rootless"],
    [false, null],
    [false, null],
    [true, null],
  ]);
});

test("the wall is kept in the run sheet as a class name", () => {
  const home = mkdtempSync(join(tmpdir(), "graft-runs1b-"));
  try {
    const env = { ...process.env, TRAIL_HOME: join(home, ".trail") };
    const s = session("sheet");
    s.fold([ask("run the integration tests", 0), ...repairAt(1)]);
    const run = s.st.runs[0]!;
    writeRunSheet(run, checkedSuccess(run, null), { host: "claude", tier: "A", sessionHash: "e76b4ca7f1a0", helpers: [] }, env);
    const sheet = readRunSheet(run.id, env)!;
    assert.equal(sheet.calls[0]!.wall, "docker-rootless");
    const raw = JSON.parse(readFileSync(join(home, ".trail", "runs", `${run.id}.json`), "utf8")) as { calls: Array<Record<string, unknown>> };
    assert.deepEqual(raw.calls.map((c) => c.wall ?? null), ["docker-rootless", null, null], "a class name on the failed call only");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("RunState.repairs is filled when the run closes, not while it is open", () => {
  const s = session("close");
  s.fold([ask("run the integration tests", 0), ...repairAt(1)]);
  const run = s.st.runs[0]!;
  assert.equal(run.repairs, undefined, "an open run has none yet");
  const res = s.fold([ask("push to beta", 60)]);
  assert.ok(res.closed.includes(run));
  const calls = run.calls;
  assert.deepEqual(run.repairs, [{
    cls: "docker-rootless", program: "go test", failCallId: calls[0]!.id, fixCallId: calls[2]!.id, epoch: 0, runId: run.id, at: at(5),
    delta: [
      { kind: "enable-step", name: "colima", text: "colima start", callId: calls[1]!.id },
      { kind: "env", name: "DOCKER_HOST", text: SOCK, callId: calls[2]!.id },
    ],
  }]);
  assert.equal(s.st.runs[1]!.repairs, undefined, "a run with no repair has no field");
});

test("repair text is relativized to the session's checkout", () => {
  const s = session("rel");
  s.fold([
    ask("run the integration tests", 0),
    ...bash("go test ./...", DOCKER, { sec: 1, isError: true }),
    ...bash("GOFLAGS=-modfile=/home/dev/shop/go.alt.mod go test ./...", PASS, { sec: 3 }),
    ask("push to beta", 60),
  ]);
  assert.deepEqual(s.st.runs[0]!.repairs?.[0]?.delta.map((d) => d.text), ["GOFLAGS=-modfile=./go.alt.mod"]);
});

test("RunState.repairs is capped at 5", () => {
  const s = session("cap");
  const evs: object[] = [ask("run the integration tests", 0)];
  for (let i = 0; i < 7; i++) evs.push(...repairAt(1 + i * 10, `./pkg${i}/...`));
  s.fold([...evs, ask("push to beta", 600)]);
  assert.equal(s.st.runs[0]!.repairs?.length, 5);
});

test("a compaction closes the run with its repairs, in the fold and from SessionStart", () => {
  const s = session("compact");
  s.fold([ask("run the integration tests", 0), ...repairAt(1), compactBoundary({ timestamp: at(30) })]);
  assert.equal(s.st.runs[0]!.closed, true);
  assert.equal(s.st.runs[0]!.repairs?.length, 1);
  const t = session("compact-start");
  t.fold([ask("run the integration tests", 0), ...repairAt(1)]);
  const closed = cutAtCompaction(t.st, { root: "/home/dev/shop" });
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.repairs?.[0]?.cls, "docker-rootless");
});

test("a retry whose result comes after the run closed still counts", () => {
  const s = session("late");
  const [use, result] = bash(`${SOCK} go test ./...`, PASS, { sec: 5, id: "toolu_late" });
  s.fold([ask("run the integration tests", 0), ...bash("go test ./...", DOCKER, { sec: 1, isError: true }), use!, ask("push to beta", 60)]);
  assert.equal(s.st.runs[0]!.closed, true);
  assert.equal(s.st.runs[0]!.repairs, undefined);
  s.fold([result!]);
  assert.equal(s.st.runs[0]!.repairs?.[0]?.fixCallId, "toolu_late");
});

test("runs.ts stays under 480 lines", () => {
  const lines = readFileSync(new URL("../src/trace/runs.ts", import.meta.url), "utf8").split("\n").length;
  assert.ok(lines < 480, `runs.ts has ${lines} lines`);
});
