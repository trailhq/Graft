/**
 * Run sheets: what a finished run did, written for every closed run with a
 * step in it (checked or not), so "save this" can name a run that is no
 * longer the newest, and compile has something to copy from. One index file
 * lists them, so finding the previous run of the same job reads one sheet,
 * never the whole folder. Sheets go after 7 days.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPriorSheet, pruneRunSheets, readRunSheet, runSheetPath, writeRunSheet } from "../src/trace/runs.js";
import { at, runCall, runState } from "./trace-run-fixtures.js";

function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "trace-sheets-"));
  return { ...process.env, TRAIL_HOME: join(dir, ".trail") };
}
const META = { host: "claude", tier: "A" as const, sessionHash: "e76b4ca7f1a0", helpers: [] as string[] };
const indexOf = (env: NodeJS.ProcessEnv) => JSON.parse(readFileSync(join(env.TRAIL_HOME!, "runs", "index.json"), "utf8"));

test("a sheet holds the run, its calls and its verdict; the run learns its sheet and check", () => {
  const env = home();
  const run = runState({
    id: "r-1001-aaaa", branch: "beta", job: "ship", jobWords: ["ship", "beta"], promptParams: { sha: "4e1c9a2" }, toolCalls: 7, edits: 1,
    commands: 3, failedCount: 1, skillId: "s-7f3a2c",
    calls: [
      runCall({ id: "toolu_1", cmd: "git push origin 4e1c9a2:refs/heads/beta", failed: true, isError: true, errorLine: "fatal: Authentication failed" }),
      runCall({ id: "toolu_2", cmd: "cd ../other && make", key: "github.com/acme/other", cwd: "" }),
      runCall({ id: "toolu_3", cmd: "gh api repos/acme/shop/commits/4e1c9a2/status", kind: "look", tail: "success",
        check: { family: "deploy", passed: true, facts: { sha: "4e1c9a2", state: "success" } } }),
    ],
  });
  const sheet = writeRunSheet(run, { checked: true, checkIndex: 2, end: "done" }, META, env);
  assert.equal(run.sheet, "checked");
  assert.equal(run.checkIndex, 2);
  const path = runSheetPath("r-1001-aaaa", env);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  if (process.platform !== "win32") assert.equal(statSync(join(env.TRAIL_HOME!, "runs")).mode & 0o777, 0o700);
  const disk = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(disk, sheet);
  assert.deepEqual(
    { v: disk.v, id: disk.id, session: disk.session, repoKey: disk.repoKey, branch: disk.branch, host: disk.host, tier: disk.tier, epoch: disk.epoch,
      startedAt: disk.startedAt, endedAt: disk.endedAt, job: disk.job, checkIndex: disk.checkIndex, checked: disk.checked, end: disk.end,
      counts: disk.counts, helpers: disk.helpers, skillId: disk.skillId },
    { v: 1, id: "r-1001-aaaa", session: "e76b4ca7f1a0", repoKey: "github.com/acme/shop", branch: "beta", host: "claude", tier: "A", epoch: 0,
      startedAt: at(0), endedAt: at(60), job: "ship", checkIndex: 2, checked: true, end: "done",
      counts: { commands: 3, failed: 1, toolCalls: 7, edits: 1 }, helpers: [], skillId: "s-7f3a2c" },
  );
  assert.deepEqual(disk.calls.map((c: { cwd: string | null }) => c.cwd), ["", null, ""], "a call in another repo keeps no folder");
  assert.deepEqual(readRunSheet("r-1001-aaaa", env), sheet);
  assert.deepEqual(indexOf(env).rows, [{ id: "r-1001-aaaa", session: "e76b4ca7f1a0", repoKey: "github.com/acme/shop", job: "ship", checked: true, startedAt: at(0) }]);

  // Written again (the run went on): one row, the new verdict.
  writeRunSheet(run, { checked: false, checkIndex: null, end: "failure" }, META, env);
  assert.equal(run.sheet, "draft");
  assert.equal(indexOf(env).rows.length, 1);
  assert.equal(indexOf(env).rows[0].checked, false);
});

test("a run id that isn't one never reads or writes outside runs/", () => {
  const env = home();
  for (const id of ["../settings", "r-1/../../x", "", "r-1001-aaaa.json", "/etc/passwd"]) {
    assert.equal(readRunSheet(id, env), null, id);
  }
  assert.throws(() => writeRunSheet(runState({ id: "../x" }), { checked: false, checkIndex: null, end: "done" }, META, env));
});

test("the index keeps the newest 500 rows", () => {
  const env = home();
  for (let i = 0; i < 503; i++) {
    writeRunSheet(runState({ id: `r-1001-${i.toString(16).padStart(4, "0")}`, calls: [] }), { checked: false, checkIndex: null, end: "done" }, META, env);
  }
  const rows = indexOf(env).rows;
  assert.equal(rows.length, 500);
  assert.equal(rows[0].id, "r-1001-0003");
  assert.equal(rows.at(-1).id, "r-1001-01f6");
});

test("sheets older than 7 days go, with their rows; rows whose sheet is gone go too", () => {
  const env = home();
  const now = new Date("2026-10-20T10:00:00Z");
  for (const id of ["r-1001-0001", "r-1001-0002", "r-1001-0003"]) {
    writeRunSheet(runState({ id }), { checked: true, checkIndex: 0, end: "done" }, META, env);
  }
  const old = new Date("2026-10-12T09:00:00Z");
  utimesSync(runSheetPath("r-1001-0001", env), old, old);
  const recent = new Date("2026-10-14T11:00:00Z");
  utimesSync(runSheetPath("r-1001-0002", env), recent, recent);
  writeFileSync(join(env.TRAIL_HOME!, "runs", "notes.txt"), "not a sheet");
  assert.equal(pruneRunSheets(now, env), 1);
  assert.equal(existsSync(runSheetPath("r-1001-0001", env)), false);
  assert.ok(existsSync(join(env.TRAIL_HOME!, "runs", "notes.txt")), "only sheets are pruned");
  assert.deepEqual(indexOf(env).rows.map((r: { id: string }) => r.id), ["r-1001-0002", "r-1001-0003"]);
  assert.equal(pruneRunSheets(now, home()), 0, "no runs folder: nothing to do");
});

test("the prior sheet: the newest other checked run of the same job in the same repo, started before, found through the index", () => {
  const env = home();
  const write = (id: string, extra: Parameters<typeof runState>[0], checked = true) =>
    writeRunSheet(runState({ id, ...extra }), { checked, checkIndex: checked ? 0 : null, end: "done" }, META, env);
  write("r-0920-0001", { startedAt: "2026-09-20T10:00:00Z", job: "tests" });
  write("r-0921-0002", { startedAt: "2026-09-21T10:00:00Z", job: "tests" });
  write("r-0922-0003", { startedAt: "2026-09-22T10:00:00Z", job: "tests" }, false);
  write("r-0922-0004", { startedAt: "2026-09-22T11:00:00Z", job: "ship" });
  write("r-0922-0005", { startedAt: "2026-09-22T12:00:00Z", job: "tests", repoKey: "github.com/acme/other" });
  const mine = write("r-0923-0006", { startedAt: "2026-09-23T10:00:00Z", job: "tests" });
  write("r-0924-0007", { startedAt: "2026-09-24T10:00:00Z", job: "tests" });
  assert.equal(findPriorSheet(mine, env)?.id, "r-0921-0002");
  // A sheet on disk that the index doesn't list is never found: no folder scan.
  const stray = { ...mine, id: "r-0922-0009", startedAt: "2026-09-22T23:00:00Z" };
  writeFileSync(runSheetPath("r-0922-0009", env), JSON.stringify(stray));
  assert.equal(findPriorSheet(mine, env)?.id, "r-0921-0002");
  // The prior's file gone: none (one sheet read, no hunting further back).
  writeFileSync(runSheetPath("r-0921-0002", env), "{broken");
  assert.equal(findPriorSheet(mine, env), null);
  assert.equal(findPriorSheet({ ...mine, job: null }, env), null, "a run with no job has no prior");
});
