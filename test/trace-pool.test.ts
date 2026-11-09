/**
 * The pool (design 2.3): per repo, the days a job came back, as session-days
 * (a local date and a session hash) with whether that day cost much. Job
 * words and days only: no prompt text, no commands. A job is offered as a
 * skill on its 3rd session-day in 45 days (4th under the governor), at least
 * 2 of them costly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { notePoolDay, poolPath, readPool, repeatedEnough, watching, type PoolEntry } from "../src/trace/pool.js";
import { repoPlace } from "../src/notes/home.js";
import { withLock } from "../src/util/private-fs.js";

function home(): NodeJS.ProcessEnv {
  return { ...process.env, TRAIL_HOME: join(mkdtempSync(join(tmpdir(), "trace-pool-")), ".trail") };
}
const KEY = "github.com/acme/storefront";
const NOW = new Date(2026, 9, 30, 15, 0); // local Oct 30
const ship = { job: "ship" as const, words: ["push", "beta"] };

test("the pool sits in the repo's own folder under ~/.trail, beside phase 0's", () => {
  const env = home();
  assert.equal(poolPath(KEY, env), join(env.TRAIL_HOME!, "repos", "github.com", "acme", "storefront", "pool.json"));
  const local = mkdtempSync(join(tmpdir(), "trace-pool-repo-"));
  const place = repoPlace(local, env);
  assert.equal(dirname(poolPath(place.key, env)), place.dir);
  assert.deepEqual(readPool(KEY, env), { v: 1, jobs: {} });
  mkdirSync(dirname(poolPath(KEY, env)), { recursive: true });
  writeFileSync(poolPath(KEY, env), "{bad");
  assert.deepEqual(readPool(KEY, env), { v: 1, jobs: {} });
});

test("a session-day is noted once; costly is OR-ed; words merge; the good run is kept", () => {
  const env = home();
  notePoolDay(KEY, ship, { d: "2026-10-28", s: "aaaaaaaaaaaa", costly: false }, null, env, NOW);
  notePoolDay(KEY, { job: "ship", words: ["push", "prod", "ff"] }, { d: "2026-10-28", s: "aaaaaaaaaaaa", costly: true }, "r-1028-0001", env, NOW);
  const e = notePoolDay(KEY, ship, { d: "2026-10-28", s: "aaaaaaaaaaaa", costly: false }, null, env, NOW)!;
  assert.deepEqual(e.days, [{ d: "2026-10-28", s: "aaaaaaaaaaaa", costly: true }]);
  assert.deepEqual(e.words, ["push", "beta", "prod", "ff"]);
  assert.equal(e.lastGoodRun, "r-1028-0001");
  assert.equal(e.lastSeen, "2026-10-28");
  assert.equal(e.shownAtInit, false);
  const disk = JSON.parse(readFileSync(poolPath(KEY, env), "utf8"));
  assert.deepEqual(disk.jobs.ship, e);
  if (process.platform !== "win32") assert.equal(statSync(poolPath(KEY, env)).mode & 0o777, 0o600);
  if (process.platform !== "win32") assert.equal(statSync(dirname(poolPath(KEY, env))).mode & 0o777, 0o700);
  assert.ok(!/prompt|typed/.test(readFileSync(poolPath(KEY, env), "utf8")));
});

test("only jobs with a moment-2 family are counted; words stop at 12", () => {
  const env = home();
  assert.equal(notePoolDay(KEY, { job: "pr-green", words: ["ci"] }, { d: "2026-10-28", s: "a", costly: true }, null, env, NOW), null);
  assert.equal(notePoolDay(KEY, { job: "run-local", words: ["open"] }, { d: "2026-10-28", s: "a", costly: true }, null, env, NOW), null);
  assert.deepEqual(readPool(KEY, env).jobs, {});
  const many = Array.from({ length: 20 }, (_, i) => `w${i}`);
  assert.equal(notePoolDay(KEY, { job: "release", words: many }, { d: "2026-10-28", s: "a", costly: true }, null, env, NOW)!.words.length, 12);
});

test("days older than 45 go on every write, and so does a job unseen for 45 days", () => {
  const env = home();
  mkdirSync(dirname(poolPath(KEY, env)), { recursive: true });
  writeFileSync(poolPath(KEY, env), JSON.stringify({ v: 1, jobs: {
    ship: { words: ["push"], days: [{ d: "2026-09-10", s: "a", costly: true }, { d: "2026-09-15", s: "e", costly: true }, { d: "2026-09-16", s: "b", costly: true }], lastGoodRun: null, lastSeen: "2026-09-16", shownAtInit: false },
    report: { words: ["new"], days: [{ d: "2026-09-01", s: "c", costly: true }], lastGoodRun: null, lastSeen: "2026-09-01", shownAtInit: true },
  }, extra: "kept" }));
  notePoolDay(KEY, ship, { d: "2026-10-30", s: "d", costly: false }, null, env, NOW);
  const pool = readPool(KEY, env);
  assert.deepEqual(pool.jobs.ship!.days.map((x) => x.d), ["2026-09-16", "2026-10-30"], "Sep 16 is the 45th day counting today; Sep 15 the 46th");
  assert.equal(pool.jobs.report, undefined);
});

test("a timed-out lock writes nothing and says so", () => {
  const env = home();
  const path = poolPath(KEY, env);
  mkdirSync(dirname(path), { recursive: true });
  const inner = withLock(path, () => notePoolDay(KEY, ship, { d: "2026-10-30", s: "a", costly: true }, null, env, NOW), 50);
  assert.ok(inner.ok);
  assert.equal(inner.value, null);
  assert.deepEqual(readPool(KEY, env).jobs, {});
});

const entry = (days: Array<[string, string, boolean]>): PoolEntry => ({
  words: [], days: days.map(([d, s, costly]) => ({ d, s, costly })), lastGoodRun: null, lastSeen: days.at(-1)?.[0] ?? "", shownAtInit: false,
});

test("repeated enough: the 3rd session-day in 45 days, 2 of them costly; the 4th under the governor", () => {
  const three = entry([["2026-10-20", "a", true], ["2026-10-25", "b", false], ["2026-10-30", "c", true]]);
  assert.deepEqual(repeatedEnough(three, false, NOW), { ok: true, sessionDays: 3, dates: 3, costlyDays: 2, need: 3 });
  assert.equal(repeatedEnough(three, true, NOW).ok, false);
  assert.equal(repeatedEnough(three, true, NOW).need, 4);
  const cheap = entry([["2026-10-20", "a", true], ["2026-10-25", "b", false], ["2026-10-30", "c", false]]);
  assert.equal(repeatedEnough(cheap, false, NOW).ok, false, "only one costly day");
  const sameDay = entry([["2026-10-30", "a", true], ["2026-10-30", "b", true], ["2026-10-30", "c", false]]);
  assert.deepEqual(repeatedEnough(sameDay, false, NOW), { ok: true, sessionDays: 3, dates: 1, costlyDays: 2, need: 3 });
  const stale = entry([["2026-09-15", "a", true], ["2026-10-25", "b", true], ["2026-10-30", "c", true]]);
  assert.equal(repeatedEnough(stale, false, NOW).sessionDays, 2);
  assert.equal(repeatedEnough(entry([["2026-09-16", "a", true], ["2026-10-25", "b", true], ["2026-10-30", "c", true]]), false, NOW).ok, true);
});

test("watching: every job counted in 45 days, every repo, with the days it needs", () => {
  const env = home();
  notePoolDay(KEY, ship, { d: "2026-10-28", s: "a", costly: true }, null, env, NOW);
  notePoolDay(KEY, ship, { d: "2026-10-29", s: "b", costly: false }, null, env, NOW);
  notePoolDay("github.com/acme/shop", { job: "tests", words: ["tests"] }, { d: "2026-10-30", s: "c", costly: true }, null, env, NOW);
  notePoolDay("local/home/dev/scratch-app", { job: "report", words: ["new"] }, { d: "2026-10-30", s: "c", costly: true }, null, env, NOW);
  const w = watching(env, NOW).sort((a, b) => a.repoKey.localeCompare(b.repoKey));
  assert.deepEqual(w, [
    { repoKey: "github.com/acme/shop", job: "tests", sessionDays: 1, costlyDays: 1, need: 3 },
    { repoKey: "github.com/acme/storefront", job: "ship", sessionDays: 2, costlyDays: 1, need: 3 },
    { repoKey: "local/home/dev/scratch-app", job: "report", sessionDays: 1, costlyDays: 1, need: 3 },
  ]);
  // Under the governor (fewer than 1 in 3 offers kept lately), a job needs a 4th day.
  writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "on", lastNine: ["no", "none", "no"] }));
  assert.ok(watching(env, NOW).every((x) => x.need === 4));
  assert.deepEqual(watching(home(), NOW), []);
});
