/**
 * A run a compaction cut carries its job into the next one (D59a), so its
 * sheet holds only the calls after the compaction. `joinCarriedSheet` walks
 * `carriedFrom` back (at most 5 sheets), checks each link and joins the
 * parts oldest first, so compile and "save this" see the whole job. A part
 * that is gone (pruned, or never written because it had no step) means
 * nothing to copy, never a refusal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CARRY_HOPS, checkedSuccess, joinCarriedSheet, lastGoodRun, writeRunSheet } from "../src/trace/runs.js";
import type { CheckHit, RunCall, RunSheet } from "../src/trace/types.js";
import { emptyState, runCall, runState } from "./trace-run-fixtures.js";

const SHOP = "github.com/acme/shop";
const pass = (family: CheckHit["family"], facts: CheckHit["facts"] = {}): CheckHit => ({ family, passed: true, facts });
let n = 0;
const step = (cmd: string, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_j${++n}`, cmd, ...extra });

function part(id: string, calls: RunCall[], extra: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id, session: "e76b4ca7f1a0", repoKey: SHOP, branch: null, host: "claude", tier: "A", epoch: 1,
    startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:05:00.000Z", job: "ship", jobWords: ["push", "beta"], sharedWords: [],
    promptParams: {}, calls, checkIndex: null, checked: false, end: "open",
    counts: { commands: calls.filter((c) => !c.tool).length, failed: calls.filter((c) => c.failed).length, toolCalls: calls.length, edits: 0 },
    helpers: [], skillId: null, ...extra,
  };
}

/** A reader over an in-memory set of sheets that counts its reads. */
function reader(sheets: RunSheet[]) {
  const reads: string[] = [];
  const read = (id: string) => { reads.push(id); return sheets.find((s) => s.id === id) ?? null; };
  return { read, reads };
}

test("a sheet that carries nothing is returned as it is, without a read", () => {
  const s = part("r-1001-0001", [step("npm run build")]);
  const { read, reads } = reader([]);
  assert.equal(joinCarriedSheet(s, read), s);
  assert.deepEqual(reads, []);
});

test("two parts join oldest first: calls in order, the check shifted, the newest part's verdict and job, counts summed", () => {
  const before = part("r-1001-0001", [step("git fetch origin"), step("npm run build", { failed: true }), step("npm run build")], {
    branch: "main", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:06:00.000Z", epoch: 1, end: "open",
    jobWords: ["push", "beta"], sharedWords: ["beta"], helpers: ["/tmp/x/a.sh"], counts: { commands: 3, failed: 1, toolCalls: 4, edits: 1 },
  });
  const after = part("r-1001-0002", [step("git push origin HEAD:beta", { check: pass("push", { branch: "beta" }) }), step("git status")], {
    branch: "beta", startedAt: "2026-10-01T10:07:00.000Z", endedAt: "2026-10-01T10:09:00.000Z", epoch: 2, carriedFrom: "r-1001-0001",
    checkIndex: 0, checked: true, end: "done", jobWords: ["push", "beta", "prod"], promptParams: { branch: "beta" }, skillId: "s-0a1b2c",
    sharedWords: ["push"], helpers: ["/tmp/x/a.sh", "/tmp/x/b.sh"], counts: { commands: 2, failed: 0, toolCalls: 3, edits: 0 },
  });
  const { read, reads } = reader([before]);
  const j = joinCarriedSheet(after, read);
  assert.deepEqual(reads, ["r-1001-0001"]);
  assert.deepEqual(j.calls.map((c) => c.cmd), ["git fetch origin", "npm run build", "npm run build", "git push origin HEAD:beta", "git status"]);
  assert.equal(j.checkIndex, 3, "the check stays on the push: its index plus the 3 calls before it");
  assert.equal(j.calls[j.checkIndex!]!.cmd, "git push origin HEAD:beta");
  assert.deepEqual([j.id, j.checked, j.end, j.job, j.skillId, j.epoch], ["r-1001-0002", true, "done", "ship", "s-0a1b2c", 2]);
  assert.deepEqual(j.jobWords, ["push", "beta", "prod"]);
  assert.deepEqual(j.promptParams, { branch: "beta" });
  assert.equal(j.branch, "main", "the first branch any part saw");
  assert.deepEqual([j.startedAt, j.endedAt], ["2026-10-01T10:00:00.000Z", "2026-10-01T10:09:00.000Z"]);
  assert.deepEqual(j.counts, { commands: 5, failed: 1, toolCalls: 7, edits: 1 });
  assert.deepEqual(j.helpers, ["/tmp/x/a.sh", "/tmp/x/b.sh"]);
  assert.deepEqual(j.sharedWords, ["beta", "push"]);
  assert.deepEqual(j.joined, [{ id: "r-1001-0001", calls: 3 }]);
  assert.equal(j.carriedFrom, undefined, "a joined sheet carries nothing more");
  assert.equal(joinCarriedSheet(j, read), j, "joining twice changes nothing");
  assert.equal(after.calls.length, 2, "the sheets read are not changed");
  // A check that was null stays null.
  assert.equal(joinCarriedSheet({ ...after, checkIndex: null, checked: false }, read).checkIndex, null);
});

test(`it walks back at most ${MAX_CARRY_HOPS} sheets, oldest first`, () => {
  const ids = Array.from({ length: 8 }, (_, i) => `r-1001-00${String(i + 10)}`);
  const sheets = ids.map((id, i) => part(id, [step(`echo part ${i}`, { kind: "step" })], {
    epoch: i, startedAt: `2026-10-01T1${i}:00:00.000Z`, endedAt: `2026-10-01T1${i}:30:00.000Z`, ...(i ? { carriedFrom: ids[i - 1] } : {}),
  }));
  const { read, reads } = reader(sheets);
  const j = joinCarriedSheet(sheets[7]!, read);
  assert.equal(MAX_CARRY_HOPS, 5);
  assert.equal(reads.length, 5);
  assert.deepEqual(j.joined, ids.slice(2, 7).map((id) => ({ id, calls: 1 })));
  assert.deepEqual(j.calls.map((c) => c.cmd), ["echo part 2", "echo part 3", "echo part 4", "echo part 5", "echo part 6", "echo part 7"]);
});

test("a missing part means nothing to copy, not a refusal: the walk keeps what it found", () => {
  const mid = part("r-1001-0021", [step("npm run build")], { carriedFrom: "r-1001-0020", startedAt: "2026-10-01T10:10:00.000Z", endedAt: "2026-10-01T10:12:00.000Z" });
  const top = part("r-1001-0022", [step("git push origin HEAD:beta")], { carriedFrom: "r-1001-0021", startedAt: "2026-10-01T10:13:00.000Z", endedAt: "2026-10-01T10:14:00.000Z" });
  const { read } = reader([mid]);
  const j = joinCarriedSheet(top, read);
  assert.deepEqual(j.joined, [{ id: "r-1001-0021", calls: 1 }]);
  assert.deepEqual(j.calls.map((c) => c.cmd), ["npm run build", "git push origin HEAD:beta"]);
  // The first part gone (pruned after 7 days, or it had no step and got no sheet): the sheet as it was.
  const alone = joinCarriedSheet(top, () => null);
  assert.equal(alone, top);
  // A read that throws is a missing part too.
  assert.equal(joinCarriedSheet(top, () => { throw new Error("EACCES"); }), top);
});

test("each link is checked: same session and job, the epoch before (or the same), ended before the next began", () => {
  const top = part("r-1001-0031", [step("git push origin HEAD:beta")], { epoch: 3, carriedFrom: "r-1001-0030", startedAt: "2026-10-01T10:20:00.000Z", endedAt: "2026-10-01T10:21:00.000Z" });
  const ok: Partial<RunSheet> = { epoch: 2, startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:19:00.000Z" };
  const joins = (extra: Partial<RunSheet>) => joinCarriedSheet(top, reader([part("r-1001-0030", [step("npm run build")], { ...ok, ...extra })]).read).joined !== undefined;
  assert.equal(joins({}), true);
  assert.equal(joins({ epoch: 3 }), true, "SessionStart closed the run first: the carried run took the old epoch");
  assert.equal(joins({ session: "0000aaaa1111" }), false, "another session");
  assert.equal(joins({ job: "release" }), false, "another job");
  assert.equal(joins({ epoch: 1 }), false, "two compactions apart");
  assert.equal(joins({ epoch: 4 }), false, "a later epoch");
  assert.equal(joins({ endedAt: "2026-10-01T10:20:30.000Z" }), false, "ended after the next part began");
  assert.equal(joins({ endedAt: "not a date" }), false);
  // A loop of ids never repeats a part.
  const a = part("r-1001-0040", [step("echo a")], { carriedFrom: "r-1001-0041", endedAt: "2026-10-01T10:00:00.000Z" });
  const b = part("r-1001-0041", [step("echo b")], { carriedFrom: "r-1001-0040", startedAt: "2026-10-01T10:05:00.000Z", endedAt: "2026-10-01T10:06:00.000Z" });
  assert.deepEqual(joinCarriedSheet(b, reader([a, b]).read).calls.map((c) => c.cmd), ["echo a", "echo b"]);
});

test("the repo key is the one most joined steps ran in; a tie keeps the newest part's", () => {
  const OTHER = "github.com/acme/storefront";
  const older = part("r-1001-0051", [step("npm run build", { key: OTHER }), step("npm test", { key: OTHER })], { repoKey: OTHER, endedAt: "2026-10-01T10:05:00.000Z" });
  const newer = part("r-1001-0052", [step("git push origin HEAD:beta", { key: SHOP })], { carriedFrom: "r-1001-0051", startedAt: "2026-10-01T10:06:00.000Z", endedAt: "2026-10-01T10:07:00.000Z" });
  assert.equal(joinCarriedSheet(newer, reader([older]).read).repoKey, OTHER);
  const tie = part("r-1001-0051", [step("npm run build", { key: OTHER })], { repoKey: OTHER, endedAt: "2026-10-01T10:05:00.000Z" });
  assert.equal(joinCarriedSheet(newer, reader([tie]).read).repoKey, SHOP);
});

test("the last good run after a compaction is the carried run, its sheet joined with the part before", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-join-"));
  try {
    const env = { ...process.env, TRAIL_HOME: join(dir, ".trail") };
    const meta = { host: "claude", tier: "A" as const, sessionHash: "e76b4ca7f1a0", helpers: [] };
    const cut = runState({
      id: "r-1001-0061", epoch: 0, job: "ship", jobWords: ["push", "beta"], startedAt: "2026-10-01T10:00:00.000Z", lastAt: "2026-10-01T10:04:00.000Z",
      calls: [step("npm run build", { key: SHOP }), step("npm test", { key: SHOP })], stepCalls: 2, commands: 2, end: "open",
    });
    writeRunSheet(cut, checkedSuccess(cut, null), meta, env);
    cut.calls = [];
    const carried = runState({
      id: "r-1001-0062", epoch: 1, job: "ship", jobWords: ["push", "beta"], startedAt: "2026-10-01T10:05:00.000Z", lastAt: "2026-10-01T10:06:00.000Z",
      carriedFrom: "r-1001-0061", closed: false, end: "done", typedCount: 0,
      calls: [step("git push origin HEAD:beta", { key: SHOP, check: pass("push", { branch: "beta" }) })], stepCalls: 1, commands: 1,
    });
    const got = lastGoodRun(emptyState({ epoch: 1, runs: [cut, carried] }), env);
    assert.ok("sheet" in got, JSON.stringify(got));
    assert.equal(got.run.id, "r-1001-0062");
    assert.deepEqual(got.sheet.calls.map((c) => c.cmd), ["npm run build", "npm test", "git push origin HEAD:beta"]);
    assert.deepEqual(got.sheet.joined, [{ id: "r-1001-0061", calls: 2 }]);
    assert.equal(got.sheet.checkIndex, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
