/**
 * Credit's 1b parts (design 3.2, 4.14 step 1, 4.19, R10, R30, J07, J14d):
 * the phrase a block's cue fired on rides on its credit as a sha; a flush
 * with no step run is a cue miss, and two in a row drop the phrase; a
 * correction inside the window marks the credit `corrected` and watches for
 * a lesson, storing only the typed line's sha. Synthetic release runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunCall, RunState, SkillSessionState } from "../src/trace/types.js";
import { creditWindow, noteCorrectionLine, settleCredit } from "../src/skills/credit.js";
import { savePersonal } from "../src/skills/store.js";
import { getSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { phraseSha } from "../src/skills/staleness.js";
import { parseSkillMd } from "../src/skills/skillmd.js";
import { typedSha } from "../src/trace/typed.js";
import { at, emptyState, injection, runCall, runState } from "./trace-run-fixtures.js";
import { box, compiled, SHOP } from "./skills-store-fixtures.js";

const ID = "s-7f3a2c";
const NOW = new Date("2026-10-01T11:00:00.000Z");
const PHRASE = "redo the acme publish";
const SHA = phraseSha(PHRASE);
let n = 0;
const call = (cmd: string, sec: number, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_c${++n}`, cmd, at: at(sec), ...extra });
const STEPS = ["npm run build", "npm version 1.4.3 --no-git-tag-version", "npm pack", "npm publish acme-cli-1.4.3.tgz --access public", "npm publish acme-core-1.4.3.tgz --access public"];
const ALL = (from: number) => STEPS.map((s, i) => call(s, from + i * 10));

function setup() {
  const b = box("credit-1b");
  const ref = savePersonal(compiled("release-npm", { trail: ID, asks: `publish, release, ${PHRASE}` }), {
    from: "repeated", runId: "r-0930-0001", consent: "offer-yes", stepsVerified: 2, env: b.env, now: NOW,
  });
  return { ...b, ref, ctx: { host: "claude", env: b.env, now: NOW } };
}
const run = (id: string, calls: RunCall[], extra: Partial<RunState> = {}) => runState({ id, repoKey: SHOP, job: "release", closed: true, calls, ...extra });
/** A job-cue block by the phrase, and its run closed with `calls`. */
function block(id: string, calls: RunCall[], sha: string | null = SHA): SkillSessionState {
  return emptyState({ injected: [injection({ injId: `i-${id.slice(-6)}`, at: at(100), runId: id, ...(sha ? { phraseSha: sha } : {}) })], runs: [run(id, calls)] });
}

test("the credit copies the injection's phraseSha (R30)", () => {
  const s = setup();
  const st = block("r-1001-000001", ALL(110));
  settleCredit(st, s.ctx);
  assert.equal(st.credit[0]!.phraseSha, SHA);
  const none = block("r-1001-000002", ALL(110), null);
  settleCredit(none, s.ctx);
  assert.equal(none.credit[0]!.phraseSha ?? null, null);
});

test("J14d: two flushes in a row with no step run drop the phrase from asks; one ledger cue line; the callback hears it", () => {
  const s = setup();
  const dropped: string[] = [];
  const ctx = { ...s.ctx, cueDropped: (id: string) => dropped.push(id) };
  // The agent ran something else entirely: nothing of the block.
  settleCredit(block("r-1001-000011", [call("git status", 110), call("ls", 120)]), ctx);
  assert.equal(getSkillState(ID, s.env)!.cueMisses?.[SHA], 1);
  assert.deepEqual(dropped, []);
  settleCredit(block("r-1001-000012", [call("git log -1", 110)]), ctx);
  assert.deepEqual(dropped, [ID]);
  const text = readFileSync(s.ref.file, "utf8");
  assert.equal(parseSkillMd(text, "release-npm")!.meta.asks, "publish, release");
  assert.deepEqual(readLedger(ID, s.env).filter((l) => l.event === "cue").map((l) => (l as { phraseSha: string }).phraseSha), [SHA]);
  assert.equal(readLedger(ID, s.env).filter((l) => l.event === "use").length, 0, "nothing ran: still no use");
});

test("a flush where steps ran resets the miss count; a name cue (no phrase) never counts", () => {
  const s = setup();
  settleCredit(block("r-1001-000021", [call("ls", 110)]), s.ctx);
  assert.equal(getSkillState(ID, s.env)!.cueMisses?.[SHA], 1);
  settleCredit(block("r-1001-000022", ALL(110)), s.ctx);
  assert.equal(getSkillState(ID, s.env)!.cueMisses?.[SHA] ?? 0, 0);
  settleCredit(block("r-1001-000023", [call("ls", 110)]), s.ctx);
  settleCredit(block("r-1001-000024", [call("ls", 110)], null), s.ctx);
  assert.equal(getSkillState(ID, s.env)!.cueMisses?.[SHA], 1, "the phrase-less flush between changes nothing");
  assert.match(readFileSync(s.ref.file, "utf8"), new RegExp(PHRASE));
});

test("creditWindow with a correction: corrected { offset: null, sha } and lessonWatch; without one, nothing new (R10, P17)", () => {
  const s = setup();
  const st = block("r-1001-000031", ALL(110));
  settleCredit(st, s.ctx);
  const useId = st.credit[0]!.useId;
  assert.deepEqual(creditWindow(st, null, s.ctx), []);
  assert.equal(st.credit[0]!.corrected ?? null, null);
  assert.equal(st.lessonWatch ?? null, null);
  const typed = "it didn't push the tag";
  assert.deepEqual(creditWindow(st, { sha: typedSha(typed) }, s.ctx), [useId]);
  assert.deepEqual(st.credit[0]!.corrected, { offset: null, sha: typedSha(typed) });
  assert.deepEqual(st.lessonWatch, { skillId: ID, useId, typedSha: typedSha(typed), at: NOW.toISOString() });
  assert.doesNotMatch(JSON.stringify(st), /push the tag/, "no typed words in the session state");
  assert.deepEqual(readLedger(ID, s.env).filter((l) => l.event === "corrected").length, 1);
});

test("creditWindow: past the window, or a use the ledger never had, sets no watch; 1a's boolean still marks", () => {
  const s = setup();
  const st = block("r-1001-000041", ALL(110));
  settleCredit(st, s.ctx);
  creditWindow(st, null, s.ctx);
  creditWindow(st, null, s.ctx);
  assert.deepEqual(creditWindow(st, { sha: typedSha("you forgot the tag") }, s.ctx), []);
  assert.equal(st.lessonWatch ?? null, null);
  assert.equal(st.credit[0]!.corrected ?? null, null);

  // Nothing of the block ran: settled with no use, so no correction is recorded and nothing is watched.
  const idle = block("r-1001-000042", [call("ls", 110)], null);
  settleCredit(idle, s.ctx);
  assert.deepEqual(creditWindow(idle, { sha: typedSha("no, wrong") }, s.ctx), []);
  assert.equal(idle.lessonWatch ?? null, null);

  const old = block("r-1001-000043", ALL(110));
  settleCredit(old, s.ctx);
  assert.deepEqual(creditWindow(old, true as never, s.ctx), [old.credit[0]!.useId], "a 1a caller's boolean marks it, with no watch");
  assert.equal(old.lessonWatch ?? null, null);
});

test("noteCorrectionLine fills the offset from the person's typed line with that sha only", () => {
  const s = setup();
  const st = block("r-1001-000051", ALL(110));
  settleCredit(st, s.ctx);
  const sha = typedSha("it didn't push the tag");
  creditWindow(st, { sha }, s.ctx);
  noteCorrectionLine(st, [{ offset: 10, sha: typedSha("something else") }]);
  assert.equal(st.credit[0]!.corrected!.offset, null);
  noteCorrectionLine(st, [{ offset: 4096, sha }]);
  assert.deepEqual(st.credit[0]!.corrected, { offset: 4096, sha });
  noteCorrectionLine(st, [{ offset: 9000, sha }]);
  assert.equal(st.credit[0]!.corrected!.offset, 4096, "the first line found stays");
});

test("no asks phrase or typed words in the state file or the ledger after cue misses and a correction (R30)", () => {
  const s = setup();
  const st = block("r-1001-000061", [call("ls", 110)]);
  settleCredit(st, s.ctx);
  const st2 = block("r-1001-000062", ALL(110));
  settleCredit(st2, s.ctx);
  creditWindow(st2, { sha: typedSha("it didn't push the tag") }, s.ctx);
  for (const f of [join(s.trail, "state", "skills.json"), ...readdirSync(join(s.trail, "ledger")).map((x) => join(s.trail, "ledger", x))]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /acme publish|push the tag/, f);
  }
  assert.doesNotMatch(JSON.stringify(st2), /acme publish|push the tag/);
});
