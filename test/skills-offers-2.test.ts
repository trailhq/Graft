/**
 * Phase 2's on-disk contracts (design 2.2 to 2.4, 4.10, c0, R2): the offer log
 * keeps moments 5 and 6 and the retire proposal as themselves (never as a
 * repeated-job offer), an answer line may say which change the yes chose, the
 * keys the new moments are budgeted by, the ledger keeps a use line's
 * fidelity facts, the `changed` line and the `retire-offer` reason, and every
 * file 1b wrote reads as it did.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  driftOfferKey, foldOffers, offerBudget, offersPath, readOffers, recordAnswer, recordShown, retireOfferKey, skillOfOfferKey, updateOfferKey,
} from "../src/skills/offers.js";
import { appendLedger, ledgerPath, readLedger } from "../src/skills/ledger.js";
import { readSkillsState, skillsStatePath } from "../src/skills/state.js";
import { loadSkillSession, type GateCtx } from "../src/trace/skill-session.js";
import { sessionPath } from "../src/trace/gate-file.js";
import type { OfferMoment, PendingOffer } from "../src/trace/types.js";
import type { LedgerLine } from "../src/skills/types.js";

const SHOP = "github.com/acme/shop";
const SKILL = "s-7f3a2c";
const NOW = new Date("2026-11-12T12:00:00.000Z");
const DAY = 86_400_000;

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "skills-c0-offers-"));
  made.push(dir);
  const env = { HOME: dir, TRAIL_HOME: join(dir, "trail-home") };
  mkdirSync(env.TRAIL_HOME, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: new Date(NOW.getTime() - 60 * DAY).toISOString() }));
  return env;
}

let seq = 0;
function offer(moment: OfferMoment, key: string, extra: Partial<PendingOffer> = {}): PendingOffer {
  seq++;
  return {
    offerId: `o-${String(seq).padStart(6, "0")}`, moment, runId: `r-1112-${String(seq).padStart(4, "0")}`, name: "release-npm", key,
    lines: ["Released 1.4.3: npm shows it.", "Change step 4 of release-npm to the command that worked? 1 line changes. (yes / show me / no)"],
    channel: "stop", shownAt: null, showMe: false, yes: null, typedAfter: [], repo: SHOP, ...extra,
  };
}

const rawLines = (env: NodeJS.ProcessEnv) => readFileSync(offersPath(env), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

test("the keys of moments 5 and 6 carry the version; the retire proposal's is once per skill", () => {
  assert.equal(updateOfferKey(SKILL, 3), "s-7f3a2c|update|v3");
  assert.equal(driftOfferKey(SKILL, 1), "s-7f3a2c|drift|v1");
  assert.equal(retireOfferKey(SKILL), "s-7f3a2c|retire");
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => updateOfferKey(SKILL, bad), String(bad));
  assert.throws(() => retireOfferKey("s-7f3a2c|update"), "a key part never holds a separator");
});

test("skillOfOfferKey names the skill of a skill-keyed offer, and nothing for a repo-keyed one", () => {
  assert.equal(skillOfOfferKey(updateOfferKey(SKILL, 3)), SKILL);
  assert.equal(skillOfOfferKey(driftOfferKey(SKILL, 12)), SKILL);
  assert.equal(skillOfOfferKey(retireOfferKey(SKILL)), SKILL);
  assert.equal(skillOfOfferKey(`${SKILL}|correction`), SKILL);
  for (const k of [`${SHOP}|job:release`, `${SHOP}|wall:npm-e401-eotp|npm`, `${SKILL}|update`, `${SKILL}|update|v0`, `${SKILL}|drift|3`, "|retire", ""]) {
    assert.equal(skillOfOfferKey(k), null, k);
  }
});

test("a no to moment 5 is never asked again for that version; the next version may be offered", () => {
  const env = home();
  const o = offer("update", updateOfferKey(SKILL, 2));
  recordShown(o, SHOP, env, new Date(NOW.getTime() - 3 * DAY));
  recordAnswer(o, SHOP, "no", env, new Date(NOW.getTime() - 3 * DAY));
  assert.deepEqual(offerBudget({ repoKey: SHOP, key: updateOfferKey(SKILL, 2), sessionOfferUsed: false, now: NOW, env }), { ok: false, why: "said-no" });
  assert.equal(offerBudget({ repoKey: SHOP, key: updateOfferKey(SKILL, 3), sessionOfferUsed: false, now: NOW, env }).ok, true);
});

/* -------------------------------------------------------------------------- */
/* The offer log                                                               */
/* -------------------------------------------------------------------------- */

test("a moment update, drift or retire line is written as itself and round-trips, never as repeated (R2)", () => {
  const env = home();
  const keys: Record<string, string> = { update: updateOfferKey(SKILL, 2), drift: driftOfferKey(SKILL, 2), retire: retireOfferKey(SKILL) };
  const os = (["update", "drift", "retire"] as const).map((m) => offer(m, keys[m]!));
  for (const o of os) recordShown(o, SHOP, env, NOW);
  assert.deepEqual(rawLines(env).map((l) => l.moment), ["update", "drift", "retire"]);
  const read = readOffers(env);
  assert.deepEqual(read.map((l) => l.moment), ["update", "drift", "retire"]);
  const folded = foldOffers(read);
  assert.deepEqual(folded.map((r) => [r.moment, r.key]), [["update", keys.update], ["drift", keys.drift], ["retire", keys.retire]]);
  assert.equal(folded.some((r) => r.moment === "repeated"), false);
});

test("an answer line says which change the yes chose; the record keeps it; a bad op is dropped, the line kept", () => {
  const env = home();
  const drift = offer("drift", driftOfferKey(SKILL, 2));
  const upd = offer("update", updateOfferKey(SKILL, 4));
  recordShown(drift, SHOP, env, NOW);
  recordAnswer(drift, SHOP, "yes", env, NOW, "retire");
  recordShown(upd, SHOP, env, NOW);
  recordAnswer(upd, SHOP, "yes", env, NOW, "extend");
  const lines = rawLines(env);
  assert.equal(lines[1].op, "retire");
  assert.equal(lines[1].answer, "yes");
  assert.equal(lines[3].op, "extend");
  assert.equal(Object.hasOwn(lines[0], "op"), false, "a shown line has no op");
  const rec = foldOffers(readOffers(env));
  assert.deepEqual(rec.map((r) => [r.answer, r.op]), [["yes", "retire"], ["yes", "extend"]]);
  // A line someone else wrote with an op outside the set: read without it, not dropped (its no still counts).
  writeFileSync(offersPath(env), `${readFileSync(offersPath(env), "utf8")}${JSON.stringify({ ...lines[1], id: "o-ffffff", answer: "no", op: "delete" })}\n`);
  const odd = readOffers(env).find((l) => l.id === "o-ffffff");
  assert.ok(odd);
  assert.equal(odd.answer, "no");
  assert.equal(Object.hasOwn(odd, "op"), false);
});

test("an answer without an op writes no op, as 1a's did", () => {
  const env = home();
  const o = offer("repeated", `${SHOP}|job:release`);
  recordShown(o, SHOP, env, NOW);
  recordAnswer(o, SHOP, "yes", env, NOW);
  assert.equal(Object.hasOwn(rawLines(env)[1], "op"), false);
});

/* -------------------------------------------------------------------------- */
/* The ledger                                                                  */
/* -------------------------------------------------------------------------- */

const use = (extra: Record<string, unknown> = {}) => ({
  at: NOW.toISOString(), event: "use", useId: "u-1a2b3c", skill: SKILL, v: "2", host: "claude", cue: "job", repo: SHOP,
  stepsRan: [1, 2, 3], failedStep: null, readyFailed: [], check: "passed", calls: 6, failed: 0, ...extra,
}) as unknown as LedgerLine;

test("a use line keeps its fidelity facts, capped and checked; a 1b use line gains nothing", () => {
  const env = home();
  appendLedger(SKILL, use({ fid: { ran: 5, missing: 1, extra: 2, changed: 1 }, extraShas: ["0a1b2c3d", "deadbeef"], changedSteps: [3] }), env);
  appendLedger(SKILL, use({ fid: { ran: -1, missing: "x", extra: 1.5 }, extraShas: ["0a1b2c3d", "NOTHEX!!", "11111111", "22222222", "33333333", "44444444"],
    changedSteps: [0, 2, 3, 4, 5, 6] }), env);
  appendLedger(SKILL, use(), env);
  const [a, b, c] = readLedger(SKILL, env) as Array<Record<string, unknown>>;
  assert.deepEqual(a!.fid, { ran: 5, missing: 1, extra: 2, changed: 1 });
  assert.deepEqual(a!.extraShas, ["0a1b2c3d", "deadbeef"]);
  assert.deepEqual(a!.changedSteps, [3]);
  assert.deepEqual(b!.fid, { ran: 0, missing: 0, extra: 0, changed: 0 });
  assert.deepEqual(b!.extraShas, ["0a1b2c3d", "11111111", "22222222", "33333333"]);
  assert.deepEqual(b!.changedSteps, [2, 3, 4, 5]);
  for (const k of ["fid", "extraShas", "changedSteps"]) assert.equal(Object.hasOwn(c!, k), false, k);
  assert.equal(readFileSync(ledgerPath(SKILL, env), "utf8").split("\n")[2], JSON.stringify(use()), "a 1b use line is written byte for byte as before");
});

test("a use line's cue may be 'run' (c10); anything else unknown is still 'job'", () => {
  const env = home();
  appendLedger(SKILL, use({ cue: "run" }), env);
  appendLedger(SKILL, use({ cue: "typed" }), env);
  assert.deepEqual(readLedger(SKILL, env).map((l) => (l as { cue: string }).cue), ["run", "job"]);
});

test("the changed line: its fields in order, op closed, numbers checked, lesson ids only when they are ids", () => {
  const env = home();
  appendLedger(SKILL, { at: NOW.toISOString(), event: "changed", skill: SKILL, op: "extend", from: 2, to: 3, offerId: "o-0b2d17", lessonIds: ["ls-0a1b2c", "bad id"] } as LedgerLine, env);
  appendLedger(SKILL, { at: NOW.toISOString(), event: "changed", skill: SKILL, op: "restore-version", from: 3, to: 4, offerId: null, extra: "x" } as unknown as LedgerLine, env);
  appendLedger(SKILL, { at: NOW.toISOString(), event: "changed", skill: SKILL, op: "delete", from: -1, to: 2.5, offerId: 7 } as unknown as LedgerLine, env);
  const raw = readFileSync(ledgerPath(SKILL, env), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(raw[0]), ["at", "event", "skill", "op", "from", "to", "offerId", "lessonIds"]);
  assert.deepEqual(raw[0].lessonIds, ["ls-0a1b2c"]);
  assert.deepEqual(raw[1], { at: NOW.toISOString(), event: "changed", skill: SKILL, op: "restore-version", from: 3, to: 4, offerId: null });
  assert.equal(raw[2].op, "update", "an op outside the set reads as the plainest one");
  assert.equal(raw[2].from, 0);
  assert.equal(raw[2].to, 0);
  assert.equal(raw[2].offerId, null);
  assert.deepEqual(readLedger(SKILL, env).map((l) => l.event), ["changed", "changed", "changed"]);
});

test("a status line keeps the retire-offer reason", () => {
  const env = home();
  appendLedger(SKILL, { at: NOW.toISOString(), event: "status", skill: SKILL, from: "active", to: "retired", reason: "retire-offer" }, env);
  assert.equal((readLedger(SKILL, env)[0] as { reason: string }).reason, "retire-offer");
});

/* -------------------------------------------------------------------------- */
/* What 1b wrote reads unchanged                                               */
/* -------------------------------------------------------------------------- */

test("a 1b state/skills.json reads as it did; phase 2's fields, when there, are kept", () => {
  const env = home();
  const b1 = {
    name: "release-npm", scope: "personal", status: "active", from: "repeated", runId: "r-1027-3f9a", addedAt: "2026-10-27T10:44:05.000Z",
    lastWorked: "2026-11-04", lastUsedAt: "2026-11-04T09:00:00.000Z", lastUsedRepo: SHOP, uses: 4, checkedUses: 3, hash: "sha256:ab",
    source: { commands: 9, failed: 1, at: "2026-10-27T10:44:05.000Z" }, lastFails: [], promoteOffers: {}, cueMisses: { "0a1b2c3d": 1 }, unusedSaidAt: null,
  };
  const p2 = { firings: [{ at: "2026-11-10T10:00:00.000Z", followed: false }], proposed: { hash: "sha256:cd", version: 3, op: "update", at: "2026-11-11T10:00:00.000Z" },
    changedAt: "2026-11-09T10:00:00.000Z", pendingWrite: null };
  mkdirSync(join(env.TRAIL_HOME!, "state"), { recursive: true });
  writeFileSync(skillsStatePath(env), JSON.stringify({ v: 1, skills: { [SKILL]: b1, "s-111111": { ...b1, name: "ship-it", ...p2 } } }));
  const st = readSkillsState(env);
  assert.deepEqual(st.skills[SKILL], b1);
  assert.deepEqual(st.skills["s-111111"], { ...b1, name: "ship-it", ...p2 });
});

test("a 1b ledger and offers.jsonl read as they did", () => {
  const env = home();
  const ledger = [
    { at: "2026-10-27T10:44:05.000Z", event: "saved", skill: SKILL, v: "1", from: "repeated", scope: "personal", receipt: { consent: "offer-yes", stepsVerified: 4, stepsTotal: 4 } },
    use(),
    { at: "2026-11-05T09:00:00.000Z", event: "lesson", skill: SKILL, lessonId: "ls-0a1b2c", src: "correction", consent: "offer-yes" },
    { at: "2026-11-06T09:00:00.000Z", event: "cue", skill: SKILL, phraseSha: "0a1b2c3d", change: "dropped" },
    { at: "2026-11-07T09:00:00.000Z", event: "status", skill: SKILL, from: "active", to: "needs-fix", reason: "failed-twice" },
  ];
  mkdirSync(join(env.TRAIL_HOME!, "ledger"), { recursive: true });
  writeFileSync(ledgerPath(SKILL, env), ledger.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.deepEqual(readLedger(SKILL, env), ledger);
  const offers = [
    { id: "o-0b2d17", at: "2026-11-01T10:00:00.000Z", event: "shown", repo: SHOP, key: `${SHOP}|job:release`, moment: "repeated", runId: "r-1101-0001", name: "release-npm", channel: "stop" },
    { id: "o-0b2d17", at: "2026-11-01T10:01:00.000Z", event: "answer", repo: SHOP, key: `${SHOP}|job:release`, moment: "repeated", runId: "r-1101-0001", name: "release-npm", channel: "stop", answer: "yes" },
    { id: "o-1c3e28", at: "2026-11-03T10:00:00.000Z", event: "shown", repo: SHOP, key: `${SKILL}|correction`, moment: "correction", runId: "r-1103-0002", name: "release-npm", channel: "stop" },
    { id: "o-init-ab12", at: "2026-10-20T10:00:00.000Z", event: "closed", repo: SHOP, key: `${SHOP}|job:ship`, moment: "init", runId: "", name: "", channel: "stop", answer: "no" },
  ];
  writeFileSync(offersPath(env), offers.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.deepEqual(readOffers(env), offers);
});

test("a 1b session file reads as it did, and one with phase 2's Codex facts keeps them", () => {
  const env = home();
  const ctx = { sessionId: "sess-c0-1", sessionHash: "0123456789ab", host: "claude", tier: "A", entry: "interactive", permissionMode: "default",
    subagent: false, fold: true, learn: true, learnOff: null, dir: "/tmp/x", checkout: "", repoKey: SHOP, transcriptPath: null, env, now: NOW } as GateCtx;
  const b1 = {
    v: 1, sessionHash: "0123456789ab", host: "claude", tier: "A", learn: true, scopeKeys: [SHOP], epoch: 0, pendingBoundary: false, runs: [],
    pendingOffer: offer("correction", `${SKILL}|correction`), offerUsed: true, offerUsedBy: "offer", saveRequest: null, injected: [], credit: [],
    tampered: null, updatedAt: NOW.toISOString(), lessonWatch: null, withdrewFor: null, deniedSeen: 2,
  };
  mkdirSync(join(env.TRAIL_HOME!, "sessions"), { recursive: true });
  writeFileSync(sessionPath(ctx.sessionId, ".json", env), JSON.stringify({ trace: { offset: 10 }, skills: b1 }));
  assert.deepEqual(loadSkillSession(ctx), b1);
  const codex = { meta: { id: "019a-0000", originator: "codex_exec", source: "exec", cliVersion: "0.150.0", cwd: "/tmp/x", historyMode: "legacy" }, typedShas: ["0a1b2c3d4e5f6071"] };
  const p2 = { ...b1, pendingOffer: offer("update", updateOfferKey(SKILL, 2), {
    fold: { op: "update", skillId: SKILL, baseHash: "sha256:ab", proposalSha: "0123456789abcdef", handEdited: false, version: 2 } }), codex };
  writeFileSync(sessionPath(ctx.sessionId, ".json", env), JSON.stringify({ skills: p2 }));
  assert.deepEqual(loadSkillSession(ctx), p2);
});
