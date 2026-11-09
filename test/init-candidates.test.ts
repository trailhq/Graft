/**
 * Init's candidates (design 4.5, b5): skills held to moment 2's bar and
 * compiled by 1a's compile from past checked runs, guardrails from walls
 * seen on 2+ days and still true, typed preferences, and the five the
 * screen shows. Synthetic transcripts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { buildCandidates, candidateId, pickFive, seedNeverShown } from "../src/init/candidates.js";
import { mineJobs, type JobFind } from "../src/init/miners.js";
import { minePreferences } from "../src/init/prefs.js";
import { replaySession } from "../src/init/replay-runs.js";
import type { InitCandidate, TypedRef } from "../src/init/types.js";
import { norm } from "../src/init/look-back.js";
import { readPool, poolPath } from "../src/trace/pool.js";
import type { WallsFile } from "../src/trace/wall-state.js";
import { day, done, releaseJob, SHOP, testsJob, Tx, world, type World } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";
const NOW = new Date(day(20));

function jobsOf(w: World, txs: Tx[]): JobFind[] {
  return mineJobs(txs.map((tx, i) => {
    const p = tx.write(w.home, `sess-${i}`);
    return replaySession(p, { from: 0, to: statSync(p).size }, SHOP, NOW, { env: w.env });
  }));
}

const EMPTY_WALLS: WallsFile = { v: 1, read: {}, classes: {} };
function base(w: World, extra: Partial<Parameters<typeof buildCandidates>[0]> = {}): Parameters<typeof buildCandidates>[0] {
  return {
    jobs: [], walls: EMPTY_WALLS, prefs: [], howtos: [], reviews: [], repoKey: SHOP, repoWords: new Set(["pnpm", "lint"]), skills: true,
    closed: new Set(), closedV1: new Set(), kept: new Set(), deferred: new Set(), env: w.env, checkout: w.repo, ...extra,
  };
}

/** Three release days, two of them costly. */
function threeReleases(w: World): Tx {
  const tx = new Tx(w.repo);
  releaseJob(tx, 1, "1.0.1", { failedFirst: true });
  releaseJob(tx, 3, "1.0.3", { failedFirst: true });
  releaseJob(tx, 5, "1.0.5");
  return tx;
}

test("a job on 3 days with 2 costly compiles from the newest good run into a skill item", () => {
  const w = world("skill");
  try {
    const jobs = jobsOf(w, [threeReleases(w)]);
    const c = buildCandidates(base(w, { jobs }), NOW);
    const skills = c.filter((x) => x.kind === "skill");
    assert.equal(skills.length, 1);
    const s = skills[0]!;
    assert.equal(s.id, candidateId("skill", `${SHOP}|job:release`));
    assert.match(s.id, /^i-[0-9a-f]{10}$/);
    assert.equal(s.key, `${SHOP}|job:release`);
    assert.equal(s.plainName, s.skill!.compiled.name);
    assert.deepEqual(s.nameWords, [s.plainName]);
    assert.deepEqual(s.count, { days: 3, from: "2026-09-01", to: "2026-09-05", costly: 2 });
    assert.deepEqual([s.scope, s.applies, s.typed, s.ticked], ["personal", SHOP, false, false]);
    assert.equal(s.skill!.compiled.source.at.slice(0, 10), "2026-09-05", "the newest good run");
    assert.match(s.skill!.src.skillSha, /^[0-9a-f]{64}$/);
    assert.ok(s.skill!.src.prior, "with its prior");
  } finally {
    done(w);
  }
});

test("falls back to the next good run when the newest doesn't compile; 2 days give no item; skills off gives none", () => {
  const w = world("fallback");
  try {
    const jobs = jobsOf(w, [threeReleases(w)]);
    const rel = jobs.find((j) => j.job === "release")!;
    // The newest run's publish held a secret it couldn't name: compile refuses that sheet.
    const bad = structuredClone(rel.good[0]!);
    bad.sheet.calls = bad.sheet.calls.map((x) => (x.cmd?.startsWith("npm publish") ? { ...x, cmd: null, secret: "refused" as const } : x));
    const skipped: Array<{ job: string; why: string; days?: number }> = [];
    const c = buildCandidates(base(w, { jobs: [{ ...rel, good: [bad, ...rel.good.slice(1)] }], skipped }), NOW);
    const s = c.find((x) => x.kind === "skill")!;
    assert.equal(s.skill!.compiled.source.at.slice(0, 10), "2026-09-03");
    // None compiles: no item, and the reason is said.
    const none = buildCandidates(base(w, { jobs: [{ ...rel, good: [bad] }], skipped }), NOW);
    assert.equal(none.some((x) => x.kind === "skill"), false);
    assert.deepEqual(skipped, [{ job: "release", why: "secret", days: 3 }]);

    const two = jobsOf(w, [(() => { const tx = new Tx(w.repo); releaseJob(tx, 1, "1.0.1", { failedFirst: true }); releaseJob(tx, 3, "1.0.3", { failedFirst: true }); return tx; })()]);
    assert.equal(buildCandidates(base(w, { jobs: two }), NOW).length, 0);
    const oneCostly = jobsOf(w, [(() => { const tx = new Tx(w.repo); releaseJob(tx, 1, "1.0.1", { failedFirst: true }); releaseJob(tx, 3, "1.0.3"); releaseJob(tx, 5, "1.0.5"); return tx; })()]);
    assert.equal(oneCostly.find((j) => j.job === "release")!.days.length, 3);
    assert.equal(buildCandidates(base(w, { jobs: oneCostly }), NOW).length, 0, "3 days, 1 costly");
    assert.equal(buildCandidates(base(w, { jobs, skills: false }), NOW).length, 0);
  } finally {
    done(w);
  }
});

test("closed, kept and deferred items give nothing", () => {
  const w = world("closed");
  try {
    const jobs = jobsOf(w, [threeReleases(w)]);
    const id = candidateId("skill", `${SHOP}|job:release`);
    for (const k of ["closed", "kept", "deferred"] as const) {
      assert.equal(buildCandidates(base(w, { jobs, [k]: new Set([id]) }), NOW).length, 0, k);
    }
  } finally {
    done(w);
  }
});

const walls = (cls: string, days: string[]): WallsFile => ({
  v: 1, read: {}, classes: { [cls]: { seen: days.map((d, i) => ({ d, sh: `9f2c1a0b77e${i}`, epoch: 0, repo: SHOP, program: "timeout" })), fixed: [], lessons: {} } },
});

test("a guardrail for a wall seen on 2+ days that is still true; no-timeout holds in every repo", () => {
  const w = world("guard");
  try {
    const two = walls("timeout-missing", ["2026-09-02", "2026-09-06"]);
    const c = buildCandidates(base(w, { walls: two, machine: { timeoutMissing: true, httpsNoHelper: false } }), NOW);
    assert.equal(c.length, 1);
    const g = c[0]!;
    assert.deepEqual([g.kind, g.key, g.plainName, g.applies, g.ticked, g.typed], ["guardrail", "wall:timeout-missing", "no-timeout", "every repo", false, false]);
    assert.deepEqual(g.guardrail, { cls: "timeout-missing", check: "no-timeout" });
    assert.deepEqual(g.count, { days: 2, from: "2026-09-02", to: "2026-09-06" });
    assert.equal(buildCandidates(base(w, { walls: walls("timeout-missing", ["2026-09-02"]), machine: { timeoutMissing: true, httpsNoHelper: false } }), NOW).length, 0, "one day");
    assert.equal(buildCandidates(base(w, { walls: two, machine: { timeoutMissing: false, httpsNoHelper: false } }), NOW).length, 0, "timeout is here now");
    const https = buildCandidates(base(w, { walls: walls("git-https-auth", ["2026-09-02", "2026-09-03"]), machine: { timeoutMissing: false, httpsNoHelper: true } }), NOW);
    assert.deepEqual(https.map((x) => [x.plainName, x.applies]), [["push-over-ssh", SHOP]]);
  } finally {
    done(w);
  }
});

let o = 0;
const ref = (): TypedRef => ({ t: "/home/dev/.claude/projects/-home-dev-shop/s.jsonl", o: (o += 100), s: "b".repeat(64) });
const line = (text: string, at: string) => ({ ref: ref(), day: at.slice(0, 10), at, text });

test("typed preferences start ticked, apply where they name the repo, and drop when a how-to, a learning or a phase 0 no already has them", () => {
  const w = world("prefs");
  try {
    const prefs = minePreferences([
      line("use pnpm here", "2026-09-01T10:00:00Z"), line("use pnpm here please", "2026-09-04T10:00:00Z"),
      line("explain it simply, one example first", "2026-09-02T10:00:00Z"), line("explain it simply with one example first", "2026-09-06T10:00:00Z"),
    ]);
    // D102: "explain it simply, one example first" is a style preference, and style applies in every repo.
    assert.equal(prefs.length, 2);
    const c = buildCandidates(base(w, { prefs }), NOW);
    assert.equal(c.length, 2);
    const p = c.find((x) => x.nameWords.includes("pnpm"))!;
    assert.deepEqual([p.kind, p.plainName, p.typed, p.ticked, p.applies, p.scope], ["preference", "", true, true, SHOP, "personal"]);
    assert.deepEqual(p.nameWords, ["use", "pnpm"]);
    const mine = prefs.find((x) => x.shortest.includes("pnpm"))!;
    assert.equal(p.key, `pref:${mine.sha}`);
    assert.equal(p.pref!.refs[0], mine.refs[0]);
    assert.deepEqual(p.count, { days: 2, from: "2026-09-01", to: "2026-09-04" });
    const style = c.find((x) => x !== p)!;
    assert.deepEqual([style.kind, style.applies, style.ticked], ["preference", "every repo", true]);

    const every = minePreferences([line("never use em dashes", "2026-09-01T10:00:00Z"), line("never use em dashes!", "2026-09-05T10:00:00Z")]);
    assert.equal(buildCandidates(base(w, { prefs: every }), NOW)[0]!.applies, "every repo");
    assert.equal(buildCandidates(base(w, { prefs: every, howtos: [{ file: "style.md", text: "- Never use em dashes." }] }), NOW).length, 0, "a how-to says it");
    assert.equal(buildCandidates(base(w, { prefs: every, learnings: ["Never use em dashes in copy"] }), NOW).length, 0, "a kept learning says it");
    const v1 = createHash("sha1").update(norm("never use em dashes!")).digest("hex").slice(0, 16);
    assert.equal(buildCandidates(base(w, { prefs: every, closedV1: new Set([v1]) }), NOW).length, 0, "phase 0 closed one of its lines");
  } finally {
    done(w);
  }
});

test("a how-to that describes a job is evidence and moves it up one place", () => {
  const w = world("howto");
  try {
    const tx = threeReleases(w);
    // Tests on 4 days, 2 costly: ranked above release until a how-to describes release.
    testsJob(tx, 7, { failedFirst: true });
    testsJob(tx, 8, { failedFirst: true });
    testsJob(tx, 9);
    testsJob(tx, 10);
    const jobs = jobsOf(w, [tx]);
    const plain = buildCandidates(base(w, { jobs }), NOW).filter((x) => x.kind === "skill");
    assert.deepEqual(plain.map((x) => x.key.split(":").pop()), ["tests", "release"]);
    const h = [{ file: "npm-publish-flow.md", text: "To release, run npm publish then npm view." }];
    const boosted = buildCandidates(base(w, { jobs, howtos: h }), NOW).filter((x) => x.kind === "skill");
    assert.deepEqual(boosted.map((x) => x.key.split(":").pop()), ["release", "tests"]);
    assert.deepEqual(boosted[0]!.evidence, ["your Claude Code how-to npm-publish-flow.md describes it"]);
    assert.deepEqual(boosted.map((x) => x.rank), [1, 2]);
  } finally {
    done(w);
  }
});

const fake = (kind: InitCandidate["kind"], n: number): InitCandidate => ({
  id: `i-${kind.slice(0, 2)}${String(n).padStart(8, "0")}`, kind, key: `${kind}:${n}`, plainName: `${kind}-${n}`, nameWords: [], count: { days: 3, from: "", to: "" },
  scope: "personal", applies: SHOP, typed: kind === "preference", ticked: kind === "preference", evidence: [], rank: n,
});

test("pickFive: skill, guardrail, preference, skill, guardrail, preference, review, then by rank; at most 5", () => {
  const all = [fake("skill", 1), fake("skill", 2), fake("skill", 3), fake("guardrail", 1), fake("preference", 1), fake("preference", 2), fake("review", 1)];
  assert.deepEqual(pickFive(all).map((x) => x.plainName), ["skill-1", "guardrail-1", "preference-1", "skill-2", "preference-2"]);
  assert.deepEqual(pickFive([fake("review", 1), fake("skill", 1)]).map((x) => x.plainName), ["skill-1", "review-1"]);
  assert.deepEqual(pickFive([fake("skill", 1), fake("skill", 2), fake("skill", 3), fake("skill", 4), fake("skill", 5), fake("skill", 6)]).length, 5);
});

test("never-shown skills seed their session-days of the last 45 days into the pool; shown ones seed nothing", () => {
  const w = world("seed");
  try {
    const tx = new Tx(w.repo);
    // Release days long ago and recent; tests days recent.
    releaseJob(tx, 1, "1.0.1", { failedFirst: true });
    releaseJob(tx, 3, "1.0.3", { failedFirst: true });
    releaseJob(tx, 5, "1.0.5");
    testsJob(tx, 6, { failedFirst: true });
    testsJob(tx, 7, { failedFirst: true });
    testsJob(tx, 8);
    const jobs = jobsOf(w, [tx]);
    const c = buildCandidates(base(w, { jobs }), NOW);
    const shown = c.filter((x) => x.key.endsWith("job:tests"));
    // 45 days back from Oct 20 is Sep 6: release's days (1, 3, 5) are older.
    const later = new Date(Date.UTC(2026, 9, 20, 10));
    seedNeverShown(jobs, c, shown, SHOP, w.env, later);
    assert.equal(existsSync(poolPath(SHOP, w.env)), false, "release's days are all older than 45 days; tests was shown");
    seedNeverShown(jobs, c, [], SHOP, w.env, new Date(day(20)));
    const pool = readPool(SHOP, w.env).jobs;
    assert.deepEqual(pool.release!.days.map((d) => [d.d, d.costly]), [["2026-09-01", true], ["2026-09-03", true], ["2026-09-05", false]]);
    assert.equal(pool.release!.lastGoodRun, null);
    assert.equal(pool.tests!.days.length, 3);
  } finally {
    done(w);
  }
});
