/**
 * D93 (2): a held item is said at a `startup` or `resume` SessionStart of a session other than the one that held
 * it, once. A compaction (or a clear) of the holding session never spends it, nor does a resume of that session.
 * The held item keeps the holding session's hash. Real save gate, real SessionStart part, made-up repo.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionStartSkills } from "../src/claude/start-skills.js";
import { skillsGate } from "../src/trace/skill-session.js";
import { saveHeld } from "../src/skills/store.js";
import { listHeld } from "../src/skills/store-held.js";
import { SHOP, add, box, iso, kept, release, stop, T, type Box } from "./skills-consent-fixtures.js";
import { releaseSkill } from "./skills-recall-fixtures.js";

const hashOf = (sid: string) => createHash("sha256").update(sid).digest("hex").slice(0, 12);
const OTHER = "5f0c1a2b-3c4d-4e5f-8a9b-ffffffffffff";

/** SessionStart of `sid` (the box's own by default) at `sec`, its gate pointed at the made-up checkout. */
function start(b: Box, sec: number, source: string, sid = b.sid): string {
  const gate = (input: unknown, dir: string, env?: NodeJS.ProcessEnv) => {
    const g = skillsGate(input, dir, env, T(sec));
    return g.ok ? { ok: true as const, ctx: { ...g.ctx, checkout: b.repo, repoKey: SHOP } } : g;
  };
  const tx = sid === b.sid ? b.tx : join(b.root, ".claude", "projects", "-home-dev-shop", `${sid}.jsonl`);
  const out = sessionStartSkills({ ...b.payload, session_id: sid, transcript_path: tx, hook_event_name: "SessionStart", source }, "/home/dev/shop", { ...b.env, TRAIL_TEST_NOW: iso(sec) }, { gate });
  return [out.context ?? "", out.notice ?? ""].join("\n");
}

/** The agent's own `trail skills add` with no yes: held by this session. */
function heldHere(b: Box): string {
  release(b, 0);
  const s = stop(b, 50);
  const r = add(b, 60, `trail skills add release-npm --run ${s.runId}`);
  assert.equal(r.cli?.held, "no-yes", JSON.stringify(r));
  assert.deepEqual(kept(b).held, ["release-npm"]);
  return "release-npm";
}

const shownAt = (b: Box) => listHeld(b.env, T(0)).find((h) => h.name === "release-npm")?.shownAt ?? null;

test("the held item keeps the hash of the session that held it", () => {
  const b = box();
  heldHere(b);
  const file = JSON.parse(readFileSync(join(b.env.TRAIL_HOME!, "held", "release-npm", "held.json"), "utf8"));
  assert.equal(file.session, hashOf(b.sid));
});

test("a compaction in the holding session says nothing and leaves it unshown; the next session's startup says it once", () => {
  const b = box();
  heldHere(b);
  assert.doesNotMatch(start(b, 70, "compact"), /release-npm/);
  assert.equal(shownAt(b), null, "the compaction did not spend it");
  assert.doesNotMatch(start(b, 75, "clear"), /release-npm/);
  assert.equal(shownAt(b), null);
  assert.match(start(b, 3600, "startup", OTHER), /started a skill release-npm in your last session/);
  assert.notEqual(shownAt(b), null);
  assert.doesNotMatch(start(b, 3700, "startup", OTHER), /release-npm/, "once");
});

test("a resume of the holding session says nothing; a resume of another session says it", () => {
  const b = box();
  heldHere(b);
  assert.doesNotMatch(start(b, 120, "resume"), /release-npm/);
  assert.equal(shownAt(b), null);
  assert.match(start(b, 3600, "resume", OTHER), /started a skill release-npm in your last session/);
});

test("a held item with no session (written before D93) is said at a startup, never at a compaction", () => {
  const b = box();
  saveHeld(releaseSkill({ trail: "s-0000a1" }, { name: "release-npm" }), "no-yes", { host: "claude", job: "release", repoKey: SHOP }, b.env, T(0));
  assert.doesNotMatch(start(b, 70, "compact"), /release-npm/);
  assert.match(start(b, 80, "startup"), /release-npm/);
});
