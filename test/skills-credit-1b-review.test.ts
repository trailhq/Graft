/**
 * Review attacks on b3's credit and staleness parts (design 3.2, 4.14 step 1,
 * 4.19, R10, R27, R30): the correction's offset must be filled from the
 * person's own line where the hooks meet it, a block that wasn't ready is no
 * cue miss, an asks phrase or a typed correction is never written anywhere
 * outside SKILL.md, and the 60-day rule can't be pinned by a date after now.
 * Synthetic release runs, a sandbox TRAIL_HOME and a made-up transcript.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunCall, SkillSessionState } from "../src/trace/types.js";
import type { SkillState } from "../src/skills/types.js";
import { creditWindow, noteCorrectionLine, settleCredit } from "../src/skills/credit.js";
import { savePersonal } from "../src/skills/store.js";
import { getSkillState } from "../src/skills/state.js";
import { phraseSha, unusedSince } from "../src/skills/staleness.js";
import { typedSha } from "../src/trace/typed.js";
import { promptSkills } from "../src/claude/prompt-skills.js";
import { at, emptyState, injection, runCall, runState } from "./trace-run-fixtures.js";
import { box as storeBox, compiled, SHOP } from "./skills-store-fixtures.js";
import { releaseSkill, WEBSHOP } from "./skills-recall-fixtures.js";
import { box, CWD, gateFor, grow, payload, ranIn, replyAt, save, stateOf, typedIn, withNow } from "./skills-prompt-fixtures.js";

const ID = "s-7f3a2c";
const NOW = new Date("2026-10-01T11:00:00.000Z");
const PHRASE = "redo the acme publish";
const SHA = phraseSha(PHRASE);
let n = 0;
const call = (cmd: string, sec: number) => runCall({ id: `toolu_r${++n}`, cmd, at: at(sec) });

function setup() {
  const b = storeBox("b3rev-credit");
  savePersonal(compiled("release-npm", { trail: ID, asks: `publish, release, ${PHRASE}` }), {
    from: "repeated", runId: "r-0930-0001", consent: "offer-yes", stepsVerified: 2, env: b.env, now: NOW,
  });
  return { ...b, ctx: { host: "claude", env: b.env, now: NOW } };
}
function block(id: string, calls: RunCall[], extra: Record<string, unknown> = {}): SkillSessionState {
  return emptyState({
    injected: [injection({ injId: `i-${id.slice(-6)}`, at: at(100), runId: id, phraseSha: SHA, ...extra })],
    runs: [runState({ id, repoKey: SHOP, job: "release", closed: true, calls })],
  });
}

/* ------------------------------------------------------------- cue misses */

test("4.19: a block whose ready probes failed is no cue miss: the agent was right not to run it", () => {
  const s = setup();
  settleCredit(block("r-1001-000101", [call("git status", 110)], { readyFailed: ["clean"] }), s.ctx);
  settleCredit(block("r-1001-000102", [call("git status", 110)], { readyFailed: ["on-branch"] }), s.ctx);
  assert.equal(getSkillState(ID, s.env)!.cueMisses?.[SHA] ?? 0, 0);
  assert.match(readFileSync(join(s.trail, "skills", "release-npm", "SKILL.md"), "utf8"), new RegExp(PHRASE));
});

/* ------------------------------------------------------ the correction line */

test("noteCorrectionLine: of several lines with the sha in one fold, the newest is the correction's", () => {
  const s = setup();
  const st = block("r-1001-000111", ["npm run build", "npm pack"].map((c, i) => call(c, 110 + i)));
  settleCredit(st, s.ctx);
  const sha = typedSha("no, you forgot to push the tag");
  creditWindow(st, { sha }, s.ctx);
  noteCorrectionLine(st, [{ offset: 100, sha }, { offset: 900, sha }]);
  assert.equal(st.credit[0]!.corrected!.offset, 900);
});

test("4.14 step 1 wired: the prompt hook that sees the correction fills its offset from the person's line it just folded", () => {
  const b = box("b3rev-wire");
  save(b, releaseSkill({ applies: WEBSHOP, trail: ID, asks: `publish, ${PHRASE}` }));
  const run = (prompt: string, env = b.env) => promptSkills(payload(b, prompt), CWD, env, { track: () => {}, gate: gateFor(b) });
  run("can you pull and publish 1.4.2");
  grow(b, [
    typedIn(b, "can you pull and publish 1.4.2", 0),
    ...ranIn(b, "git pull --ff-only origin main", "Already up to date.", 5),
    ...ranIn(b, "npm run build", "built", 10),
    ...ranIn(b, "npm publish acme-cli-1.4.2.tgz --access public", "+ acme-cli@1.4.2", 15),
    ...ranIn(b, "npm view acme-cli version", "1.4.2", 20),
    replyAt("Published 1.4.2: npm shows it. Used skill release-npm", 25),
    typedIn(b, "now look at the cart page styles", 120),
  ]);
  run("now look at the cart page styles", withNow(b, "2026-10-20T10:02:00.000Z"));
  const correction = "no, you forgot to push the tag";
  const before = statSync(b.transcript).size;
  grow(b, [typedIn(b, correction, 200)]);
  run(correction, withNow(b, "2026-10-20T10:03:30.000Z"));
  const st = stateOf(b);
  const c = st.credit.find((x) => x.corrected);
  assert.ok(c, "the use was corrected");
  assert.equal(c!.corrected!.sha, typedSha(correction));
  assert.equal(c!.corrected!.offset, before, "the offset of the person's own line");
  assert.equal(st.lessonWatch?.typedSha, typedSha(correction));

  // Nothing under the Trail home but the skill's own SKILL.md holds the asks phrase or the typed correction (R30, rule 6).
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  for (const f of files(b.env.TRAIL_HOME!)) {
    if (f.endsWith(join("release-npm", "SKILL.md"))) continue;
    assert.doesNotMatch(readFileSync(f, "utf8"), /redo the acme publish|forgot to push the tag/, f);
  }
});

/* ---------------------------------------------------------------- 60 days */

const state = (extra: Partial<SkillState> = {}): SkillState => ({
  name: "release-npm", scope: "personal", status: "active", from: "repeated", runId: null, addedAt: "2026-07-01T10:00:00.000Z", lastWorked: null,
  lastUsedAt: null, lastUsedRepo: null, uses: 0, checkedUses: 0, hash: "sha256:x", source: null, lastFails: [], promoteOffers: {}, ...extra,
});

test("60 days unused: a use stamped after now (a clock that moved back, a hand edit) or unreadable doesn't pin the skill in the index", () => {
  const now = new Date("2026-10-20T10:00:00.000Z");
  assert.equal(unusedSince(state({ lastUsedAt: "2099-01-01T00:00:00.000Z" }), now), "2026-07-01");
  assert.equal(unusedSince(state({ lastUsedAt: "not a date" }), now), "2026-07-01");
  assert.equal(unusedSince(state({ lastUsedAt: "2099-01-01T00:00:00.000Z", addedAt: "2099-01-01T00:00:00.000Z" }), now), null, "nothing to go on: not unused");
  assert.equal(unusedSince(state({ lastUsedAt: "2026-10-01T00:00:00.000Z" }), now), null, "a real recent use");
});
