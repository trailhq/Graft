/**
 * 1b's additions to the offer log and budget (design 2.4, 4.20): lines for
 * moments 3 and 4 kept and read back with their moment, init's `closed`
 * lines (recordInitClosed) that count only as "said no" for their key, and
 * the repo an offer belongs to for every key shape.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldOffers, offerBudget, offersPath, readOffers, recordAnswer, recordInitClosed, recordShown } from "../src/skills/offers.js";
import { offerRepo } from "../src/skills/offer-moment.js";
import { readSettings } from "../src/skills/settings.js";
import type { PendingOffer } from "../src/trace/types.js";

const SHOP = "github.com/acme/shop";
const DAY = 86_400_000;
const NOW = new Date("2026-10-27T12:00:00.000Z");
const ago = (days: number, ms = 0) => new Date(NOW.getTime() - days * DAY - ms);
const homes: string[] = [];
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function home(settings: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "b4-offers-"));
  homes.push(dir);
  const env = { HOME: dir, TRAIL_HOME: join(dir, "trail-home") };
  mkdirSync(env.TRAIL_HOME, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: ago(60).toISOString(), ...settings }));
  return env;
}

let seq = 0;
function offer(extra: Partial<PendingOffer> = {}): PendingOffer {
  seq++;
  return {
    offerId: `o-${String(seq).padStart(6, "0")}`, moment: "repeated", runId: `r-1027-${String(seq).padStart(4, "0")}`, name: "ship-x",
    key: `${SHOP}|job:ship`, lines: ["line one", "line two"], channel: "stop", shownAt: null, showMe: false, yes: null, typedAfter: [], ...extra,
  };
}
const repaired = (extra: Partial<PendingOffer> = {}) => offer({ moment: "repaired", key: `${SHOP}|wall:docker-rootless|go`, ...extra });
const corrected = (extra: Partial<PendingOffer> = {}) => offer({ moment: "correction", key: "s-7f3a2c|correction", lines: null, repo: SHOP, ...extra });

test("lines of moments 3 and 4 are written with their moment and read back (1a's reader dropped them)", () => {
  const env = home();
  recordShown(repaired(), SHOP, env, ago(1));
  recordShown(corrected(), SHOP, env, ago(1));
  const lines = readFileSync(offersPath(env), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.moment), ["repaired", "correction"]);
  assert.deepEqual(readOffers(env).map((l) => l.moment), ["repaired", "correction"]);
  assert.deepEqual(lines.map((l) => l.key), [`${SHOP}|wall:docker-rootless|go`, "s-7f3a2c|correction"]);
});

test("they share 1a's budget: the week cap counts every moment", () => {
  const env = home();
  recordShown(offer(), SHOP, env, ago(1));
  recordShown(repaired(), SHOP, env, ago(2));
  recordShown(corrected(), SHOP, env, ago(3));
  const b = offerBudget({ repoKey: SHOP, key: "s-0000aa|correction", sessionOfferUsed: false, now: NOW, env });
  assert.deepEqual(b, { ok: false, why: "week" });
});

test("a no is never asked again for its moment's key", () => {
  const env = home();
  const o = repaired();
  recordShown(o, SHOP, env, ago(20));
  recordAnswer(o, SHOP, "no", env, ago(20, -60_000));
  assert.deepEqual(offerBudget({ repoKey: SHOP, key: o.key, sessionOfferUsed: false, now: NOW, env }), { ok: false, why: "said-no" });
  assert.equal(offerBudget({ repoKey: SHOP, key: `${SHOP}|wall:enospc|go`, sessionOfferUsed: false, now: NOW, env }).ok, true);
});

test("recordInitClosed: a closed line with moment init and answer no, read back; said-no for its key forever", () => {
  const env = home();
  recordInitClosed(SHOP, `${SHOP}|job:report`, env, ago(90));
  const raw = readFileSync(offersPath(env), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].event, "closed");
  assert.equal(raw[0].moment, "init");
  assert.equal(raw[0].answer, "no");
  assert.equal(raw[0].repo, SHOP);
  assert.equal(raw[0].runId, "");
  assert.equal(raw[0].name, "");
  assert.match(raw[0].id, /^o-init-[0-9a-f]{4,}$/);
  assert.equal(readOffers(env).length, 1);
  assert.deepEqual(offerBudget({ repoKey: SHOP, key: `${SHOP}|job:report`, sessionOfferUsed: false, now: NOW, env }), { ok: false, why: "said-no" });
});

test("closed lines never count for the session, the week, the first week, the pause or the governor", () => {
  // Skills turned on yesterday, and init closed 5 items today: none of that is an offer shown.
  const env = home({ onSince: ago(1).toISOString() });
  for (const job of ["report", "sweep", "tests", "ship", "pr-green"]) recordInitClosed(SHOP, `${SHOP}|job:${job}`, env, ago(0, 60_000));
  const b = offerBudget({ repoKey: SHOP, key: `${SHOP}|job:release`, sessionOfferUsed: false, now: NOW, env });
  assert.deepEqual(b, { ok: true, extraDay: false, secondChance: false });
  // A real no now is the first no in this repo: no pause from the closed lines before it.
  const o = offer({ key: `${SHOP}|job:release` });
  recordShown(o, SHOP, env, NOW);
  assert.deepEqual(recordAnswer(o, SHOP, "no", env, new Date(NOW.getTime() + 1000)), { paused: false, firstNo: true });
  assert.deepEqual(readSettings(env).pausedUntil, {});
  assert.deepEqual(readSettings(env).lastNine, ["no"]);
});

test("a closed line is only ever init's: one with another moment or answer is dropped on read", () => {
  const env = home();
  const bad = [
    { id: "o-x1", at: ago(1).toISOString(), event: "closed", repo: SHOP, key: `${SHOP}|job:ship`, moment: "repeated", runId: "", name: "", channel: "stop", answer: "no" },
    { id: "o-x2", at: ago(1).toISOString(), event: "closed", repo: SHOP, key: `${SHOP}|job:ship`, moment: "init", runId: "", name: "", channel: "stop", answer: "yes" },
    { id: "o-x3", at: ago(1).toISOString(), event: "shown", repo: SHOP, key: `${SHOP}|job:ship`, moment: "init", runId: "", name: "", channel: "stop" },
  ];
  mkdirSync(join(env.TRAIL_HOME!), { recursive: true });
  writeFileSync(offersPath(env), `${bad.map((l) => JSON.stringify(l)).join("\n")}\n`);
  assert.deepEqual(readOffers(env), []);
  assert.equal(offerBudget({ repoKey: SHOP, key: `${SHOP}|job:ship`, sessionOfferUsed: false, now: NOW, env }).ok, true);
});

test("foldOffers keeps a closed record closed with its no", () => {
  const env = home();
  recordInitClosed(SHOP, `${SHOP}|job:tests`, env, ago(2));
  const [r] = foldOffers(readOffers(env));
  assert.equal(r!.event, "closed");
  assert.equal(r!.answer, "no");
});

test("offerRepo: the repo of a job key, a wall key, and a correction offer (its repo field)", () => {
  assert.equal(offerRepo({ key: `${SHOP}|job:ship` }), SHOP);
  assert.equal(offerRepo({ key: `${SHOP}|wall:docker-rootless|go` }), SHOP);
  assert.equal(offerRepo({ key: "s-7f3a2c|correction", repo: SHOP }), SHOP);
  assert.equal(offerRepo({ key: "s-7f3a2c|correction" }), "");
});
