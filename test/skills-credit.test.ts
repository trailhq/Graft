/**
 * Settling credit (design 3.5 step 5, 3.2 step 5, 4.8; D57; the g3 note on
 * carried runs): a run block's use is credited from the commands that ran,
 * and flushed once (one ledger `use`, one `recordUse`) when its run closed or
 * its check passed. A run the next typed ask closed is credited from its
 * sheet. A job a compaction cut and the agent carried on is one use. The
 * person's correction within 2 prompts is one `corrected` line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckHit, CreditState, RunCall, RunState, SkillInjection, SkillSessionState } from "../src/trace/types.js";
import { creditWindow, settleCredit } from "../src/skills/credit.js";
import { savePersonal } from "../src/skills/store.js";
import { getSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import type { LedgerUse } from "../src/skills/types.js";
import { writeRunSheet } from "../src/trace/run-sheets.js";
import { at, emptyState, injection, runCall, runState } from "./trace-run-fixtures.js";
import { box, compiled, SHOP } from "./skills-store-fixtures.js";

const ID = "s-7f3a2c";
const NOW = new Date("2026-10-01T11:00:00.000Z");
const pass: CheckHit = { family: "npm-view", passed: true, facts: {} };
let n = 0;
const call = (cmd: string, sec: number, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_s${++n}`, cmd, at: at(sec), ...extra });
const STEPS = ["npm run build", "npm version 1.4.3 --no-git-tag-version", "npm pack", "npm publish acme-cli-1.4.3.tgz --access public", "npm publish acme-core-1.4.3.tgz --access public"];
const ALL = (from: number) => STEPS.map((s, i) => call(s, from + i * 10));
const CHECK = (sec: number, check: CheckHit | undefined = pass) => call("npm view acme-cli version", sec, { kind: "look", ...(check ? { check } : {}) });

function setup(): { env: NodeJS.ProcessEnv; ctx: { host: string; env: NodeJS.ProcessEnv; now: Date } } {
  const b = box("credit");
  savePersonal(compiled("release-npm", { trail: ID }), { from: "repeated", runId: "r-0930-0001", consent: "offer-yes", stepsVerified: 2, env: b.env, now: NOW });
  return { env: b.env, ctx: { host: "claude", env: b.env, now: NOW } };
}
const run = (extra: Partial<RunState>) => runState({ id: "r-1001-3f9a", repoKey: SHOP, job: "release", closed: false, calls: [], ...extra });
const uses = (env: NodeJS.ProcessEnv) => readLedger(ID, env).filter((l) => l.event === "use");
const sheetMeta = { host: "claude", tier: "A" as const, sessionHash: "e76b4ca7f1a0", helpers: [] };

test("a passed check flushes the use once: ledger use, recordUse, the block no longer live", () => {
  const { env, ctx } = setup();
  const inj = injection({ at: at(100), runId: "r-1001-3f9a" });
  const st = emptyState({ injected: [inj], runs: [run({ calls: [...ALL(110), CHECK(200)] })] });
  const out = settleCredit(st, ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.outcome, "checked");
  assert.equal(out[0]!.name, "release-npm");
  const [use] = uses(env);
  // Phase 2 (4.1, c3): the use line also carries next-run fidelity (counts and 8-hex keys); skills-credit-2 pins it.
  const { fid, extraShas, changedSteps, ...line1a } = use as LedgerUse;
  assert.ok(fid && Array.isArray(extraShas) && Array.isArray(changedSteps));
  assert.deepEqual({ ...line1a, useId: "x" }, {
    at: NOW.toISOString(), event: "use", useId: "x", skill: ID, v: "1", host: "claude", cue: "job", repo: SHOP,
    stepsRan: [1, 2, 3, 4, 5], failedStep: null, readyFailed: [], check: "passed", calls: 6, failed: 0,
  });
  assert.equal(getSkillState(ID, env)?.status, "active");
  assert.equal(getSkillState(ID, env)?.uses, 1);
  assert.equal(st.credit.length, 1);
  assert.equal(st.credit[0]!.flushed, true);
  assert.equal(st.credit[0]!.useId, (use as { useId: string }).useId);
  assert.equal(inj.live, false);
  // Settling again adds nothing.
  assert.deepEqual(settleCredit(st, ctx), []);
  assert.equal(uses(env).length, 1);
  assert.equal(getSkillState(ID, env)?.uses, 1);
});

test("an open run with no passed check yet keeps its credit open and writes nothing", () => {
  const { env, ctx } = setup();
  const inj = injection({ at: at(100), runId: "r-1001-3f9a" });
  const st = emptyState({ injected: [inj], runs: [run({ calls: ALL(110).slice(0, 3) })] });
  assert.deepEqual(settleCredit(st, ctx), []);
  assert.equal(st.credit.length, 1);
  const c = st.credit[0]!;
  assert.deepEqual([c.flushed, c.stepsRan, c.check, c.calls, c.injId, c.runId, c.skillId], [false, [1, 2, 3], "none", 3, inj.injId, "r-1001-3f9a", ID]);
  assert.deepEqual(uses(env), []);
  assert.equal(inj.live, true);
});

test("D57: a run the next typed ask closed is credited from its sheet once the session emptied its calls", () => {
  const { env, ctx } = setup();
  const done = run({ closed: true, calls: ALL(110), stepCalls: 5 });
  writeRunSheet(done, { checked: false, checkIndex: null, end: "done" }, sheetMeta, env);
  const st = emptyState({ injected: [injection({ at: at(100), runId: "r-1001-3f9a" })], runs: [{ ...done, calls: [] }, run({ id: "r-1001-4000", startedAt: at(400) })] });
  const out = settleCredit(st, ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.outcome, "unchecked");
  const [use] = uses(env) as Array<{ stepsRan: number[]; calls: number; check: string }>;
  assert.deepEqual([use!.stepsRan, use!.calls, use!.check], [[1, 2, 3, 4, 5], 5, "none"]);
  assert.equal(getSkillState(ID, env)?.uses, 1);
  assert.equal(getSkillState(ID, env)?.status, "candidate");
});

test("D57: inside the prompt hook's catch-up the just-closed run still holds its calls, and that is enough", () => {
  const { env, ctx } = setup();
  const st = emptyState({ injected: [injection({ at: at(100), runId: "r-1001-3f9a" })], runs: [run({ closed: true, calls: [...ALL(110).slice(0, 3), call(STEPS[3]!, 150, { failed: true })] })] });
  const out = settleCredit(st, ctx);
  assert.equal(out[0]!.outcome, "failed");
  const [use] = uses(env) as Array<{ stepsRan: number[]; failedStep: number }>;
  assert.deepEqual([use!.stepsRan, use!.failedStep], [[1, 2, 3], 4]);
  assert.deepEqual(getSkillState(ID, env)?.lastFails.map((f) => f.step), [4]);
});

test("a check-cue line earns nothing, and a block nothing ran from is no use", () => {
  const { env, ctx } = setup();
  const st = emptyState({
    injected: [injection({ injId: "i-000001", cue: "check", steps: [], at: at(100), runId: "r-1001-3f9a" }), injection({ injId: "i-000002", at: at(100), runId: "r-1001-3f9a" })],
    runs: [run({ closed: true, calls: [call("git status", 120, { kind: "look" })] })],
  });
  assert.deepEqual(settleCredit(st, ctx), []);
  assert.deepEqual(uses(env), []);
  assert.equal(getSkillState(ID, env)?.uses, 0);
  assert.deepEqual(st.credit.map((c) => [c.injId, c.flushed]), [["i-000002", true]]);
});

test("two settled uses failing at the same step make the skill needs-fix", () => {
  const { env, ctx } = setup();
  for (const [k, day] of [[1, 2], [2, 4]] as const) {
    const id = `r-1001-000${k}`;
    const st = emptyState({ injected: [injection({ injId: `i-00000${k}`, at: at(100), runId: id })], runs: [run({ id, closed: true, calls: [call(STEPS[0]!, 110), call(STEPS[1]!, 120, { failed: true })] })] });
    settleCredit(st, { ...ctx, now: new Date(`2026-11-0${day}T10:00:00.000Z`) });
  }
  const s = getSkillState(ID, env)!;
  assert.equal(s.status, "needs-fix");
  assert.equal(s.statusWhy, "step 2 failed on Nov 2 and Nov 4");
});

// A job a compaction cut (D59a): the cut run's block and the carried run are one use.

function carried(): { st: SkillSessionState; cut: RunState; carry: RunState; old: SkillInjection; again: SkillInjection } {
  const cut = run({ id: "r-1001-00c0", epoch: 0, closed: true, calls: ALL(110).slice(0, 3), stepCalls: 3, lastAt: at(130) });
  const carry = run({ id: "r-1001-00c1", epoch: 1, startedAt: at(300), calls: [...ALL(110).slice(3).map((c, i) => ({ ...c, at: at(310 + i * 10) }))], carriedFrom: cut.id });
  const old = injection({ injId: "i-0000c0", epoch: 0, at: at(100), runId: cut.id, live: false });
  const again = injection({ injId: "i-0000c1", epoch: 1, cue: "compact", at: at(300), runId: carry.id });
  const st = emptyState({ epoch: 1, injected: [old, again], runs: [cut, carry] });
  return { st, cut, carry, old, again };
}

test("a cut run waiting to be carried is not credited on its own", () => {
  const { env, ctx } = setup();
  const { st, cut } = carried();
  st.runs = [cut];
  st.injected = st.injected.slice(0, 1);
  st.cut = cut.id;
  assert.deepEqual(settleCredit(st, ctx), []);
  assert.deepEqual(uses(env), []);
  // The carry ended without a run taking it (the person typed): now the cut run is its own use.
  delete st.cut;
  assert.equal(settleCredit(st, ctx).length, 1);
  assert.deepEqual((uses(env)[0] as { stepsRan: number[] }).stepsRan, [1, 2, 3]);
});

test("a job carried across a compaction is one use: steps from both halves, both blocks flushed together", () => {
  const { env, ctx } = setup();
  const { st, carry, old, again } = carried();
  assert.deepEqual(settleCredit(st, ctx), []);
  carry.calls.push({ ...CHECK(400), id: "toolu_chk" });
  const out = settleCredit(st, ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.injIds.sort(), [old.injId, again.injId].sort());
  const all = uses(env) as Array<{ stepsRan: number[]; check: string; calls: number; cue: string; useId: string }>;
  assert.equal(all.length, 1);
  assert.deepEqual([all[0]!.stepsRan, all[0]!.check, all[0]!.calls, all[0]!.cue], [[1, 2, 3, 4, 5], "passed", 6, "job"]);
  assert.equal(getSkillState(ID, env)?.uses, 1);
  const flushed = st.credit.filter((c: CreditState) => c.flushed);
  assert.equal(flushed.length, 2);
  assert.ok(flushed.every((c) => c.useId === all[0]!.useId));
  assert.deepEqual(settleCredit(st, ctx), []);
});

test("the cut half is read from its sheet once the session emptied it, and the carried run alone still credits the old block", () => {
  const { env, ctx } = setup();
  const { st, cut, carry, old } = carried();
  writeRunSheet(cut, { checked: false, checkIndex: null, end: "open" }, sheetMeta, env);
  cut.calls = [];
  st.injected = [old];
  carry.closed = true;
  const out = settleCredit(st, ctx);
  assert.equal(out.length, 1);
  assert.deepEqual((uses(env)[0] as { stepsRan: number[] }).stepsRan, [1, 2, 3, 4, 5]);
});

test("the parts are joined as g3 joins them (joinCarriedSheet): a part from another session, or one that ended after the carry began, is not the job", () => {
  // The cut half's sheet is another session's (a copied runs/ folder): the carried run is credited alone.
  {
    const { env, ctx } = setup();
    const { st, cut, carry, again } = carried();
    writeRunSheet(cut, { checked: false, checkIndex: null, end: "open" }, { ...sheetMeta, sessionHash: "0123456789ab" }, env);
    st.runs = [carry];
    st.injected = [again];
    carry.closed = true;
    const out = settleCredit(st, ctx);
    assert.equal(out.length, 1);
    assert.deepEqual((uses(env)[0] as { stepsRan: number[] }).stepsRan, [4, 5]);
  }
  // The cut part ended after the carried one began: not one job, so two uses.
  {
    const { env, ctx } = setup();
    const { st, cut, carry } = carried();
    cut.lastAt = at(350);
    carry.closed = true;
    assert.equal(settleCredit(st, ctx).length, 2);
    assert.deepEqual(uses(env).map((u) => (u as { stepsRan: number[] }).stepsRan), [[1, 2, 3], [4, 5]]);
  }
  // A part closed with no step call (no sheet) still links the parts on either side of it.
  {
    const { env, ctx } = setup();
    const { st, cut, carry, old, again } = carried();
    const mid = run({ id: "r-1001-00cm", epoch: 1, startedAt: at(200), lastAt: at(210), closed: true, calls: [], stepCalls: 0, carriedFrom: cut.id });
    const last = { ...carry, id: "r-1001-00c2", epoch: 2, carriedFrom: mid.id, closed: true };
    writeRunSheet(cut, { checked: false, checkIndex: null, end: "open" }, sheetMeta, env);
    cut.calls = [];
    st.runs = [cut, mid, last];
    st.injected = [old, { ...again, epoch: 2, runId: last.id }];
    const out = settleCredit(st, ctx);
    assert.equal(out.length, 1);
    assert.deepEqual((uses(env)[0] as { stepsRan: number[] }).stepsRan, [1, 2, 3, 4, 5]);
  }
});

test("creditCalls joins a carried sheet with the part before it", async () => {
  const { creditCalls } = await import("../src/skills/ledger.js");
  const { env } = setup();
  const { cut, carry, again } = carried();
  writeRunSheet(cut, { checked: false, checkIndex: null, end: "open" }, sheetMeta, env);
  writeRunSheet({ ...carry, closed: true, stepCalls: 2 }, { checked: false, checkIndex: null, end: "done" }, sheetMeta, env);
  assert.deepEqual(creditCalls(again, [], env).map((c) => c.cmd), STEPS);
});

test("the credit list keeps 10, dropping settled ones first", () => {
  const { ctx } = setup();
  const st = emptyState();
  for (let k = 0; k < 12; k++) {
    const id = `r-1001-01${String(k).padStart(2, "0")}`;
    st.injected.push(injection({ injId: `i-0001${String(k).padStart(2, "0")}`, at: at(100), runId: id }));
    st.runs.push(run({ id, closed: k < 6, calls: [call(STEPS[0]!, 110)] }));
  }
  settleCredit(st, ctx);
  assert.equal(st.credit.length, 10);
  assert.equal(st.credit.filter((c) => !c.flushed).length, 6);
});

test("creditWindow: a correction in the 2 prompts after a use is one corrected line; the window then closes", () => {
  const { env, ctx } = setup();
  const st = emptyState({ injected: [injection({ at: at(100), runId: "r-1001-3f9a" })], runs: [run({ closed: true, calls: ALL(110) })] });
  settleCredit(st, ctx);
  const useId = st.credit[0]!.useId;
  assert.deepEqual(creditWindow(st, false, ctx), []);
  assert.equal(st.credit[0]!.promptsAfter, 1);
  assert.deepEqual(creditWindow(st, true, ctx), [useId]);
  assert.deepEqual(creditWindow(st, true, ctx), []);
  assert.deepEqual(readLedger(ID, env).filter((l) => l.event === "corrected").map((l) => (l as { useId: string }).useId), [useId]);
  // A third prompt is past the window.
  const st2 = emptyState({ injected: [injection({ injId: "i-0000ff", at: at(100), runId: "r-1001-0fff" })], runs: [run({ id: "r-1001-0fff", closed: true, calls: ALL(110) })] });
  settleCredit(st2, ctx);
  creditWindow(st2, false, ctx);
  creditWindow(st2, false, ctx);
  assert.deepEqual(creditWindow(st2, true, ctx), []);
});

test("D71 d: a block's failed ready probes ride on the injection's own readyFailed; settling needs no callback", () => {
  const { env, ctx } = setup();
  const inj: SkillInjection = { ...injection({ at: at(100), runId: "r-1001-3f9a" }), readyFailed: ["git status --porcelain", "command -v npm"] };
  const st = emptyState({ injected: [inj], runs: [run({ calls: [...ALL(110), CHECK(200)] })] });
  assert.equal(settleCredit(st, ctx).length, 1);
  const [use] = uses(env) as Array<{ readyFailed: string[] }>;
  assert.deepEqual(use!.readyFailed, ["clean", "program"]);
  // A session file edited by hand: anything but a list of strings reads as none, never a throw.
  const odd = { ...injection({ injId: "i-0000aa", at: at(100), runId: "r-1001-3f9b" }), readyFailed: "git status --porcelain" } as unknown as SkillInjection;
  const st2 = emptyState({ injected: [odd], runs: [run({ id: "r-1001-3f9b", calls: [...ALL(110), CHECK(200)] })] });
  assert.equal(settleCredit(st2, ctx).length, 1);
  assert.deepEqual((uses(env)[1] as { readyFailed: string[] }).readyFailed, []);
});
