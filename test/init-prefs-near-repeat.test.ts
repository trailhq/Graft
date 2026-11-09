/**
 * D135 (2): a short imperative the person typed almost word for word on 3+ days is a preference candidate, shown
 * unticked; the lines 4.4's shape reads (always, never, use, prefer, corrections) keep their tick (D23). Near misses
 * stay out: 2 days, a question, a job ask, a request for now, too few words, too many. Like every
 * preference, it is pointers: no typed text in the candidate. Synthetic lines only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandidates } from "../src/init/candidates.js";
import { isPreferenceShape, minePreferences } from "../src/init/prefs.js";
import type { TypedRef } from "../src/init/types.js";
import type { WallsFile } from "../src/trace/wall-state.js";
import { day, done, SHOP, world } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";
const NOW = new Date(day(20));
const EMPTY_WALLS: WallsFile = { v: 1, read: {}, classes: {} };
let o = 0;
const ref = (): TypedRef => ({ t: "/home/dev/.claude/projects/-home-dev-shop/s.jsonl", o: (o += 100), s: "c".repeat(64) });
const on = (text: string, ...days: number[]) => days.map((d) => ({ ref: ref(), day: day(d).slice(0, 10), at: day(d), text }));

const LINE = "add a changelog entry for each fix";

test("a short imperative typed almost word for word on 3 days is a near-repeat cluster; the shape alone doesn't take it", () => {
  assert.equal(isPreferenceShape(LINE), false, "4.4's shape doesn't read it: the near-repeat path does");
  const found = minePreferences([...on(LINE, 1, 4), ...on("Add a changelog entry for each fix.", 6), ...on("add a changelog entry for each fix please", 9)]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.near, true);
  assert.deepEqual(found[0]!.days, ["2026-09-01", "2026-09-04", "2026-09-06", "2026-09-09"]);
});

test("near misses: 2 days, a question, a job ask, a request for now, too few words, too long, a loose rewording", () => {
  const none = (lines: ReturnType<typeof on>, why: string) => assert.deepEqual(minePreferences(lines), [], why);
  none(on(LINE, 1, 5), "2 days");
  none(on("add a changelog entry for each fix?", 1, 4, 7), "a question");
  none(on("run the test suite", 1, 4, 7), "a job ask");
  none(on("show me what changed since yesterday", 1, 4, 7), "a request for something now");
  none(on("tell me what the build is doing", 1, 4, 7), "aimed at the person");
  none(on("try again", 1, 4, 7), "too few content words");
  none(on("add a changelog entry for each fix and then also update the release page and the docs index and the blog draft", 1, 4, 7), "not short");
  none([...on(LINE, 1), ...on("add a release note for every merged fix", 4), ...on("add an entry to the changelog per bug", 7)], "reworded, not word for word");
});

test("on the screen: the near-repeat is unticked, an always/never line keeps its tick, and both are pointers only", () => {
  const w = world("near");
  try {
    const prefs = minePreferences([...on(LINE, 1, 4, 7), ...on("never force push to main", 2, 6)]);
    const c = buildCandidates({
      jobs: [], walls: EMPTY_WALLS, prefs, howtos: [], reviews: [], repoKey: SHOP, repoWords: new Set(), skills: true,
      closed: new Set(), closedV1: new Set(), kept: new Set(), deferred: new Set(), env: w.env, checkout: w.repo,
    }, NOW);
    const near = c.find((x) => x.nameWords.includes("changelog"))!;
    const never = c.find((x) => x.nameWords.includes("force"))!;
    assert.deepEqual([near.kind, near.typed, near.ticked, near.plainName], ["preference", true, false, ""]);
    assert.deepEqual([never.kind, never.typed, never.ticked], ["preference", true, true]);
    assert.equal(near.pref!.refs.length, 3);
    assert.ok(!JSON.stringify(near.pref).includes("changelog"), "the candidate's pointer holds no typed text");
  } finally {
    done(w);
  }
});
