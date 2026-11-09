/**
 * Phase 2 in offer-moment.ts (design 4.9, 4.10, P12, P18, D72, D126, R1,
 * R11): the order moments are tried in, the answers to moments 5 and 6 and
 * the retire proposal (a retire moved by the prompt hook only after a reply
 * that ended with the offer's line 2), the words they route to, and the repo
 * of a skill-keyed offer. Synthetic transcripts and acme/shop only.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingOffer } from "../src/trace/types.js";
import { captureAnswer, offerDue, offerRepo, OFFER_ORDER, repeatedOfferDue } from "../src/skills/offer-moment.js";
import { answerDirective, foldOffers, readOffers, recordShown, stopBlockReason, postToolOfferText } from "../src/skills/offers.js";
import { getSkillState, updateSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { settleCredit } from "../src/skills/credit.js";
import { tryStoreLock } from "../src/skills/store-fs.js";
import { typedSha } from "../src/trace/typed.js";
import { writeLesson } from "../src/skills/lessons.js";
import { notePoolDay } from "../src/trace/pool.js";
import { jsonl, said, typed } from "./trace-fixtures.js";
import { call, cleanup, injFor, input, lab, NOW, releaseCalls, runOf, sheetOf, SHOP, state, writeSheet, type Lab } from "./skills-moments-2-fixtures.js";

const homes: string[] = [];
after(() => cleanup(homes));

const LINES: Record<"update" | "drift" | "retire", [string, string]> = {
  update: ["Published 0.22.4: npm shows it. This time release-npm also needed 'node scripts/stamp-cli.mjs 0.22.4' after step 2.", "Fold your Oct 30 lesson into release-npm as step 3? 1 line changes. (yes / show me / no)"],
  drift: ["Published 0.22.4: npm shows it. release-npm needs a fix, and this release went another way: it ran 'git push origin v0.22.4'.", "Replace release-npm with the 3 steps that just worked, retire it, or leave it? (replace / retire / leave it)"],
  retire: ["Trail brought in skill release-npm 5 times lately, and its steps ran in 1 of them.", "Retire it? trail skills restore release-npm brings it back. (retire / keep it)"],
};

function offer(l: Lab, moment: "update" | "drift" | "retire", extra: Partial<PendingOffer> = {}): PendingOffer {
  const key = moment === "retire" ? `${l.id}|retire` : `${l.id}|${moment}|v1`;
  return {
    offerId: "o-3c9e1d", moment, runId: "r-1112-0002", name: "release-npm", key, lines: LINES[moment], channel: "stop",
    shownAt: "2026-11-12T10:50:00.000Z", showMe: false, yes: null, typedAfter: [], repo: SHOP,
    ...(moment === "retire" ? {} : { fold: { op: moment === "drift" ? "replace" : "extend", skillId: l.id, baseHash: "sha256:" + "a".repeat(64), proposalSha: "b".repeat(16), handEdited: false, version: 1 } }),
    ...(moment === "update" ? {} : { retire: { skillId: l.id, name: "release-npm" } }),
    ...extra,
  } as PendingOffer;
}
/** The agent's reply, then (optionally) the person's typed line, as Claude Code writes them. */
function transcript(l: Lab, reply: string, answer?: string): { path: string; offset: number } {
  const head = jsonl([said(reply, { timestamp: "2026-11-12T10:50:01.000Z" })]);
  const path = join(l.home, `tx-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(path, head + (answer ? jsonl([typed(answer, { timestamp: "2026-11-12T10:51:00.000Z" })]) : ""));
  return { path, offset: Buffer.byteLength(head) };
}
const answered = (l: Lab, id: string) => foldOffers(readOffers(l.env)).find((r) => r.id === id);

test("the order is 4, 6, 5, 3, 2, then the retire proposal (P18)", () => {
  assert.deepEqual([...OFFER_ORDER], ["correction", "drift", "update", "repaired", "repeated", "retire"]);
});

test("update beats the retire proposal at the same Stop: a fold for the run's skill, a not-followed firing for another", () => {
  const l = lab("order", homes);
  updateSkillState(l.id, (s) => ({ ...s!, firings: [false, false, false, false].map((f, k) => ({ at: `2026-11-0${k + 1}T10:00:00.000Z`, followed: f })) }), l.env);
  writeLesson({ id: "ls-1a2b3c", skill: "release-npm", at: "2026-10-30", text: "stamp the build too: node scripts/stamp-cli.mjs {version}", kind: "lesson", src: "correction", wall: null }, SHOP, l.env);
  const calls = releaseCalls("0.22.4", { extraAfter: { 2: [call("node scripts/stamp-cli.mjs 0.22.4")] } });
  const sheet = writeSheet(l.env, sheetOf("r-1112-0002", calls, { skillId: l.id }));
  const run = runOf(sheet, { skillId: l.id });
  const st = state({ injected: [{ ...injFor(l, "0.22.4", run.id), at: new Date(Date.parse(calls[0]!.at) - 60_000).toISOString() }], runs: [run] });
  const settled = settleCredit(st, { host: "claude", env: l.env, now: NOW });
  const fired = [{ skillId: l.id, name: "release-npm", followed: false, runId: run.id, at: NOW.toISOString() }];
  const d = offerDue(input(l, run, sheet, st, { settled, fired }));
  assert.ok(d.due);
  assert.equal(d.offer.moment, "update");
  // Without the fold (no planner), the retire proposal is next in line.
  const r = offerDue(input(l, run, sheet, st, { settled, fired, plan: undefined }));
  assert.ok(r.due);
  assert.equal(r.offer.moment, "retire");
});

test("drift: 'replace' is the yes; the directive names trail skills update; the answer line carries op replace", () => {
  const l = lab("replace", homes);
  const st = state({ pendingOffer: offer(l, "drift") });
  const c = captureAnswer(st, "replace", l.env, NOW);
  assert.equal(c.answer, "yes");
  assert.ok(st.pendingOffer!.yes);
  assert.equal(st.pendingOffer!.yes!.typedSha, typedSha("replace"));
  assert.match(c.out!.context!, /They typed "replace" to the change Trail showed for release-npm\. Run: trail skills update release-npm --offer o-3c9e1d\./);
  assert.equal(answered(l, "o-3c9e1d")!.op, "replace");
  assert.equal(answered(l, "o-3c9e1d")!.answer, "yes");
});

test("update: yes records op extend; show me shows the draft and asks line 2 again; no changes nothing; a correction withdraws it", () => {
  const l = lab("upd", homes);
  const st = state({ pendingOffer: offer(l, "update") });
  assert.match(captureAnswer(st, "show me", l.env, NOW).out!.context!, /trail skills draft r-1112-0002 --print.*Fold your Oct 30 lesson/);
  const y = captureAnswer(st, "yes", l.env, NOW);
  assert.equal(y.answer, "yes");
  assert.equal(answered(l, "o-3c9e1d")!.op, "extend");
  const st2 = state({ pendingOffer: offer(l, "update", { offerId: "o-3c9e1e" }) });
  assert.match(captureAnswer(st2, "no", l.env, NOW).out!.context!, /changed nothing/);
  assert.equal(st2.pendingOffer, null);
  const st3 = state({ pendingOffer: offer(l, "update", { offerId: "o-3c9e1f" }) });
  assert.equal(captureAnswer(st3, "no, it didn't push the tag", l.env, NOW).answer, "correction");
  assert.equal(answered(l, "o-3c9e1f")!.answer, "withdrawn");
});

test("the retire proposal: 'retire' after a reply that ended with line 2 retires the skill, with reason retire-offer, and tells the agent", () => {
  const l = lab("retire", homes);
  const tx = transcript(l, `Released.\n\n${LINES.retire[0]}\n${LINES.retire[1]}`);
  const st = state({ pendingOffer: offer(l, "retire") });
  const c = captureAnswer(st, "retire", l.env, NOW, { transcriptPath: tx.path });
  assert.equal(c.answer, "retire");
  assert.equal(c.changed, "retire");
  assert.equal(st.pendingOffer, null);
  assert.ok(!existsSync(l.dir));
  assert.equal(getSkillState(l.id, l.env)!.status, "retired");
  assert.equal((readLedger(l.id, l.env).filter((x) => x.event === "status").pop() as { reason: string }).reason, "retire-offer");
  assert.match(c.out!.context!, /They typed "retire"\. Trail retired release-npm\. Tell them in one line, with how to bring it back: trail skills restore release-npm\./);
  assert.deepEqual([answered(l, "o-3c9e1d")!.answer, answered(l, "o-3c9e1d")!.op], ["yes", "retire"]);
});

test("R1: a retire after a reply that didn't end with line 2 (the agent's own question, or no offer shown) moves nothing", () => {
  const l = lab("r1", homes);
  for (const reply of [`${LINES.retire[0]}\n${LINES.retire[1]}\nShould I also retire the old docs?`, "Released 0.22.4."]) {
    const tx = transcript(l, reply);
    const st = state({ pendingOffer: offer(l, "retire") });
    const c = captureAnswer(st, "retire", l.env, NOW, { transcriptPath: tx.path });
    assert.equal(c.answer, "other");
    assert.ok(existsSync(l.dir));
    assert.equal(c.changed, undefined);
  }
  // No transcript to check: nothing moves either.
  const st = state({ pendingOffer: offer(l, "retire") });
  assert.equal(captureAnswer(st, "retire", l.env, NOW).answer, "other");
  assert.ok(existsSync(l.dir));
});

test("the person's line already on disk: the reply checked is the one right before it, found by its sha", () => {
  const l = lab("ondisk", homes);
  const tx = transcript(l, `${LINES.drift[0]}\n${LINES.drift[1]}`, "retire it");
  const st = state({ pendingOffer: offer(l, "drift", { typedAfter: [{ offset: tx.offset, sha: typedSha("retire it"), answer: "retire" }] }) });
  const c = captureAnswer(st, "retire it", l.env, NOW, { transcriptPath: tx.path });
  assert.equal(c.answer, "retire");
  assert.ok(!existsSync(l.dir));
});

test("drift's retire and a notice offer: the person read Trail's own words, so no reply is needed", () => {
  const l = lab("notice", homes);
  const st = state({ pendingOffer: offer(l, "drift", { channel: "notice" }) });
  assert.equal(captureAnswer(st, "retire", l.env, NOW).answer, "retire");
  assert.ok(!existsSync(l.dir));
});

test("a busy store moves nothing, records the answer, and says how the person can retire it", () => {
  const l = lab("busy", homes);
  const tx = transcript(l, `${LINES.retire[0]}\n${LINES.retire[1]}`);
  const st = state({ pendingOffer: offer(l, "retire") });
  const r = tryStoreLock(l.env, () => captureAnswer(st, "retire", l.env, NOW, { transcriptPath: tx.path }));
  assert.ok(r.ok);
  assert.equal(r.value.answer, "retire");
  assert.equal(r.value.changed, undefined);
  assert.ok(existsSync(l.dir));
  assert.match(r.value.out!.context!, /couldn't retire it just now: the person can run trail forget release-npm/);
});

test("keep it and leave it are a no; 'retire it and push' is no answer (D53)", () => {
  const l = lab("no", homes);
  const st = state({ pendingOffer: offer(l, "retire") });
  assert.equal(captureAnswer(st, "keep it", l.env, NOW).answer, "no");
  const st2 = state({ pendingOffer: offer(l, "drift", { offerId: "o-3c9e2a" }) });
  assert.equal(captureAnswer(st2, "leave it", l.env, NOW).answer, "no");
  const tx = transcript(l, `${LINES.retire[0]}\n${LINES.retire[1]}`);
  const st3 = state({ pendingOffer: offer(l, "retire", { offerId: "o-3c9e2b" }) });
  assert.equal(captureAnswer(st3, "retire it and push", l.env, NOW, { transcriptPath: tx.path }).answer, "other");
  assert.ok(existsSync(l.dir));
});

test("R11: the Stop block, post-tool text and answers of moments 5, 6 and retire are their own, never 1b's lesson words", () => {
  const l = lab("words", homes);
  for (const m of ["update", "drift", "retire"] as const) {
    const o = offer(l, m);
    const r = stopBlockReason(o);
    assert.ok(r.includes(`\n${LINES[m][0]}\n${LINES[m][1]}\n`));
    assert.ok(!/skills lesson|skills add/.test(r), m);
    assert.ok(postToolOfferText(o).includes(LINES[m][1]));
    assert.ok(!/skills lesson|skills add/.test(answerDirective("yes", o, { paused: false, firstNo: false }, l.env, "yes").context ?? ""));
  }
});

test("D126: a skill-keyed offer with no repo names no repo; recordShown keeps the moment (R2)", () => {
  const l = lab("repo", homes);
  for (const m of ["update", "drift", "retire"] as const) {
    const o = offer(l, m, { repo: undefined });
    assert.equal(offerRepo(o), "");
    recordShown(o, SHOP, l.env, NOW);
  }
  assert.deepEqual(readOffers(l.env).map((x) => x.moment), ["update", "drift", "retire"]);
});

test("a correction and an update at the same Stop: the lesson offer (moment 4) goes first", () => {
  const l = lab("corr", homes);
  writeLesson({ id: "ls-1a2b3c", skill: "release-npm", at: "2026-10-30", text: "stamp the build too: node scripts/stamp-cli.mjs {version}", kind: "lesson", src: "correction", wall: null }, SHOP, l.env);
  // An earlier use the person corrected ("no, it didn't push the tag"), its line at a known offset.
  const head = jsonl([said("Published 0.22.3; npm shows it.", { timestamp: "2026-11-12T09:00:00.000Z" })]);
  const tx = join(l.home, "corr.jsonl");
  const correction = "no, it didn't push the tag";
  writeFileSync(tx, head + jsonl([typed(correction, { timestamp: "2026-11-12T09:05:00.000Z" })]));
  const sha = typedSha(correction);
  const calls = releaseCalls("0.22.4", { extraAfter: { 2: [call("node scripts/stamp-cli.mjs 0.22.4")] } });
  const sheet = writeSheet(l.env, sheetOf("r-1112-0002", calls, { skillId: l.id }));
  const run = runOf(sheet, { skillId: l.id });
  const st = state({
    injected: [{ ...injFor(l, "0.22.4", run.id), injId: "i-00000b", at: new Date(Date.parse(calls[0]!.at) - 60_000).toISOString() }],
    credit: [{ useId: "u-1", injId: "i-00000a", skillId: l.id, epoch: 0, runId: "r-1112-0001", stepsRan: [1, 2], failedStep: null, check: "passed", calls: 2, failed: 0,
      flushed: true, promptsAfter: 2, corrected: { offset: Buffer.byteLength(head), sha } }],
    lessonWatch: { skillId: l.id, useId: "u-1", typedSha: sha, at: NOW.toISOString() },
    runs: [run],
  });
  const settled = settleCredit(st, { host: "claude", env: l.env, now: NOW });
  const i = input(l, run, sheet, st, { settled, ctx: { ...input(l, run, sheet, st).ctx, transcriptPath: tx } });
  const d = offerDue(i);
  assert.ok(d.due);
  assert.equal(d.offer.moment, "correction");
  // With the correction's watch gone, the update is next.
  const u = offerDue({ ...i, st: { ...st, lessonWatch: null } });
  assert.ok(u.due);
  assert.equal(u.offer.moment, "update");
});

test("moment 2 beats the retire proposal: a job worked out from scratch the 3rd day, and a not-followed firing of another skill", () => {
  const l = lab("m2", homes);
  updateSkillState(l.id, (s) => ({ ...s!, status: "active", firings: [false, false, false, false, false].map((f, k) => ({ at: `2026-11-0${k + 1}T10:00:00.000Z`, followed: f })) }), l.env);
  for (const [k, d] of ["2026-11-09", "2026-11-10", "2026-11-11"].entries()) notePoolDay(SHOP, { job: "tests", words: ["tests"] }, { d, s: `seed${k}`, costly: true }, null, l.env, NOW);
  const calls = [call("docker compose up -d db", { kind: "step" }), call("npm run db:migrate", { kind: "step" }), call("npm run test:integration", { kind: "step", check: { family: "tests", passed: true, facts: { passedCount: 12 } } })];
  const sheet = writeSheet(l.env, sheetOf("r-1112-0009", calls, { job: "tests", jobWords: ["tests"] }));
  const run = runOf(sheet, { job: "tests", jobWords: ["tests"] });
  const fired = [{ skillId: l.id, name: "release-npm", followed: false, runId: "r-1112-0008", at: NOW.toISOString() }];
  const m2 = repeatedOfferDue(input(l, run, sheet, state(), { fired }));
  assert.ok(m2.due, `moment 2 not due: ${"why" in m2 ? m2.why : ""}`);
  const d = offerDue(input(l, run, sheet, state(), { fired }));
  assert.ok(d.due);
  assert.equal(d.offer.moment, "repeated");
});
