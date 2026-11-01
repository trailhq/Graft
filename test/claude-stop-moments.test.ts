/**
 * Stop's skills part with moments 3 and 4 (design 3.5 step 6): the
 * correction line the fold meets only at Stop fills its offset (D109), the
 * lesson offer goes out as one block built from its rebuilt lines, the
 * offer order is 4, 3, 2 with one block, and the watch ends with that Stop.
 * Real gate, fold and session lock; a made-up acme/shop.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { said } from "./trace-fixtures.js";
import { SHOP, T, append, bash, box, ctxAt, release, say, seedPool, state, where, type Box } from "./skills-consent-fixtures.js";
import { compiled } from "./skills-store-fixtures.js";
import { savePersonal } from "../src/skills/store.js";
import { creditWindow } from "../src/skills/credit.js";
import { appendLedger } from "../src/skills/ledger.js";
import { offersPath } from "../src/skills/offers.js";
import { withSkillSession, currentRun } from "../src/trace/skill-session.js";
import { typedSha } from "../src/trace/typed.js";
import { stopSkillsRun } from "../src/claude/stop-skills.js";

const boxes: Box[] = [];
after(() => { for (const b of boxes) rmSync(b.root, { recursive: true, force: true }); });
const CORRECTION = "no, it didn't push the tag";

/** A kept skill (`job`) used in the session's run, its credit flushed, then the person's correction, recorded by the prompt hook's creditWindow before the fold met the line. */
function corrected(job: "release" | "tests", opts: { releaseRun?: boolean } = {}): Box {
  const b = box({ env: { TRAIL_TEST_NOW: T(200).toISOString() } });
  boxes.push(b);
  const skill = compiled(job === "release" ? "release-npm" : "integration-tests", { job, trail: "s-7f3a2c" });
  savePersonal(skill, { from: "repeated", runId: "r-0930-0001", consent: "offer-yes", stepsVerified: 2, env: b.env, now: T(0) });
  say(b, 0, "run the integration tests");
  bash(b, 5, "npm run build", "built");
  bash(b, 10, "npm test", "Tests: 12 passed, 12 total");
  append(b, [said("Tests pass.", where(b, 20))]);
  withSkillSession(ctxAt(b, 30), { catchUp: true }, (st) => {
    const run = currentRun(st)!;
    run.closed = true;
    st.injected.push({ injId: "i-0b12aa", skillId: "s-7f3a2c", name: skill.name, epoch: 0, at: T(1).toISOString(), cue: "job", params: { version: "1.4.3" }, steps: [], gated: [], check: null, runId: run.id, live: false });
    st.credit.push({ useId: "u-1", injId: "i-0b12aa", skillId: "s-7f3a2c", epoch: 0, runId: run.id, stepsRan: [1, 2], failedStep: null, check: "passed", calls: 2, failed: 0, flushed: true, promptsAfter: 0 });
  });
  appendLedger("s-7f3a2c", { at: T(25).toISOString(), event: "use", useId: "u-1", skill: "s-7f3a2c", v: "1", host: "claude", cue: "job", repo: SHOP, stepsRan: [1, 2], failedStep: null, readyFailed: [], check: "passed", calls: 2, failed: 0 }, b.env);
  // The prompt hook ran before Claude Code wrote the line: only the sha is recorded, the offset waits for a fold.
  withSkillSession(ctxAt(b, 40), { catchUp: false }, (st) => { creditWindow(st, { sha: typedSha(CORRECTION) }, { env: b.env, now: T(40) }); });
  say(b, 40, CORRECTION);
  if (opts.releaseRun) {
    seedPool(b);
    release(b, 50);
  } else {
    bash(b, 60, "git push origin --tags", "To github.com:acme/shop.git\n * [new tag]         v1.4.3 -> v1.4.3");
    append(b, [said("Pushed the tag.", where(b, 70))]);
  }
  return b;
}

const stopNow = (b: Box) => stopSkillsRun({ ...b.payload, hook_event_name: "Stop", stop_hook_active: false }, "/home/dev/shop", b.env);
const offerLines = (b: Box) => readFileSync(offersPath(b.env), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("the correction line the fold meets at Stop fills its offset, and the lesson offer goes out as one block", () => {
  const b = corrected("release");
  assert.equal(state(b).lessonWatch?.typedSha, typedSha(CORRECTION));
  const r = stopNow(b);
  assert.ok(r.out.block, JSON.stringify(r));
  assert.match(r.out.block!, /\nYou corrected release-npm: it didn't push the tag\.\nAdd a learning to it, just for you: "push the tag too: git push origin --tags"\? \(yes \/ no\)\n/);
  assert.match(r.out.block!, /^\[trail\] From Trail, the tool this person installed/);
  assert.deepEqual(r.sent, [["skill_offered", { moment: "correction" }]]);
  const st = state(b);
  assert.equal(st.pendingOffer?.moment, "correction");
  assert.equal(st.pendingOffer?.lines, null);
  assert.equal(st.lessonWatch, null, "the watch ends with this Stop");
  assert.equal(st.offerUsed, true);
  const lines = offerLines(b);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].moment, "correction");
  assert.equal(lines[0].repo, SHOP);
  const file = readFileSync(`${b.env.TRAIL_HOME}/sessions/${b.sid}.json`, "utf8");
  for (const w of ["didn't", "push the tag too"]) assert.ok(!file.includes(w), `session file holds ${w}`);
});

test("order 4, 3, 2: a turn where the correction's lesson and a repeated job are both due gets one block, the lesson's", () => {
  const b = corrected("tests", { releaseRun: true });
  const r = stopNow(b);
  assert.ok(r.out.block, JSON.stringify(r));
  assert.match(r.out.block!, /You corrected integration-tests/);
  assert.doesNotMatch(r.out.block!, /as a skill, just for you in this repo\?/);
  assert.equal(offerLines(b).length, 1);
  // The next Stop offers nothing more: the session's one offer is spent.
  append(b, [said("Done.", where(b, 300))]);
  assert.equal(stopNow(b).out.block, undefined);
});
