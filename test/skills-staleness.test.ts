/**
 * Cue misses and 60 days unused (design 1.3, 4.19, R30, J14 d and e): an
 * asks phrase whose block went unused twice in a row leaves `metadata.asks`
 * (never the last one, never in a file edited by hand), counted and logged by
 * its sha only; a skill unused for 60 days is said once. Synthetic skills in
 * a sandbox TRAIL_HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillState } from "../src/skills/types.js";
import { cueFlush, dropPhrase, markMissingSaid, markUnusedSaid, noteCueResult, phraseSha, unusedSince } from "../src/skills/staleness.js";
import { listAllPersonal, savePersonal } from "../src/skills/store.js";
import { getSkillState, skillsStatePath } from "../src/skills/state.js";
import { appendLedger, readLedger } from "../src/skills/ledger.js";
import { parseSkillMd, skillHash } from "../src/skills/skillmd.js";
import { box, compiled } from "./skills-store-fixtures.js";

const ID = "s-7f3a2c";
const NOW = new Date("2026-10-20T10:00:00.000Z");
const PHRASE = "redo the acme publish";

function saved(asks = `publish, release, ${PHRASE}`) {
  const b = box("stale");
  const ref = savePersonal(compiled("release-npm", { trail: ID, asks }), { from: "repeated", runId: "r-1001-0001", consent: "offer-yes", stepsVerified: 2, env: b.env, now: NOW });
  return { ...b, ref };
}
const st = (extra: Partial<SkillState> = {}): SkillState => ({
  name: "release-npm", scope: "personal", status: "active", from: "repeated", runId: null, addedAt: "2026-07-01T10:00:00.000Z", lastWorked: null,
  lastUsedAt: null, lastUsedRepo: null, uses: 0, checkedUses: 0, hash: "sha256:x", source: null, lastFails: [], promoteOffers: {}, ...extra,
});

test("phraseSha: 8 hex of sha256, the same for the same phrase however it is spaced or cased", () => {
  assert.match(phraseSha(PHRASE), /^[0-9a-f]{8}$/);
  assert.equal(phraseSha(`  Redo  the ACME publish `), phraseSha(PHRASE));
  assert.notEqual(phraseSha("publish"), phraseSha("release"));
});

test("noteCueResult: a miss counts, a followed block resets, the 2nd miss in a row drops; no sha changes nothing", () => {
  const s = st();
  const sha = phraseSha(PHRASE);
  assert.deepEqual(noteCueResult(s, sha, false), { drop: false });
  assert.equal(s.cueMisses?.[sha], 1);
  assert.deepEqual(noteCueResult(s, sha, true), { drop: false });
  assert.equal(s.cueMisses?.[sha] ?? 0, 0, "followed: back to 0");
  noteCueResult(s, sha, false);
  assert.deepEqual(noteCueResult(s, sha, false), { drop: true });
  const before = JSON.stringify(s);
  assert.deepEqual(noteCueResult(s, null, false), { drop: false });
  assert.equal(JSON.stringify(s), before);
  const bad = st({ cueMisses: "x" as unknown as Record<string, number> });
  assert.deepEqual(noteCueResult(bad, sha, false), { drop: false });
  assert.deepEqual(bad.cueMisses, { [sha]: 1 }, "a hand-mangled count starts again");
});

test("dropPhrase: removes the phrase with that sha, keeps the file a valid skill, and moves st.hash", () => {
  const b = saved();
  const s = getSkillState(ID, b.env)!;
  assert.equal(dropPhrase(b.ref, s, phraseSha(PHRASE)), true);
  const text = readFileSync(b.ref.file, "utf8");
  const parsed = parseSkillMd(text, "release-npm")!;
  assert.equal(parsed.meta.asks, "publish, release");
  assert.equal(parsed.meta.trail, ID);
  assert.equal(s.hash, skillHash(text));
  assert.equal(dropPhrase(b.ref, s, phraseSha(PHRASE)), false, "gone already");
});

test("dropPhrase: never the last phrase, never a file edited by hand, never through a link", () => {
  const one = saved(PHRASE);
  assert.equal(dropPhrase(one.ref, getSkillState(ID, one.env)!, phraseSha(PHRASE)), false, "the last phrase stays");

  const edited = saved();
  writeFileSync(edited.ref.file, readFileSync(edited.ref.file, "utf8").replace("## Run", "## Run\n<!-- mine -->"));
  const s = getSkillState(ID, edited.env)!;
  const hash = s.hash;
  assert.equal(dropPhrase(edited.ref, s, phraseSha(PHRASE)), false);
  assert.equal(s.hash, hash);
  assert.match(readFileSync(edited.ref.file, "utf8"), new RegExp(PHRASE));

  const linked = saved();
  const away = join(linked.home, "kept-elsewhere");
  renameSync(linked.ref.dir, away);
  symlinkSync(away, linked.ref.dir);
  assert.equal(dropPhrase(linked.ref, getSkillState(ID, linked.env)!, phraseSha(PHRASE)), false);
  assert.match(readFileSync(join(away, "SKILL.md"), "utf8"), new RegExp(PHRASE));
});

test("cueFlush: two unfollowed blocks drop the phrase, state follows the file, one ledger cue line; the phrase is in no file but SKILL.md (R30)", () => {
  const b = saved();
  const sha = phraseSha(PHRASE);
  assert.deepEqual(cueFlush(ID, sha, false, b.env, NOW), { dropped: false });
  assert.equal(getSkillState(ID, b.env)!.cueMisses?.[sha], 1);
  assert.deepEqual(cueFlush(ID, sha, false, b.env, NOW), { dropped: true });
  const s = getSkillState(ID, b.env)!;
  assert.equal(s.hash, skillHash(readFileSync(b.ref.file, "utf8")), "the hash in state follows the file");
  assert.equal(s.cueMisses?.[sha] ?? 0, 0);
  assert.equal(parseSkillMd(readFileSync(b.ref.file, "utf8"), "release-npm")!.meta.asks, "publish, release");
  const cue = readLedger(ID, b.env).filter((l) => l.event === "cue");
  assert.deepEqual(cue, [{ at: NOW.toISOString(), event: "cue", skill: ID, phraseSha: sha, change: "dropped" }]);
  assert.doesNotMatch(readFileSync(skillsStatePath(b.env), "utf8"), /acme publish/);
  assert.doesNotMatch(readFileSync(join(b.trail, "ledger", `${ID}.jsonl`), "utf8"), /acme publish/);
  // A followed block, or no phrase, writes nothing new.
  const ledger = readFileSync(join(b.trail, "ledger", `${ID}.jsonl`), "utf8");
  assert.deepEqual(cueFlush(ID, null, false, b.env, NOW), { dropped: false });
  assert.deepEqual(cueFlush(ID, phraseSha("publish"), true, b.env, NOW), { dropped: false });
  assert.equal(readFileSync(join(b.trail, "ledger", `${ID}.jsonl`), "utf8"), ledger);
  assert.deepEqual(cueFlush("s-000000", sha, false, b.env, NOW), { dropped: false }, "no such skill");
});

test("cueFlush: a hand-edited skill is never edited; the count just stays", () => {
  const b = saved();
  const sha = phraseSha(PHRASE);
  writeFileSync(b.ref.file, `${readFileSync(b.ref.file, "utf8")}\n<!-- edited -->\n`);
  cueFlush(ID, sha, false, b.env, NOW);
  assert.deepEqual(cueFlush(ID, sha, false, b.env, NOW), { dropped: false });
  assert.equal(getSkillState(ID, b.env)!.cueMisses?.[sha], 2);
  assert.match(readFileSync(b.ref.file, "utf8"), new RegExp(PHRASE));
  assert.deepEqual(readLedger(ID, b.env).filter((l) => l.event === "cue"), []);
  assert.equal(listAllPersonal(b.env).length, 1);
});

test("the ledger keeps lesson and cue lines with their own fields only", () => {
  const b = saved();
  appendLedger(ID, { at: NOW.toISOString(), event: "lesson", skill: ID, lessonId: "ls-3c9e1a", src: "correction", consent: "offer-yes", text: "push the tag" } as never, b.env);
  appendLedger(ID, { at: NOW.toISOString(), event: "cue", skill: ID, phraseSha: PHRASE, change: "dropped" } as never, b.env);
  const lines = readLedger(ID, b.env).slice(-2);
  assert.deepEqual(lines[0], { at: NOW.toISOString(), event: "lesson", skill: ID, lessonId: "ls-3c9e1a", src: "correction", consent: "offer-yes" });
  assert.deepEqual(lines[1], { at: NOW.toISOString(), event: "cue", skill: ID, phraseSha: "", change: "dropped" }, "a phrase passed where a sha goes is never written");
  assert.doesNotMatch(readFileSync(join(b.trail, "ledger", `${ID}.jsonl`), "utf8"), /acme publish|push the tag/);
});

test("unusedSince: 60+ days since the last use, else since saved; null before", () => {
  const now = new Date(2026, 9, 20, 12);
  assert.equal(unusedSince(st({ addedAt: new Date(2026, 7, 1, 9).toISOString() }), now), "2026-08-01");
  assert.equal(unusedSince(st({ addedAt: new Date(2026, 7, 22, 9).toISOString() }), now), null, "59 days");
  assert.equal(unusedSince(st({ addedAt: new Date(2026, 4, 1).toISOString(), lastUsedAt: new Date(2026, 9, 1).toISOString() }), now), null, "used this month");
  assert.equal(unusedSince(st({ addedAt: "", lastUsedAt: null }), now), null);
});

test("markUnusedSaid once per unused stretch; markMissingSaid once a day", () => {
  const b = saved();
  const later = new Date(NOW.getTime() + 61 * 86400000);
  assert.equal(markUnusedSaid(ID, b.env, NOW), false, "not unused yet");
  assert.equal(markUnusedSaid(ID, b.env, later), true);
  assert.equal(markUnusedSaid(ID, b.env, new Date(later.getTime() + 86400000)), false, "said once");
  assert.equal(markMissingSaid(ID, b.env, NOW), true);
  assert.equal(markMissingSaid(ID, b.env, new Date(NOW.getTime() + 3600000)), false, "same day");
  assert.equal(markMissingSaid(ID, b.env, new Date(NOW.getTime() + 86400000)), true, "the next day");
  assert.equal(markMissingSaid("s-000000", b.env, NOW), false);
});
