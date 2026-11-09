/**
 * Recall's 1b parts (design 3.1 step 8, 3.2, 4.17 to 4.19, R30, J14 a, b, e):
 * the asks phrase a job cue fired on rides on the injection as its sha only;
 * the index line's needs-fix words, its "may be out of date" word, and a
 * skill unused for 60 days left out while its cue still fires. Synthetic
 * skills (acme-cli's release, acme/webshop's ship).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { candidatesHere, indexLine, matchCue, needsFixWords, normalizePrompt } from "../src/skills/recall.js";
import { injectionFor } from "../src/skills/runblock.js";
import { phraseSha } from "../src/skills/staleness.js";
import { savePersonal } from "../src/skills/store.js";
import { recordCorrected, recordUse, updateSkillState } from "../src/skills/state.js";
import { appendLedger } from "../src/skills/ledger.js";
import type { LedgerUse } from "../src/skills/types.js";
import { cand, CLI, releaseSkill, shipSkill, WEBSHOP } from "./skills-recall-fixtures.js";

const NOW = new Date("2026-10-20T10:00:00.000Z");
const TAIL = ". When the person asks for one of these jobs, its exact steps come in with their message.";

test("a job cue by an asks phrase carries its phraseSha to the injection; a name cue, a class-only cue and a check carry none (R30)", () => {
  const ship = cand(shipSkill());
  const byPhrase = matchCue(normalizePrompt("ff to prod"), [ship], null, NOW)!;
  assert.equal(byPhrase.kind, "job");
  assert.equal(byPhrase.phraseSha, phraseSha("ff to prod"));
  assert.equal(byPhrase.cand.phraseSha, phraseSha("ff to prod"));
  const inj = injectionFor(byPhrase.cand, byPhrase.values, "job", 1, NOW);
  assert.equal(inj.phraseSha, phraseSha("ff to prod"));
  assert.doesNotMatch(JSON.stringify(inj), /ff to prod/, "the phrase itself is never in the injection");
  assert.equal(ship.phraseSha, undefined, "the candidate list is not changed");

  const longest = matchCue(normalizePrompt("push to beta and ff to prod"), [ship], null, NOW)!;
  assert.ok([phraseSha("push to beta"), phraseSha("ff to prod")].includes(longest.phraseSha!));

  const named = matchCue(normalizePrompt("run ship-beta-then-prod"), [ship], null, NOW)!;
  assert.equal(named.kind, "name");
  assert.equal(named.phraseSha ?? null, null);
  assert.equal(injectionFor(named.cand, named.values, "name", 1, NOW).phraseSha, undefined);

  const classOnly = matchCue(normalizePrompt("deploy the latest commit to prod please"), [cand(shipSkill({ asks: "ship it now" }))], null, NOW);
  assert.equal(classOnly?.kind, "job");
  assert.equal(classOnly?.phraseSha, null);
  assert.equal(injectionFor(cand(shipSkill()), {}, "compact", 1, NOW).phraseSha, undefined);
});

test("J14a: the index line's needs-fix words for failed, corrected at a step, and corrected without one", () => {
  const failed = cand(releaseSkill(), { status: "needs-fix", statusWhy: "step 4 failed on Nov 2 and Nov 4" });
  const corrected = cand(releaseSkill(), { status: "needs-fix", statusWhy: "corrected after its use on Nov 2 and Nov 4" });
  assert.equal(needsFixWords(failed), "step 4 failed on Nov 2 and Nov 4");
  assert.equal(needsFixWords({ ...corrected, correctedStep: 4 }), "step 4 was corrected on Nov 2 and Nov 4");
  assert.equal(needsFixWords({ ...corrected, correctedStep: null }), "corrected on Nov 2 and Nov 4");
  assert.equal(indexLine([], [{ ...corrected, correctedStep: 4 }]),
    `[trail] Trail skills here: release-npm needs a fix (step 4 was corrected on Nov 2 and Nov 4), not used${TAIL}`);
  assert.equal(needsFixWords({ ...failed, why: "step 1 runs sudo" }), "step 1 runs sudo", "refused at recall keeps its words");
});

test("candidatesHere finds the step two corrected uses touched, from the ledger; none when they differ", () => {
  const home = tmpRepo("recall-1b");
  const env = { HOME: home, TRAIL_HOME: join(home, "trail") };
  const id = "s-7f3a2c";
  savePersonal(releaseSkill(), { from: "repeated", runId: "r-1014-3f9a", consent: "offer-yes", stepsVerified: 6, env, now: NOW });
  const use = (useId: string, day: number, ran: number[], failedStep: number | null): LedgerUse => ({
    at: new Date(2026, 10, day, 12).toISOString(), event: "use", useId, skill: id, v: "1", host: "claude", cue: "job", repo: CLI,
    stepsRan: ran, failedStep, readyFailed: [], check: "none", calls: 6, failed: 0,
  });
  for (const u of [use("u-000001", 2, [1, 2, 3, 4], null), use("u-000002", 4, [1, 2, 3, 4], null)]) {
    appendLedger(id, u, env);
    recordUse(id, u, env);
  }
  recordCorrected(id, "u-000001", env, new Date(2026, 10, 2, 13));
  recordCorrected(id, "u-000002", env, new Date(2026, 10, 4, 13));
  const { needsFix } = candidatesHere({ repoKeys: [CLI], checkout: "", env });
  assert.equal(needsFix.length, 1);
  assert.equal(needsFix[0]!.correctedStep, 4);
  assert.match(indexLine([], needsFix), /release-npm needs a fix \(step 4 was corrected on Nov 2 and Nov 4\), not used/);

  // Uses that ended at different steps: corrected, with no step.
  const home2 = tmpRepo("recall-1b");
  const env2 = { HOME: home2, TRAIL_HOME: join(home2, "trail") };
  savePersonal(releaseSkill(), { from: "repeated", runId: "r-1014-3f9a", consent: "offer-yes", stepsVerified: 6, env: env2, now: NOW });
  for (const u of [use("u-000003", 2, [1, 2], null), use("u-000004", 4, [1, 2, 3], 4)]) {
    appendLedger(id, u, env2);
    recordUse(id, u, env2);
  }
  recordCorrected(id, "u-000003", env2, new Date(2026, 10, 2, 13));
  recordCorrected(id, "u-000004", env2, new Date(2026, 10, 4, 13));
  const nf = candidatesHere({ repoKeys: [CLI], checkout: "", env: env2 }).needsFix;
  assert.equal(nf[0]!.correctedStep ?? null, null);
  assert.match(indexLine([], nf), /release-npm needs a fix \(corrected on Nov 2 and Nov 4\), not used/);
});

test("candidatesHere records where it found each skill, for the block's anchor check", () => {
  const home = tmpRepo("recall-1b");
  const env = { HOME: home, TRAIL_HOME: join(home, "trail") };
  savePersonal(shipSkill(), { from: "repeated", runId: "r-1014-3f9a", consent: "offer-yes", stepsVerified: 5, env, now: NOW });
  const { cands } = candidatesHere({ repoKeys: [WEBSHOP], checkout: "/tmp/x/webshop", env });
  assert.deepEqual(cands[0]!.here, { checkout: "/tmp/x/webshop", env });
});

test("J14b: the index says (may be out of date) for a listed skill with gone anchors; a check that throws says nothing", () => {
  const ship = cand(shipSkill(), { checkedUses: 3 });
  const release = cand(releaseSkill(), { checkedUses: 1 });
  const line = indexLine([ship, release], [], { gone: (c) => c.ref.name === "ship-beta-then-prod" });
  assert.equal(line,
    `[trail] Trail skills here: ship-beta-then-prod (push to beta, ff to prod, fast-forward prod) asks before the prod push (may be out of date) · release-npm (publish, release, bump) asks before publishing${TAIL}`);
  assert.equal(indexLine([ship], [], { gone: () => { throw new Error("x"); } }), indexLine([ship], []));
});

test("J14e: a skill unused for 60 days leaves the index line, and its cue still fires", () => {
  const old = cand(releaseSkill(), { addedAt: "2026-07-01T10:00:00.000Z", lastUsedAt: "2026-08-01T10:00:00.000Z", checkedUses: 5 });
  const fresh = cand(shipSkill(), { lastUsedAt: "2026-10-19T10:00:00.000Z" });
  const line = indexLine([old, fresh], [], { now: NOW });
  assert.ok(!line.includes("release-npm"), line);
  assert.ok(line.includes("ship-beta-then-prod"));
  assert.ok(indexLine([old], []).includes("release-npm"), "without now, 1a's line");
  assert.equal(indexLine([old], [], { now: NOW }), "");
  assert.equal(matchCue(normalizePrompt("publish 1.4.3"), [old, fresh], null, NOW)?.cand.ref.name, "release-npm");
});

test("no asks phrase reaches state/skills.json or the ledger through recall (R30)", () => {
  const home = tmpRepo("recall-1b");
  const env = { HOME: home, TRAIL_HOME: join(home, "trail") };
  const PHRASE = "redo the acme publish";
  savePersonal(releaseSkill({ asks: `publish, ${PHRASE}` }), { from: "repeated", runId: "r-1014-3f9a", consent: "offer-yes", stepsVerified: 6, env, now: NOW });
  const { cands } = candidatesHere({ repoKeys: [CLI], checkout: "", env });
  const cue = matchCue(normalizePrompt(PHRASE), cands, null, NOW)!;
  assert.equal(cue.phraseSha, phraseSha(PHRASE));
  updateSkillState("s-7f3a2c", (s) => s && { ...s, cueMisses: { [cue.phraseSha!]: 1 } }, env);
  assert.doesNotMatch(readFileSync(join(home, "trail", "state", "skills.json"), "utf8"), /acme publish/);
  assert.doesNotMatch(readFileSync(join(home, "trail", "ledger", "s-7f3a2c.jsonl"), "utf8"), /acme publish/);
});
