/**
 * The offer log and the budget every offer shares (design 2.5, 4.13, spec 9):
 * at most 1 offer per session, 3 a week, 1 in the first week after skills go
 * on; a no is never asked again for that (repo, job); two nos in a row in a
 * repo pause it 14 days, said once; an ignored offer gets one more chance 14+
 * days later, then never; when fewer than 1 in 3 of the last 9 offers were
 * kept, a job must come back one more day first.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foldOffers, governorLine, newOfferId, offerBudget, offersPath, readOffers, recordAnswer, recordNotShown, recordShown,
} from "../src/skills/offers.js";
import { readSettings } from "../src/skills/settings.js";
import type { PendingOffer } from "../src/trace/types.js";
import type { Answer } from "../src/skills/types.js";

const SHOP = "github.com/acme/shop";
const WEBSHOP = "github.com/acme/webshop";
const DAY = 86_400_000;
const NOW = new Date("2026-10-27T12:00:00.000Z");
const ago = (days: number, ms = 0) => new Date(NOW.getTime() - days * DAY - ms);

function home(settings: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "skills-offers-"));
  const env = { HOME: dir, TRAIL_HOME: join(dir, "trail-home") };
  mkdirSync(env.TRAIL_HOME, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: ago(60).toISOString(), ...settings }));
  return env;
}

let seq = 0;
function offer(repo = SHOP, job = "ship", extra: Partial<PendingOffer> = {}): PendingOffer {
  seq++;
  return {
    offerId: `o-${String(seq).padStart(6, "0")}`, moment: "repeated", runId: `r-1027-${String(seq).padStart(4, "0")}`, name: `${job}-x`,
    key: `${repo}|job:${job}`, lines: ["line one", "line two"], channel: "stop", shownAt: null, showMe: false, yes: null, typedAfter: [], ...extra,
  };
}

/** An offer shown `days` ago and answered `a` a minute later (null: never answered). */
function past(env: NodeJS.ProcessEnv, days: number, a: Answer | null, repo = SHOP, job = "ship"): PendingOffer {
  const o = offer(repo, job);
  recordShown(o, repo, env, ago(days));
  if (a) recordAnswer(o, repo, a, env, ago(days, -60_000));
  return o;
}

const budget = (env: NodeJS.ProcessEnv, extra: { repo?: string; job?: string; used?: boolean; now?: Date } = {}) => {
  const repo = extra.repo ?? SHOP;
  return offerBudget({ repoKey: repo, key: `${repo}|job:${extra.job ?? "ship"}`, sessionOfferUsed: extra.used ?? false, now: extra.now ?? NOW, env });
};

test("the log: one line per event, 0600, folded to one record per offer with its last answer", { skip: process.platform === "win32" && "posix modes" }, () => {
  const env = home();
  const a = offer();
  recordShown(a, SHOP, env, ago(1));
  recordAnswer(a, SHOP, "show", env, ago(1, -60_000));
  recordAnswer(a, SHOP, "yes", env, ago(1, -120_000));
  const b = offer(WEBSHOP, "report");
  recordShown(b, WEBSHOP, env, ago(0, 600_000));
  recordNotShown(b, WEBSHOP, env, ago(0, 300_000));
  const lines = readFileSync(offersPath(env), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], {
    id: a.offerId, at: ago(1).toISOString(), event: "shown", repo: SHOP, key: `${SHOP}|job:ship`, moment: "repeated", runId: a.runId, name: a.name, channel: "stop",
  });
  assert.deepEqual(lines[2], { ...lines[0], at: ago(1, -120_000).toISOString(), event: "answer", answer: "yes" });
  if (process.platform !== "win32") assert.equal(statSync(offersPath(env)).mode & 0o777, 0o600); // no POSIX modes on Windows
  assert.equal(readOffers(env).length, 5);
  const folded = foldOffers(readOffers(env));
  assert.deepEqual(folded.map((r) => [r.id, r.event, r.at, r.answer]), [
    [a.offerId, "shown", ago(1).toISOString(), "yes"],
    [b.offerId, "not-shown", ago(0, 600_000).toISOString(), null],
  ]);
  writeFileSync(offersPath(env), readFileSync(offersPath(env), "utf8") + "{oops\n[]\n");
  assert.equal(readOffers(env).length, 5, "bad lines are skipped");
  assert.match(newOfferId(), /^o-[0-9a-f]{6}$/);
});

test("budget: offers off, off here, and a paused repo come first", () => {
  assert.deepEqual(budget(home({ offers: "off" }), { used: true }), { ok: false, why: "off" });
  assert.deepEqual(budget(home({ offRepos: [SHOP] }), { used: true }), { ok: false, why: "off-here" });
  assert.deepEqual(budget(home({ offRepos: [WEBSHOP] })), { ok: true, extraDay: false, secondChance: false });
  assert.deepEqual(budget(home({ pausedUntil: { [SHOP]: "2026-10-28" } }), { used: true }), { ok: false, why: "paused" });
  assert.deepEqual(budget(home({ pausedUntil: { [SHOP]: "2026-10-27" } })), { ok: true, extraDay: false, secondChance: false }, "the pause ends on its date");
});

test("budget: 1 per session (an asked save or the install line spends it too)", () => {
  assert.deepEqual(budget(home(), { used: true }), { ok: false, why: "session" });
});

test("budget: 1 offer in the first 7 days after skills go on", () => {
  const env = home({ onSince: ago(2).toISOString() });
  assert.equal(budget(env).ok, true);
  past(env, 1, "yes", WEBSHOP);
  assert.deepEqual(budget(env), { ok: false, why: "first-week" });
  const before = home({ onSince: ago(2).toISOString() });
  past(before, 3, "yes", WEBSHOP); // shown before skills last went on: not this first week's
  assert.equal(budget(before).ok, true);
  const week2 = home({ onSince: ago(8).toISOString() });
  past(week2, 1, "yes", WEBSHOP);
  assert.equal(budget(week2).ok, true, "after 7 days the weekly cap is the only one");
});

test("budget: 3 shown in the last 7 days (rolling) is the week's; an offer the agent left out doesn't count", () => {
  const env = home();
  past(env, 1, "yes", WEBSHOP, "release");
  past(env, 3, "yes", WEBSHOP, "report");
  assert.equal(budget(env).ok, true);
  const left = offer(WEBSHOP, "tests");
  recordShown(left, WEBSHOP, env, ago(2));
  recordNotShown(left, WEBSHOP, env, ago(2, -1000));
  assert.equal(budget(env).ok, true, "not-shown keeps the session spent and nothing else");
  past(env, 6, "none", WEBSHOP, "tests");
  assert.deepEqual(budget(env), { ok: false, why: "week" });
  assert.equal(budget(env, { now: new Date(NOW.getTime() + DAY + 1) }).ok, true, "a day later the oldest is 7 days old");
});

test("budget: a no is never asked again for that repo and job", () => {
  const env = home();
  past(env, 200, "no");
  assert.deepEqual(budget(env), { ok: false, why: "said-no" });
  assert.equal(budget(env, { job: "release" }).ok, true);
  assert.equal(budget(env, { repo: WEBSHOP }).ok, true);
});

test("budget: an ignored offer gets one more chance 14+ days later, then never", () => {
  const env = home();
  past(env, 5, "none");
  assert.deepEqual(budget(env), { ok: false, why: "too-soon" });
  assert.deepEqual(budget(env, { now: new Date(NOW.getTime() + 9 * DAY) }), { ok: true, extraDay: false, secondChance: true });
  past(env, 1, "none");
  assert.deepEqual(budget(env), { ok: false, why: "no-answer-twice" });
  assert.deepEqual(budget(env, { now: new Date(NOW.getTime() + 300 * DAY) }), { ok: false, why: "no-answer-twice" });
});

test("budget: shown and never answered counts as ignored after 24 h; withdrawn and show count as neither", () => {
  const fresh = home();
  past(fresh, 0.5, null);
  assert.equal(budget(fresh).ok, true, "under 24 h it may still be answered");
  const old = home();
  past(old, 2, null);
  assert.deepEqual(budget(old), { ok: false, why: "too-soon" });
  const neither = home();
  past(neither, 2, "withdrawn");
  past(neither, 3, "show");
  assert.deepEqual(budget(neither), { ok: true, extraDay: false, secondChance: false });
});

test("budget: the governor wants one more day when fewer than 1 in 3 of the last 9 answers were yes", () => {
  const env = home();
  for (const [d, a] of [[40, "no"], [38, "none"], [36, "no"]] as const) past(env, d, a, WEBSHOP, `job${d}`);
  assert.deepEqual(budget(env), { ok: true, extraDay: true, secondChance: false });
  past(env, 30, "yes", WEBSHOP, "release");
  assert.deepEqual(budget(env), { ok: true, extraDay: true, secondChance: false }, "1 yes in 4: 3 < 4");
  past(env, 29, "yes", WEBSHOP, "report");
  assert.deepEqual(budget(env), { ok: true, extraDay: false, secondChance: false }, "2 yes in 5: 6 < 5 is false");
  const few = home();
  past(few, 40, "no", WEBSHOP, "a");
  past(few, 38, "none", WEBSHOP, "b");
  assert.deepEqual(budget(few), { ok: true, extraDay: false, secondChance: false }, "fewer than 3 answers: no governor");
  const nine = home();
  for (let i = 0; i < 9; i++) past(nine, 60 - i, "yes", WEBSHOP, `y${i}`);
  for (let i = 0; i < 9; i++) past(nine, 40 - i, "none", WEBSHOP, `n${i}`);
  assert.deepEqual(budget(nine), { ok: true, extraDay: true, secondChance: false }, "only the last 9 count");
});

test("the 2nd no in a row in a repo pauses it for 14 days, said once; the first no a person ever gives is marked", () => {
  const env = home();
  const first = recordAnswer(past(env, 30, null), SHOP, "no", env, ago(30, -60_000));
  assert.deepEqual(first, { paused: false, firstNo: true });
  const yes = past(env, 20, null, SHOP, "report");
  recordAnswer(yes, SHOP, "yes", env, ago(20, -60_000));
  const again = recordAnswer(past(env, 10, null, SHOP, "release"), SHOP, "no", env, ago(10, -60_000));
  assert.deepEqual(again, { paused: false, firstNo: false }, "a yes in between: not two in a row");
  const otherRepo = recordAnswer(past(env, 5, null, WEBSHOP, "ship"), WEBSHOP, "no", env, ago(5, -60_000));
  assert.deepEqual(otherRepo, { paused: false, firstNo: false }, "another repo's no is not this repo's");
  const second = recordAnswer(past(env, 0, null, SHOP, "tests"), SHOP, "no", env, NOW);
  assert.deepEqual(second, { paused: true, firstNo: false });
  assert.equal(readSettings(env).pausedUntil[SHOP], "2026-11-10");
  assert.deepEqual(budget(env, { job: "sweep" }), { ok: false, why: "paused" });
  assert.equal(budget(env, { job: "sweep", now: new Date("2026-11-10T09:00:00Z") }).ok, true, "quiet for 14 days, then offers again");
});

test("recordAnswer keeps the governor cache: lastNine refreshed, governorSaidAt cleared when it turns off", () => {
  const env = home();
  for (const [d, a] of [[40, "no"], [38, "none"], [36, "no"]] as const) past(env, d, a, WEBSHOP, `job${d}`);
  assert.deepEqual(readSettings(env).lastNine, ["no", "none", "no"]);
  assert.ok(governorLine(env, NOW));
  past(env, 30, "yes", WEBSHOP, "release");
  assert.equal(readSettings(env).governorSaidAt, NOW.toISOString(), "still on (1 yes in 4): the line stays said");
  past(env, 29, "yes", WEBSHOP, "report");
  assert.deepEqual(readSettings(env).lastNine, ["no", "none", "no", "yes", "yes"]);
  assert.equal(readSettings(env).governorSaidAt, null, "off now: it will be said again when it comes back");
  for (let i = 0; i < 12; i++) past(env, 20 - i, "none", WEBSHOP, `n${i}`);
  assert.equal(readSettings(env).lastNine.length, 9);
  // An offer shown and never answered becomes "none" in the window once it is a day old.
  const quiet = home();
  past(quiet, 3, null, WEBSHOP, "a");
  past(quiet, 2, null, WEBSHOP, "b");
  past(quiet, 1.5, null, WEBSHOP, "c");
  assert.deepEqual(readSettings(quiet).lastNine, ["none"], "refreshed at each showing, as of that time (b was not a day old yet)");
  assert.ok(governorLine(quiet, NOW), "read from the log at the time asked");
});

test("the governor line is said once while the governor is on, and again after it turns off and on", () => {
  const env = home();
  assert.equal(governorLine(env, NOW), null);
  for (const [d, a] of [[40, "no"], [38, "none"], [36, "no"]] as const) past(env, d, a, WEBSHOP, `job${d}`);
  assert.equal(governorLine(env, NOW), "you kept fewer than 1 in 3 offers lately, so a job now has to come back a 4th day before Trail offers it");
  assert.equal(readSettings(env).governorSaidAt, NOW.toISOString());
  assert.equal(governorLine(env, NOW), null, "said once");
  past(env, 30, "yes", WEBSHOP, "a");
  past(env, 29, "yes", WEBSHOP, "b");
  assert.equal(governorLine(env, NOW), null, "off");
  for (const d of [20, 19, 18, 17, 16, 15]) past(env, d, "no", WEBSHOP, `c${d}`);
  assert.match(governorLine(env, NOW) ?? "", /^you kept fewer than 1 in 3 offers lately/, "on again: said again");
});
