/**
 * Moment 6 (phase 2 design 4.8, J15, P15, P16, P17, rule 13): a needs-fix
 * skill's job checked out another way, so Trail offers once to replace the
 * skill with the steps that just worked, retire it, or leave it. c2's
 * `replan` is the stand-in from skills-moments-2-fixtures.ts. Made-up
 * acme/shop and acme-cli only.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { RunCall } from "../src/trace/types.js";
import { driftOfferDue } from "../src/skills/offer-drift.js";
import { driftOfferKey, recordAnswer, recordShown } from "../src/skills/offers.js";
import { skillHash } from "../src/skills/skillmd.js";
import { updateSkillState } from "../src/skills/state.js";
import { call, cleanup, input, lab, npmView, releaseCalls, runOf, sheetOf, SHOP, standIn, state, writeSheet, type Lab } from "./skills-moments-2-fixtures.js";

const homes: string[] = [];
after(() => cleanup(homes));

/** J14a's end: release-npm needs a fix. */
function needsFix(tag: string, extra: { applies?: string } = {}): Lab {
  const l = lab(tag, homes);
  updateSkillState(l.id, (s) => ({ ...s!, status: "needs-fix", prevStatus: "active", statusWhy: "step 3 failed on Nov 2 and Nov 4", lastFails: [{ step: 3, at: "2026-11-02T10:00:00.000Z" }, { step: 3, at: "2026-11-04T10:00:00.000Z" }] }), l.env);
  if (extra.applies) {
    const text = readFileSync(l.file, "utf8").replace(`applies: ${JSON.stringify(SHOP)}`, `applies: ${JSON.stringify(extra.applies)}`).replace(`applies: ${SHOP}`, `applies: ${extra.applies}`);
    writeFileSync(l.file, text);
    updateSkillState(l.id, (s) => ({ ...s!, hash: skillHash(text) }), l.env);
  }
  return l;
}
/** The new way: CI publishes from the tag. */
const newWay = (v: string): RunCall[] => [call("npm run build"), call(`npm version ${v} --no-git-tag-version`), call(`git push origin v${v}`), npmView(v)];

function checkedRun(l: Lab, calls: RunCall[], o: { skillId?: string | null; runId?: string } = {}) {
  const sheet = writeSheet(l.env, sheetOf(o.runId ?? "r-1112-0003", calls, { promptParams: { version: "0.22.4" }, skillId: o.skillId ?? null }));
  return { sheet, run: runOf(sheet, { skillId: o.skillId ?? null }), st: state() };
}
const due = (l: Lab, r: ReturnType<typeof checkedRun>, extra: Parameters<typeof input>[4] = {}) => driftOfferDue(input(l, r.run, r.sheet, r.st, extra));

test("J15: a needs-fix skill's job checked out another way; line 2 is the design's copy; the offer pins the replace and names the skill to retire", () => {
  const l = needsFix("j15");
  const r = checkedRun(l, newWay("0.22.4"));
  const d = due(l, r);
  assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
  const o = d.offer;
  assert.equal(o.moment, "drift");
  assert.equal(o.key, driftOfferKey(l.id, 1));
  assert.equal(o.name, "release-npm");
  assert.equal(o.runId, "r-1112-0003");
  assert.equal(o.repo, SHOP);
  const rp = standIn.replan(l.id, "r-1112-0003", "replace", l.env)!;
  const k = rp.next.steps.length;
  assert.ok(k >= 2);
  assert.equal(o.lines![1], `Replace release-npm with the ${k} steps that just worked, retire it, or leave it? (replace / retire / leave it)`);
  assert.equal(o.lines![0], "Published 0.22.4: npm shows it. release-npm needs a fix, and this release went another way: it skipped 'git push origin HEAD:main' (step 3) and 'npm publish --access public' (step 4) and ran 'git push origin v0.22.4'.");
  assert.deepEqual(o.fold, { op: "replace", skillId: l.id, baseHash: rp.baseHash, proposalSha: rp.proposalSha, handEdited: false, version: 1 });
  assert.deepEqual(o.retire, { skillId: l.id, name: "release-npm" });
});

test("P15: a run the same way as the skill is not drift; a run a block drove is not drift", () => {
  const l = needsFix("same");
  assert.deepEqual(due(l, checkedRun(l, releaseCalls("0.22.4"))), { due: false, why: "same-way" });
  assert.deepEqual(due(l, checkedRun(l, newWay("0.22.4"), { skillId: l.id })), { due: false, why: "skill-run" });
});

test("only a needs-fix personal skill of this job that applies here; a checked run of 2 or more steps (D70)", () => {
  const l = needsFix("cond");
  const r = checkedRun(l, newWay("0.22.4"));
  assert.deepEqual(due(l, r, { verdict: { checked: false, checkIndex: null, end: "done" } }), { due: false, why: "not-checked" });
  assert.deepEqual(due(l, { ...r, run: { ...r.run, job: "tests" } }), { due: false, why: "no-skill" });
  assert.deepEqual(due(l, checkedRun(l, [call("git push origin v0.22.4"), npmView("0.22.4")])), { due: false, why: "one-step" });
  assert.deepEqual(due(l, r, { plan: undefined }), { due: false, why: "no-plan" });
  updateSkillState(l.id, (s) => ({ ...s!, scope: "repo" }), l.env);
  assert.deepEqual(due(l, r), { due: false, why: "no-skill" });
  updateSkillState(l.id, (s) => ({ ...s!, scope: "personal", status: "active" }), l.env);
  assert.deepEqual(due(l, r), { due: false, why: "no-skill" });
});

test("a skill for another repo is not drift here; one for every repo is", () => {
  const other = needsFix("other", { applies: "github.com/acme/storefront" });
  assert.deepEqual(due(other, checkedRun(other, newWay("0.22.4"))), { due: false, why: "no-skill" });
  const every = needsFix("every", { applies: "every repo" });
  assert.equal(due(every, checkedRun(every, newWay("0.22.4"))).due, true);
});

test("J15 D: a skill edited by hand gets the beside-your-file line 2 and a handEdited pin", () => {
  const l = needsFix("hand");
  writeFileSync(l.file, `${readFileSync(l.file, "utf8")}\nCI publishes from the tag now.\n`);
  const d = due(l, checkedRun(l, newWay("0.22.4")));
  assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
  assert.equal(d.offer.fold!.handEdited, true);
  assert.match(d.offer.lines![1], /^Write the \d+ steps that just worked beside your edited release-npm, retire it, or leave it\? \(replace \/ retire \/ leave it\)$/);
});

test("J15 C: leave it is a no, never asked again for this version; the session cap is shared", () => {
  const l = needsFix("leave");
  const r = checkedRun(l, newWay("0.22.4"));
  const d = due(l, r);
  assert.ok(d.due);
  assert.deepEqual(due(l, { ...r, st: { ...r.st, offerUsed: true } }), { due: false, why: "budget:session" });
  recordShown(d.offer, SHOP, l.env);
  recordAnswer(d.offer, SHOP, "no", l.env);
  assert.deepEqual(due(l, r), { due: false, why: "budget:said-no" });
});
