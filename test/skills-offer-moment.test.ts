/**
 * Moment 2 and the answers to it (design 3.2 steps 4 and 6.4, 3.5 step 10,
 * 4.12): an offer is due only when all six conditions hold, its two lines
 * are counted from the run; the first typed prompt after it answers it, and
 * only `captureAnswer` records a yes; a save request records the person's
 * line whichever of the hook and the transcript comes first.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureAnswer, noteSaveRequest, offerDue, offerEndsReply, offerRepo, skillSha } from "../src/skills/offer-moment.js";
import type { CompiledSkill } from "../src/skills/types.js";
import { foldOffers, readOffers } from "../src/skills/offers.js";
import { typedSha } from "../src/trace/typed.js";
import { currentRun, withSkillSession } from "../src/trace/skill-session.js";
import { checkedSuccess, writeRunSheet } from "../src/trace/runs.js";
import { emptyState } from "./trace-run-fixtures.js";
import type { PendingOffer } from "../src/trace/types.js";
import { SHOP, T, bash, box, ctxAt, offered, prompt, release, say, seedPool, state, stop } from "./skills-consent-fixtures.js";

test("the 3rd session-day of a release that checked out: an offer with the counted lines, shown now", () => {
  const b = box();
  const { offer } = offered(b, 0, { failedFirst: true });
  assert.deepEqual(offer.lines, [
    "Published 1.4.3: npm shows it. That's the 3rd day I've worked out this release from scratch (4 commands this time, 1 failed).",
    "Keep the 3 that worked as a skill, just for you in this repo? (yes / show me / no)",
  ]);
  assert.deepEqual(offer.seen, { n: 3, unit: "day" }, "D101: the count Trail's own reason for offering says");
  assert.equal(offer.key, `${SHOP}|job:release`);
  assert.equal(offerRepo(offer), SHOP);
  assert.equal(offer.channel, "stop");
  assert.equal(offer.shownAt, T(50).toISOString());
  assert.match(offer.name, /^[a-z][a-z0-9-]+$/);
  assert.match(offer.offerId, /^o-[0-9a-f]{6}$/);
  const st = state(b);
  assert.equal(st.pendingOffer?.offerId, offer.offerId);
  assert.equal(st.offerUsed, true);
  assert.deepEqual(foldOffers(readOffers(b.env)).map((r) => [r.id, r.event]), [[offer.offerId, "shown"]]);
});

test("two session-days on one date count as times, not days", () => {
  const b = box();
  seedPool(b, ["2026-10-20", "2026-10-20"]);
  release(b, 0);
  const s = stop(b, 50);
  assert.ok(s.offer, s.why);
  assert.match(s.offer!.lines[0], /That's the 3rd time I've worked out this release from scratch \(3 commands this time\)\.$/);
  assert.deepEqual(s.offer!.seen, { n: 3, unit: "time" });
});

test("each condition of 4.12, refused in order", () => {
  // 1: not learn (a Cursor session folds runs, but learns nothing).
  const cursor = box({ payload: { cursor_version: "1.7.2" } });
  seedPool(cursor);
  release(cursor, 0);
  assert.equal(stop(cursor, 50).why, "learn");

  // 1: a job outside the offer families.
  const fix = box();
  seedPool(fix);
  say(fix, 0, "fix the cart total rounding");
  bash(fix, 10, "npm test", "Tests: 12 passed, 12 total");
  assert.equal(stop(fix, 50).why, "job");

  // 2: no check passed.
  const unchecked = box();
  seedPool(unchecked);
  say(unchecked, 0, "publish 1.4.3");
  bash(unchecked, 10, "npm run build", "built");
  bash(unchecked, 20, "npm publish acme-cli-1.4.3.tgz --access public", "+ acme-cli@1.4.3");
  assert.equal(stop(unchecked, 50).why, "not-checked");

  // 4: offers off.
  const off = box({ settings: { offers: "off" } });
  seedPool(off);
  release(off, 0);
  assert.equal(stop(off, 50).why, "budget:off");

  // 5: only the 2nd session-day.
  const second = box();
  seedPool(second, ["2026-10-20"]);
  release(second, 0);
  assert.equal(stop(second, 50).why, "not-repeated");

  // 6: compile refuses (a step that never goes in a skill).
  const sudo = box();
  seedPool(sudo);
  say(sudo, 0, "publish 1.4.3");
  bash(sudo, 10, "sudo npm publish acme-cli-1.4.3.tgz --access public", "+ acme-cli@1.4.3");
  bash(sudo, 20, "npm view acme-cli version", "1.4.3");
  assert.equal(stop(sudo, 50).why, "compile");

  // D70: a skill of one Run step is not offered (a one-command job is better kept as a lesson).
  const one = box();
  seedPool(one);
  say(one, 0, "publish 1.4.3");
  bash(one, 10, "npm publish acme-cli-1.4.3.tgz --access public", "+ acme-cli@1.4.3");
  bash(one, 20, "npm view acme-cli version", "1.4.3");
  assert.equal(stop(one, 50).why, "one-step");
});

const THREE = ["2026-10-20", "2026-10-23", "2026-10-27"];

test("a pending offer, a run block's run, a missing sheet, and a job a skill already covers are not offered", () => {
  const b = box();
  seedPool(b, THREE);
  release(b, 0);
  const ctx = ctxAt(b, 50);
  withSkillSession(ctx, { catchUp: true }, (st) => {
    const run = currentRun(st)!;
    const v = checkedSuccess(run, "Published 1.4.3; npm shows it.");
    const pending = { ...emptyState().pendingOffer, offerId: "o-000001" } as unknown as PendingOffer;
    assert.deepEqual(offerDue({ run, verdict: v, sheet: null, st: { ...st, pendingOffer: pending }, ctx, channel: "stop" }), { due: false, why: "pending" });
    assert.deepEqual(offerDue({ run: { ...run, skillId: "s-7f3a2c" }, verdict: v, sheet: null, st, ctx, channel: "stop" }), { due: false, why: "skill" });
    assert.deepEqual(offerDue({ run, verdict: v, sheet: null, st, ctx, channel: "stop" }), { due: false, why: "no-sheet" });
  });
  // Covered: a held item for this repo and job, not shown yet.
  mkdirSync(join(b.env.TRAIL_HOME!, "held", "release-npm"), { recursive: true });
  writeFileSync(join(b.env.TRAIL_HOME!, "held", "release-npm", "held.json"), JSON.stringify({
    v: 1, name: "release-npm", why: "no-yes", host: "claude", job: "release", repoKey: SHOP, at: T(-60).toISOString(), shownAt: null,
    id: "s-000001", runId: "r-1027-0001", source: { commands: 3, failed: 0, at: T(-60).toISOString() }, stepsTotal: 3,
  }));
  assert.equal(stop(b, 60).why, "covered");
});

test("the post-tool channel holds the offer unshown until the reply carries it", () => {
  const b = box();
  seedPool(b, THREE);
  release(b, 0);
  const ctx = ctxAt(b, 35);
  withSkillSession(ctx, { catchUp: true }, (st) => {
    const run = currentRun(st)!;
    const v = checkedSuccess(run, null);
    assert.equal(v.checked, false, "the end is judged at Stop");
    const sheet = writeRunSheet(run, { ...v, checked: true, end: "done" }, { host: ctx.host, tier: ctx.tier, sessionHash: ctx.sessionHash, helpers: [] }, b.env);
    const due = offerDue({ run, verdict: { ...v, checked: true, end: "done" }, sheet, st, ctx, channel: "post-tool" });
    assert.ok(due.due);
    assert.equal(due.offer.channel, "post-tool");
    assert.equal(due.offer.shownAt, null);
  });
});

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "offer-moment-"));
  const env = { HOME: dir, TRAIL_HOME: join(dir, "t") };
  mkdirSync(env.TRAIL_HOME, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: "2026-08-01T00:00:00.000Z" }));
  return env;
};
const pending = (extra: Partial<PendingOffer> = {}): PendingOffer => ({
  offerId: "o-81c2aa", moment: "repeated", runId: "r-1027-3f9a", name: "release-npm", key: `${SHOP}|job:release`,
  lines: ["Published 1.4.3: npm shows it.", "Keep the 3 that worked as a skill, just for you in this repo? (yes / show me / no)"],
  channel: "stop", shownAt: T(0).toISOString(), showMe: false, yes: null, typedAfter: [], ...extra,
});
const answers = (env: NodeJS.ProcessEnv) => readOffers(env).filter((l) => l.event === "answer").map((l) => l.answer);

test("captureAnswer: a yes is recorded from the prompt's own words, hashed, and the offer stays for the gate", () => {
  const env = home();
  const st = emptyState({ pendingOffer: pending() });
  const c = captureAnswer(st, "yes please", env, T(30));
  assert.equal(c.answer, "yes");
  assert.match(c.out!.context!, /^\[trail\] From Trail, the tool this person installed to keep commands that worked as skills\. They typed: "yes please"\. .* run: trail skills add release-npm --run r-1027-3f9a\./);
  assert.deepEqual(st.pendingOffer!.yes, { at: T(30).toISOString(), typedSha: typedSha("yes please") });
  assert.deepEqual(answers(env), ["yes"]);
  // The next prompt, the offer already answered: dropped, the prompt goes on as an ask.
  assert.deepEqual(captureAnswer(st, "now bump the docs", env, T(90)), { out: null, answer: "stale" });
  assert.equal(st.pendingOffer, null);
});

test("captureAnswer: two quick yeses keep the save once: the first counts, the second is ignored (D70)", () => {
  const env = home();
  const st = emptyState({ pendingOffer: pending() });
  captureAnswer(st, "yes", env, T(30));
  const first = structuredClone(st.pendingOffer);
  assert.deepEqual(captureAnswer(st, "yes please", env, T(32)), { out: null, answer: null }, "no second directive, no answer recorded");
  assert.deepEqual(st.pendingOffer, first, "the offer stays, with the first yes");
  assert.deepEqual(answers(env), ["yes"]);
  // Anything but a yes after it still drops the offer.
  assert.equal(captureAnswer(st, "wait, not yet", env, T(40)).answer, "stale");
  assert.equal(st.pendingOffer, null);
});

test("captureAnswer: show me, then yes; a second show me is an ordinary prompt", () => {
  const env = home();
  const st = emptyState({ pendingOffer: pending() });
  assert.equal(captureAnswer(st, "show me", env, T(30)).answer, "show");
  assert.equal(st.pendingOffer!.showMe, true);
  assert.equal(captureAnswer(st, "keep it", env, T(60)).answer, "yes");
  assert.deepEqual(answers(env), ["show", "yes"]);

  const again = emptyState({ pendingOffer: pending() });
  captureAnswer(again, "show me", env, T(30));
  const c = captureAnswer(again, "show me", env, T(60));
  assert.equal(c.answer, "other");
  assert.equal(again.pendingOffer, null);
});

test("captureAnswer: no, a correction and anything else drop the offer; only a no and a yes are answers", () => {
  const env = home();
  const no = emptyState({ pendingOffer: pending() });
  const c = captureAnswer(no, "no thanks", env, T(30));
  assert.equal(c.answer, "no");
  assert.equal(no.pendingOffer, null);
  assert.match(c.out!.context!, /OK, not saved\. \(To stop these offers: trail skills offers off\)/, "the first no ever names the way out");

  const fix = emptyState({ pendingOffer: pending({ offerId: "o-000002" }) });
  assert.deepEqual(captureAnswer(fix, "no, that's wrong, the version is 1.4.4", env, T(30)), { out: null, answer: "correction" });
  assert.equal(fix.pendingOffer, null);

  for (const text of ["yes merge it", "sure, but run the tests first", "Yes can you please ship that... right?", "yes and also bump the version"]) {
    const other = emptyState({ pendingOffer: pending({ offerId: "o-000003" }) });
    const r = captureAnswer(other, text, env, T(30));
    assert.equal(r.answer, "other", text);
    assert.equal(r.out, null);
    assert.equal(r.extra, `[trail] From Trail, the tool this person installed to keep commands that worked as skills. They typed: "${text}". That isn't an answer to Trail's offer to keep the last job as a skill, so Trail dropped the offer and kept nothing. No need to bring the offer up again.`);
    assert.equal(other.pendingOffer, null, text);
  }
  const notice = emptyState({ pendingOffer: pending({ offerId: "o-000004", channel: "notice" }) });
  assert.deepEqual(captureAnswer(notice, "ship it", env, T(30)), { out: null, answer: "other" });
  assert.deepEqual(answers(env).slice(0, 2), ["no", "withdrawn"]);
});

test("captureAnswer: a post-tool offer the reply never carried is recorded not shown and dropped", () => {
  const env = home();
  const st = emptyState({ pendingOffer: pending({ channel: "post-tool", shownAt: null }) });
  assert.deepEqual(captureAnswer(st, "yes", env, T(30)), { out: null, answer: "not-shown" });
  assert.equal(st.pendingOffer, null);
  assert.deepEqual(readOffers(env).map((l) => l.event), ["not-shown"]);
  assert.deepEqual(captureAnswer(emptyState(), "yes", env, T(30)), { out: null, answer: null }, "no offer: nothing");
});

test("noteSaveRequest: spends the session's offer, withdraws a pending one, and takes the line this catch-up folded", () => {
  const env = home();
  const st = emptyState({ pendingOffer: pending() });
  const words = "save this as a skill";
  const fold = { typed: [
    { offset: 120, at: T(-600).toISOString(), sha: typedSha(words), answer: "other" as const, save: true },
    { offset: 4096, at: T(-1).toISOString(), sha: typedSha(words), answer: "other" as const, save: true },
    { offset: 5000, at: T(0).toISOString(), sha: typedSha("something else"), answer: "other" as const, save: false },
  ] };
  const skill = { name: "release-npm", steps: [{ cmd: "npm run build", from: ["t1"] }, { cmd: "npm publish x.tgz", from: ["t2"] }], check: "npm view acme-cli version", checkIsStep: false } as unknown as CompiledSkill;
  noteSaveRequest(st, fold, { runId: "r-1027-3f9a", typed: words, scope: "this repo", skill }, env, T(0));
  assert.deepEqual(st.saveRequest, {
    runId: "r-1027-3f9a", at: T(0).toISOString(), typedSha: typedSha(words), scope: "this repo", typed: { offset: 4096, sha: typedSha(words) }, skillSha: skillSha(skill), name: "release-npm",
  }, "D73: the sha of the skill compiled for the ask");
  assert.equal(st.offerUsed, true);
  assert.equal(st.offerUsedBy, "asked");
  assert.equal(st.pendingOffer, null);
  assert.deepEqual(answers(env), ["withdrawn"]);

  const later = emptyState();
  noteSaveRequest(later, null, { runId: "r-1027-3f9a", typed: words, scope: "every repo", skill }, env, T(0));
  assert.equal(later.saveRequest!.typed, null, "not folded yet: the next catch-up fills it");
});

for (const order of ["line-first", "hook-first"] as const) {
  test(`a save request finds the person's line, ${order}`, () => {
    const b = box();
    release(b, 0);
    stop(b, 50);
    const r = prompt(b, 70, "save this as a skill", order);
    assert.match(String(r.save), /^r-1027-/);
    // The next hook's catch-up (here the PreToolUse of the add) meets the line in the hook-first order.
    withSkillSession(ctxAt(b, 80), { catchUp: true }, () => undefined);
    const st = state(b);
    assert.ok(st.saveRequest?.typed, "typed line found");
    assert.ok(st.saveRequest!.typed!.offset > 0);
  });
}

test("offerEndsReply (for g7's Stop): the reply carried the offer only when its last line is the offer's question", () => {
  const o = pending();
  assert.ok(offerEndsReply(o, `Published 1.4.3.\n${o.lines[0]}\n${o.lines[1]}`));
  assert.equal(offerEndsReply(o, `${o.lines[0]}\n${o.lines[1]}\nAlso, deploy to prod now? (yes / no)`), false, "a question of the agent's own after it");
  assert.equal(offerEndsReply(o, "Published 1.4.3; npm shows it."), false, "left out");
  assert.equal(offerEndsReply(o, null), false);
});

test("skillSha: the offered skill's steps and check; the same when only the name differs, changed by a step or a call", () => {
  const sk = (name: string, steps: Array<[string, string[]]>, check = "npm view acme-cli version") => ({
    name, steps: steps.map(([cmd, from], i) => ({ n: i + 1, cmd, from, gated: null, bg: false, wait: false })), check, checkIsStep: false,
  }) as unknown as CompiledSkill;
  const base = skillSha(sk("release-npm", [["npm run build", ["t1"]], ["npm publish x.tgz", ["t2"]]]));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(skillSha(sk("release-npm", [["npm run build", ["t1"]], ["npm publish x.tgz", ["t2"]]])), base);
  assert.equal(skillSha(sk("ship-it", [["npm run build", ["t1"]], ["npm publish x.tgz", ["t2"]]])), base, "the name is not what was agreed");
  assert.equal(skillSha(sk("release-npm", [["bash ~/.trail/skills/release-npm/scripts/x.sh", ["t1"]]])),
    skillSha(sk("ship-it", [["bash ~/.trail/skills/ship-it/scripts/x.sh", ["t1"]]])), "nor the folder a helper runs from");
  assert.notEqual(skillSha(sk("release-npm", [["npm run build", ["t1"]], ["npm run bump", ["t9"]], ["npm publish x.tgz", ["t2"]]])), base, "a step more");
  assert.notEqual(skillSha(sk("release-npm", [["npm run build", ["t1"]], ["npm publish x.tgz", ["t3"]]])), base, "another call");
  assert.notEqual(skillSha(sk("release-npm", [["npm run build", ["t1"]], ["npm publish x.tgz", ["t2"]]], "npm view other version")), base, "another check");
});
