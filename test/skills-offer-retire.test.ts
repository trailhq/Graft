/**
 * The retire proposal (phase 2 design 4.9, spec 13, P13, R12): 5 or more
 * firings with half or fewer followed, at the Stop that wrote a not-followed
 * one, after a turn that ended done, once per skill, ever. And the retire
 * itself: 1a's forget with ledger reason retire-offer, a busy store moving
 * nothing. Made-up acme/shop only.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Fired } from "../src/skills/credit.js";
import { retireOfferDue, retireSkill } from "../src/skills/offer-retire.js";
import { recordAnswer, recordShown, retireOfferKey } from "../src/skills/offers.js";
import { getSkillState, updateSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { restoreSkill } from "../src/skills/store.js";
import { tryStoreLock } from "../src/skills/store-fs.js";
import { cleanup, input, lab, NOW, releaseCalls, runOf, sheetOf, SHOP, state, type Lab } from "./skills-moments-2-fixtures.js";

const homes: string[] = [];
after(() => cleanup(homes));

function firings(l: Lab, followed: boolean[]): void {
  updateSkillState(l.id, (s) => ({ ...s!, status: "active", firings: followed.map((f, k) => ({ at: new Date(NOW.getTime() - (followed.length - k) * 86_400_000).toISOString(), followed: f })) }), l.env);
}
const notFollowed = (l: Lab): Fired[] => [{ skillId: l.id, name: "release-npm", followed: false, runId: "r-1112-0004", at: NOW.toISOString() }];
function due(l: Lab, fired: Fired[], extra: Parameters<typeof input>[4] = {}) {
  const sheet = sheetOf("r-1112-0004", releaseCalls("0.22.4"));
  const run = runOf(sheet, { skillId: l.id });
  return retireOfferDue(input(l, run, null, state(), { verdict: { checked: false, checkIndex: null, end: "done" }, ...extra }), fired);
}

test("5 firings with 2 followed is due, with its two lines and the skill to retire; once per skill, ever (P13)", () => {
  const l = lab("due", homes);
  firings(l, [true, false, true, false, false]);
  const d = due(l, notFollowed(l));
  assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
  const o = d.offer;
  assert.equal(o.moment, "retire");
  assert.equal(o.key, retireOfferKey(l.id));
  assert.equal(o.repo, SHOP);
  assert.deepEqual(o.retire, { skillId: l.id, name: "release-npm" });
  assert.deepEqual(o.lines, [
    "Trail brought in skill release-npm 5 times lately, and its steps ran in 2 of them.",
    "Retire it? trail skills restore release-npm brings it back. (retire / keep it)",
  ]);
  assert.equal(o.fold, undefined);
  // Shown once and left unanswered: never again (1a's second chance doesn't apply).
  recordShown(o, SHOP, l.env, NOW);
  recordAnswer(o, SHOP, "none", l.env, NOW);
  assert.deepEqual(due(l, notFollowed(l), { ctx: { ...input(l, runOf(sheetOf("r-x", [])), null, state()).ctx, now: new Date(NOW.getTime() + 30 * 86_400_000) } }), { due: false, why: "once" });
});

test("5 firings with 3 followed is not due; 4 firings is too few; 6 with 3 followed is due", () => {
  const l = lab("counts", homes);
  firings(l, [true, true, true, false, false]);
  assert.deepEqual(due(l, notFollowed(l)), { due: false, why: "followed" });
  firings(l, [false, false, false, false]);
  assert.deepEqual(due(l, notFollowed(l)), { due: false, why: "few" });
  firings(l, [true, true, true, false, false, false]);
  assert.equal(due(l, notFollowed(l)).due, true);
});

test("due only at a Stop that wrote a not-followed firing, after a turn that ended done (R12)", () => {
  const l = lab("when", homes);
  firings(l, [false, false, false, false, false]);
  assert.deepEqual(due(l, []), { due: false, why: "no-firing" });
  assert.deepEqual(due(l, [{ ...notFollowed(l)[0]!, followed: true }]), { due: false, why: "no-firing" });
  for (const end of ["failure", "question"] as const) assert.deepEqual(due(l, notFollowed(l), { verdict: { checked: false, checkIndex: null, end } }), { due: false, why: "end" });
  assert.deepEqual(due(l, notFollowed(l), { channel: "post-tool" }), { due: false, why: "channel" });
});

test("only an active or candidate personal skill: not needs-fix, not retired, not a repo skill, not a guardrail or any learning that isn't a skill", () => {
  const l = lab("status", homes);
  firings(l, [false, false, false, false, false]);
  updateSkillState(l.id, (s) => ({ ...s!, status: "needs-fix" }), l.env);
  assert.deepEqual(due(l, notFollowed(l)), { due: false, why: "status" });
  updateSkillState(l.id, (s) => ({ ...s!, status: "active", scope: "repo" }), l.env);
  assert.deepEqual(due(l, notFollowed(l)), { due: false, why: "skill" });
  // A guardrail is a lesson, never a skill in the store: a firing that names one finds no skill to retire.
  assert.deepEqual(due(l, [{ ...notFollowed(l)[0]!, skillId: "ls-9f8e7d", name: "never-force-push" }]), { due: false, why: "skill" });
});

test("retireSkill: the folder moves to .retired (nothing deleted), the ledger says retire-offer, restore brings it back", () => {
  const l = lab("move", homes);
  const r = retireSkill("release-npm", "retire-offer", l.env, NOW, l.id);
  assert.ok(r.ok);
  assert.ok(!existsSync(l.dir));
  assert.deepEqual(readdirSync(join(String(l.env.TRAIL_HOME), "skills", ".retired")), ["release-npm-2026-11-12"]);
  assert.equal(getSkillState(l.id, l.env)!.status, "retired");
  const status = readLedger(l.id, l.env).filter((x) => x.event === "status").pop() as { reason: string; to: string };
  assert.deepEqual([status.reason, status.to], ["retire-offer", "retired"]);
  assert.ok(restoreSkill("release-npm", l.env, NOW).ok);
  assert.ok(existsSync(l.dir));
});

test("retireSkill: a busy store moves nothing; a folder that isn't the offer's skill is not retired", () => {
  const l = lab("busy", homes);
  const inside = tryStoreLock(l.env, () => retireSkill("release-npm", "retire-offer", l.env, NOW, l.id));
  assert.ok(inside.ok);
  assert.deepEqual(inside.value, { ok: false, reason: "busy" });
  assert.ok(existsSync(l.dir));
  assert.deepEqual(retireSkill("release-npm", "retire-offer", l.env, NOW, "s-000000"), { ok: false, reason: "unknown" });
  assert.ok(existsSync(l.dir));
});
