/**
 * Moment 5 (phase 2 design 4.7, P5, P8, P29, R14, rule 13): after a checked
 * use of a block's run that did one thing differently, the offer to change
 * the skill, pinned to the file it was computed from and the text it would
 * write. c2's `foldInputFor` and `replan` are a thin stand-in here
 * (skills-moments-2-fixtures.ts) until c2 lands. Made-up acme/shop only.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunCall, SkillSessionState } from "../src/trace/types.js";
import { settleCredit } from "../src/skills/credit.js";
import { updateOfferDue } from "../src/skills/offer-update.js";
import { recordAnswer, recordShown, updateOfferKey } from "../src/skills/offers.js";
import { writeLesson } from "../src/skills/lessons.js";
import { renderSkillMd, skillHash } from "../src/skills/skillmd.js";
import { updateSkillState } from "../src/skills/state.js";
import { forgetSkill } from "../src/skills/store.js";
import { skillSha } from "../src/skills/offer-moment.js";
import {
  call, cleanup, failed, injFor, input, lab, NOW, PUSH, releaseCalls, runOf, sheetOf, SHOP, standIn, state, writeSheet, type Lab,
} from "./skills-moments-2-fixtures.js";

const homes: string[] = [];
after(() => cleanup(homes));
const STAMP = (v: string) => call(`node scripts/stamp-cli.mjs ${v}`);

/** One checked use of the kept skill: its sheet on disk, its block's injection, the use flushed at `now`. */
function checkedUse(l: Lab, v: string, raw: RunCall[], runId: string, o: { now?: Date; st?: SkillSessionState } = {}) {
  // An earlier use's calls ran before its own flush (minutes before `now`), as a real day's would.
  const calls = o.now ? raw.map((c, k) => ({ ...c, at: new Date(o.now!.getTime() - (raw.length - k) * 60_000).toISOString() })) : raw;
  const sheet = writeSheet(l.env, sheetOf(runId, calls, { skillId: l.id, promptParams: { version: v } }));
  const run = runOf(sheet, { skillId: l.id });
  const st = o.st ?? state();
  st.injected.push({ ...injFor(l, v, runId), injId: `i-${runId.slice(-6)}`, at: new Date(Date.parse(calls[0]!.at) - 60_000).toISOString() });
  st.runs.push(run);
  const settled = settleCredit(st, { host: "claude", env: l.env, now: o.now ?? NOW });
  return { sheet, run, st, settled };
}
const due = (l: Lab, u: ReturnType<typeof checkedUse>, extra: Parameters<typeof input>[4] = {}) =>
  updateOfferDue(input(l, u.run, u.sheet, u.st, { settled: u.settled, ...extra }));
const lessonOn = (l: Lab, text: string) => writeLesson({ id: "ls-1a2b3c", skill: "release-npm", at: "2026-10-30", text, kind: "lesson", src: "correction", wall: null }, SHOP, l.env);

test("J07 then the fold: a kept lesson's command ran and passed, so the offer folds it in, pinned to the file and to the text it would write", () => {
  const l = lab("lesson", homes);
  lessonOn(l, "stamp the build too: node scripts/stamp-cli.mjs {version}");
  const u = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } }), "r-1112-0002");
  assert.equal(u.settled[0]!.use.check, "passed");
  const d = due(l, u);
  assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
  const o = d.offer;
  assert.equal(o.moment, "update");
  assert.equal(o.key, updateOfferKey(l.id, 1));
  assert.equal(o.name, "release-npm");
  assert.equal(o.runId, "r-1112-0002");
  assert.equal(o.repo, SHOP);
  assert.equal(o.channel, "stop");
  assert.equal(o.shownAt, NOW.toISOString());
  assert.deepEqual(o.lines, [
    "Published 0.22.4: npm shows it. This time release-npm also needed 'node scripts/stamp-cli.mjs 0.22.4' after step 2.",
    "Fold your Oct 30 learning into release-npm as step 3? 1 line changes. (yes / show me / no)",
  ]);
  const r = standIn.replan(l.id, "r-1112-0002", "extend", l.env, { inj: u.st.injected[0] })!;
  assert.deepEqual(o.fold, { op: "extend", skillId: l.id, baseHash: skillHash(readFileSync(l.file, "utf8")), proposalSha: r.proposalSha, handEdited: false, version: 1, lessonIds: ["ls-1a2b3c"] });
  assert.match(o.fold!.proposalSha, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(o).includes("stamp the build too"), "no lesson text in the session file");
});

test("update: step 3's push failed and another push worked; line 2 names the step", () => {
  const l = lab("update", homes);
  const u = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { replace: { 3: [failed(PUSH), call("git push origin main")] } }), "r-1112-0002");
  const d = due(l, u);
  assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
  assert.equal(d.offer.fold!.op, "update");
  assert.deepEqual(d.offer.lines, [
    "Published 0.22.4: npm shows it. This time step 3 of release-npm failed and 'git push origin main' worked instead.",
    "Change step 3 of release-npm to the command that worked? 1 line changes. (yes / show me / no)",
  ]);
});

test("two uses (P5): one run's extra step is no offer; the same step in the use before is", () => {
  const l = lab("two", homes);
  const first = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } }), "r-1111-0001", { now: new Date("2026-11-11T11:00:00.000Z") });
  assert.deepEqual(due(l, first), { due: false, why: "plan:no-change" });
  const u = checkedUse(l, "0.22.5", releaseCalls("0.22.5", { extraAfter: { 2: [STAMP("0.22.5")] } }), "r-1112-0002");
  const d = due(l, u);
  assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
  assert.equal(d.offer.lines![1], "Add it to release-npm as step 3? It ran in your last 2 releases. 1 line changes. (yes / show me / no)");
});

test("split: two checked uses ran the same steps 1 to 2; the offer keeps them as their own skill, pinned by skillSha (R3)", () => {
  const l = lab("split", homes);
  const sub = (v: string) => [call("npm run build"), call(`npm version ${v} --no-git-tag-version`), call("npm view acme-cli version", {
    tail: v, check: { family: "npm-view", passed: true, facts: { version: v, pkg: "acme-cli" } } })];
  checkedUse(l, "0.22.4", sub("0.22.4"), "r-1111-0001", { now: new Date("2026-11-11T11:00:00.000Z") });
  const u = checkedUse(l, "0.22.5", sub("0.22.5"), "r-1112-0002");
  const d = due(l, u);
  assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
  const o = d.offer;
  assert.equal(o.fold!.op, "split");
  assert.equal(o.name, o.fold!.splitName);
  assert.notEqual(o.name, "release-npm");
  assert.match(o.skillSha!, /^[0-9a-f]{64}$/);
  assert.equal(o.fold!.proposalSha, o.skillSha!.slice(0, 16));
  assert.match(o.lines![1], new RegExp(`^Keep steps 1 to 2 as their own skill, ${o.name}, beside release-npm\\? \\(yes / show me / no\\)$`));
  void skillSha;
});

test("a hand-edited file: the plan is on the person's file as it is, and line 2 says Trail writes it beside their file", () => {
  const l = lab("hand", homes);
  writeFileSync(l.file, `${readFileSync(l.file, "utf8")}\nAsk me before a Friday release.\n`);
  lessonOn(l, "stamp the build too: node scripts/stamp-cli.mjs {version}");
  const u = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } }), "r-1112-0002");
  const d = due(l, u);
  assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
  assert.equal(d.offer.fold!.handEdited, true);
  assert.match(d.offer.lines![1], /You changed release-npm by hand, so Trail writes it beside your file for you to compare\. \(yes \/ show me \/ no\)$/);
});

test("due only at a checked use of a block's run: not unchecked, not a failed check, not a run no block drove, not another skill's", () => {
  const l = lab("checked", homes);
  lessonOn(l, "stamp the build too: node scripts/stamp-cli.mjs {version}");
  const calls = releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } });
  const u = checkedUse(l, "0.22.4", calls, "r-1112-0002");
  assert.deepEqual(due(l, u, { verdict: { checked: false, checkIndex: null, end: "done" } }), { due: false, why: "not-checked" });
  assert.deepEqual(due(l, { ...u, run: { ...u.run, skillId: null } }), { due: false, why: "no-skill" });
  assert.deepEqual(due(l, { ...u, run: { ...u.run, skillId: "s-000000" } }), { due: false, why: "not-settled" });
  assert.deepEqual(due(l, u, { settled: [] }), { due: false, why: "not-settled" });
  assert.deepEqual(due(l, u, { settled: [{ ...u.settled[0]!, use: { ...u.settled[0]!.use, check: "failed" } }] }), { due: false, why: "not-settled" });
  assert.deepEqual(due(l, u, { plan: undefined }), { due: false, why: "no-plan" });
  assert.deepEqual(due(l, u, { channel: "post-tool" }), { due: false, why: "channel" });
  assert.deepEqual(due(l, u, { ctx: { ...input(l, u.run, u.sheet, u.st).ctx, learn: false } }), { due: false, why: "learn" });
});

test("not after a correction of that use, not for needs-fix or retired, never for a repo skill (rule 13)", () => {
  const l = lab("status", homes);
  lessonOn(l, "stamp the build too: node scripts/stamp-cli.mjs {version}");
  const u = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } }), "r-1112-0002");
  const corrected = structuredClone(u.st);
  corrected.credit[0]!.corrected = { offset: null, sha: "a".repeat(64) };
  assert.deepEqual(due(l, { ...u, st: corrected }), { due: false, why: "corrected" });
  updateSkillState(l.id, (s) => ({ ...s!, status: "needs-fix" }), l.env);
  assert.deepEqual(due(l, u), { due: false, why: "status" });
  updateSkillState(l.id, (s) => ({ ...s!, status: "active", scope: "repo" }), l.env);
  assert.deepEqual(due(l, u), { due: false, why: "skill" });
  updateSkillState(l.id, (s) => ({ ...s!, scope: "personal" }), l.env);
  assert.equal(due(l, u).due, true);
  forgetSkill("release-npm", l.env, NOW);
  assert.deepEqual(due(l, u), { due: false, why: "skill" });
});

test("keys per version (P8): a no is never asked again for that version; a new version may be offered; the session and week caps are shared", () => {
  const l = lab("keys", homes);
  lessonOn(l, "stamp the build too: node scripts/stamp-cli.mjs {version}");
  const u = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } }), "r-1112-0002");
  const d = due(l, u);
  assert.ok(d.due);
  assert.deepEqual(due(l, { ...u, st: { ...u.st, offerUsed: true } }), { due: false, why: "budget:session" });
  recordShown(d.offer, SHOP, l.env, NOW);
  recordAnswer(d.offer, SHOP, "no", l.env, NOW);
  assert.deepEqual(due(l, u), { due: false, why: "budget:said-no" });
  // v2: a version Trail wrote after a yes (c2's writeNewVersion does this; here the file and its hash by hand).
  const v2 = renderSkillMd({ ...l.base, meta: { ...l.base.meta, version: "2" } });
  writeFileSync(l.file, v2);
  updateSkillState(l.id, (s) => ({ ...s!, hash: skillHash(v2) }), l.env);
  const again = due(l, u);
  assert.ok(again.due, `not due: ${"why" in again ? again.why : ""}`);
  assert.equal(again.offer.key, updateOfferKey(l.id, 2));
  assert.equal(again.offer.fold!.version, 2);
});

test("offers off stays off", () => {
  const l = lab("off", homes);
  lessonOn(l, "stamp the build too: node scripts/stamp-cli.mjs {version}");
  const u = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } }), "r-1112-0002");
  const settings = join(String(l.env.TRAIL_HOME), "settings.json");
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), offers: "off" }));
  assert.deepEqual(due(l, u), { due: false, why: "budget:off" });
});

test("the week cap is shared with moments 2 to 4: three offers shown this week and moment 5 waits", () => {
  const l = lab("week", homes);
  lessonOn(l, "stamp the build too: node scripts/stamp-cli.mjs {version}");
  const u = checkedUse(l, "0.22.4", releaseCalls("0.22.4", { extraAfter: { 2: [STAMP("0.22.4")] } }), "r-1112-0002");
  for (const [k, key] of [`${SHOP}|job:ship`, `${SHOP}|wall:docker|docker`, "s-1b2c3d|correction"].entries()) {
    recordShown({ offerId: `o-00000${k}`, moment: k === 2 ? "correction" : "repeated", runId: "r-x", name: "x", key, lines: ["a", "b"], channel: "stop",
      shownAt: NOW.toISOString(), showMe: false, yes: null, typedAfter: [], repo: SHOP }, SHOP, l.env, new Date(NOW.getTime() - (k + 1) * 3_600_000));
  }
  assert.deepEqual(due(l, u), { due: false, why: "budget:week" });
});
