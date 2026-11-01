/**
 * J15 A, B and C and "J07 then the fold" (design story 4), model-free at the
 * module seam c8 wires: a Stop's settle, then `offerDue` with the settled
 * uses, the firings and the planner, the offer recorded shown and said in the
 * Stop block; then the person's answer through `captureAnswer`. The write on
 * a yes is c2's (`trail skills update`): here the directive that names it.
 * The planner is the stand-in in skills-moments-2-fixtures.ts. Made-up
 * acme/shop only.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunCall, SkillSessionState } from "../src/trace/types.js";
import { settleCredit, type Fired } from "../src/skills/credit.js";
import { captureAnswer, offerDue, offerRepo } from "../src/skills/offer-moment.js";
import { driftOfferDue } from "../src/skills/offer-drift.js";
import { foldOffers, readOffers, recordShown, stopBlockReason } from "../src/skills/offers.js";
import { getSkillState, updateSkillState } from "../src/skills/state.js";
import { restoreSkill } from "../src/skills/store.js";
import { writeLesson } from "../src/skills/lessons.js";
import { jsonl, said } from "./trace-fixtures.js";
import { call, cleanup, injFor, input, lab, NOW, npmView, releaseCalls, runOf, sheetOf, SHOP, state, writeSheet, type Lab } from "./skills-moments-2-fixtures.js";

const homes: string[] = [];
after(() => cleanup(homes));

/** The Stop: settle, then the first offer due, recorded shown and said in the block (stop-skills.ts step 10's shape). */
function stop(l: Lab, st: SkillSessionState, calls: RunCall[], runId: string, skillId: string | null) {
  const sheet = writeSheet(l.env, sheetOf(runId, calls, { skillId }));
  const run = runOf(sheet, { skillId });
  st.runs.push(run);
  const fired: Fired[] = [];
  const settled = settleCredit(st, { host: "claude", env: l.env, now: NOW, fired: (f) => fired.push(f) });
  const d = offerDue(input(l, run, sheet, st, { settled, fired }));
  if (!d.due) return { block: null, why: d.why };
  st.pendingOffer = d.offer;
  recordShown(d.offer, offerRepo(d.offer) || run.repoKey, l.env, NOW);
  st.offerUsed = true;
  return { block: stopBlockReason(d.offer), why: null };
}
/** The agent's reply ending with the 2 lines, as the transcript holds it. */
function replied(l: Lab, st: SkillSessionState): string {
  const path = join(l.home, `tx-${st.pendingOffer!.offerId}.jsonl`);
  writeFileSync(path, jsonl([said(`Released 0.22.4.\n\n${st.pendingOffer!.lines!.join("\n")}`, { timestamp: NOW.toISOString() })]));
  return path;
}
const newWay = (v: string): RunCall[] => [call("npm run build"), call(`npm version ${v} --no-git-tag-version`), call(`git push origin v${v}`), npmView(v)];
function needsFix(tag: string): Lab {
  const l = lab(tag, homes);
  updateSkillState(l.id, (s) => ({ ...s!, status: "needs-fix", prevStatus: "active", statusWhy: "step 3 failed on Nov 2 and Nov 4" }), l.env);
  return l;
}

test("J15 A: the release went the new way; the drift offer; 'replace' names trail skills update for c2's write", () => {
  const l = needsFix("j15a");
  const st = state();
  const s = stop(l, st, newWay("0.22.4"), "r-1112-0003", null);
  assert.ok(s.block, `no offer: ${s.why}`);
  assert.match(s.block!, /Replace release-npm with the 3 steps that just worked, retire it, or leave it\? \(replace \/ retire \/ leave it\)/);
  const c = captureAnswer(st, "replace", l.env, NOW, { transcriptPath: replied(l, st) });
  assert.equal(c.answer, "yes");
  assert.match(c.out!.context!, /Run: trail skills update release-npm --offer o-[0-9a-f]{6}\. Trail checks their answer in this session before it changes anything\./);
  assert.equal(getSkillState(l.id, l.env)!.status, "needs-fix", "nothing changes until the gate checks the yes");
  assert.equal(foldOffers(readOffers(l.env)).find((r) => r.moment === "drift")!.op, "replace");
});

test("J15 B: 'retire' moves the folder to .retired, nothing deleted, and trail skills restore brings it back", () => {
  const l = needsFix("j15b");
  const st = state();
  assert.ok(stop(l, st, newWay("0.22.4"), "r-1112-0003", null).block);
  const c = captureAnswer(st, "retire", l.env, NOW, { transcriptPath: replied(l, st) });
  assert.equal(c.answer, "retire");
  assert.ok(!existsSync(l.dir));
  assert.ok(existsSync(join(String(l.env.TRAIL_HOME), "skills", ".retired", "release-npm-2026-11-12", "SKILL.md")));
  assert.ok(restoreSkill("release-npm", l.env, NOW).ok);
  assert.equal(getSkillState(l.id, l.env)!.status, "needs-fix", "restore brings it back as it was");
});

test("J15 C: 'leave it' keeps the skill needing a fix, and the drift offer never comes again for this version", () => {
  const l = needsFix("j15c");
  const st = state();
  assert.ok(stop(l, st, newWay("0.22.4"), "r-1112-0003", null).block);
  assert.equal(captureAnswer(st, "leave it", l.env, NOW).answer, "no");
  assert.equal(getSkillState(l.id, l.env)!.status, "needs-fix");
  const next = stop(l, state(), newWay("0.22.5"), "r-1113-0001", null);
  assert.equal(next.block, null);
  assert.equal(next.why, "covered", "moment 2 never offers a job a skill covers");
  const st2 = state();
  const sheet = writeSheet(l.env, sheetOf("r-1113-0002", newWay("0.22.6")));
  assert.deepEqual(driftOfferDue(input(l, runOf(sheet), sheet, st2)), { due: false, why: "budget:said-no" });
});

test("J07 then the fold (story 4): the lesson the person kept comes back as a one-step offer on the next checked release", () => {
  const l = lab("story4", homes);
  writeLesson({ id: "ls-1a2b3c", skill: "release-npm", at: "2026-10-30", text: "stamp the build too: node scripts/stamp-cli.mjs {version}", kind: "lesson", src: "correction", wall: null }, SHOP, l.env);
  const calls = releaseCalls("0.22.4", { extraAfter: { 2: [call("node scripts/stamp-cli.mjs 0.22.4")] } });
  const st = state({ injected: [{ ...injFor(l, "0.22.4", "r-1112-0002"), at: new Date(Date.parse(calls[0]!.at) - 60_000).toISOString() }] });
  const s = stop(l, st, calls, "r-1112-0002", l.id);
  assert.ok(s.block, `no offer: ${s.why}`);
  assert.match(s.block!, /\nFold your Oct 30 learning into release-npm as step 3\? 1 line changes\. \(yes \/ show me \/ no\)\n/);
  assert.match(s.block!, /If they answer yes, run: trail skills update release-npm --offer o-[0-9a-f]{6}/);
  const show = captureAnswer(st, "show me", l.env, NOW);
  assert.match(show.out!.context!, /trail skills draft r-1112-0002 --print/);
  const yes = captureAnswer(st, "yes", l.env, NOW);
  assert.equal(yes.answer, "yes");
  assert.equal(st.pendingOffer!.fold!.op, "extend");
  assert.deepEqual(st.pendingOffer!.fold!.lessonIds, ["ls-1a2b3c"]);
});
