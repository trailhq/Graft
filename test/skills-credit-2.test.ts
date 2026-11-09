/**
 * Phase 2 at the credit flush (design 4.1, 4.9, R27): next-run fidelity on
 * the use line (counts and 8-hex shas, the same `where` at every flush, so the
 * same extra step in two uses gives one sha), firings for job and name cue
 * blocks (last 10, a not-followed one reported to the caller), and a skill
 * retired while its block was live changes no state. Made-up acme/shop.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { CheckHit, RunCall, RunState, SkillInjection } from "../src/trace/types.js";
import type { LedgerUse } from "../src/skills/types.js";
import { settleCredit, type Fired } from "../src/skills/credit.js";
import { forgetSkill, savePersonal } from "../src/skills/store.js";
import { getSkillState, updateSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { noteFiring } from "../src/skills/offer-retire.js";
import { at, emptyState, injection, runCall, runState } from "./trace-run-fixtures.js";
import { box, compiled, SHOP } from "./skills-store-fixtures.js";

const ID = "s-7f3a2c";
const NOW = new Date("2026-10-01T11:00:00.000Z");
const pass: CheckHit = { family: "npm-view", passed: true, facts: {} };
const homes: string[] = [];
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

let n = 0;
const call = (cmd: string, sec: number, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_f${++n}`, cmd, at: at(sec), ...extra });
const CHECK = (sec: number) => call("npm view acme-cli version", sec, { kind: "look", check: pass });

function setup() {
  const b = box("credit-2");
  homes.push(b.home);
  savePersonal(compiled("release-npm", { trail: ID }), { from: "repeated", runId: "r-0930-0001", consent: "offer-yes", stepsVerified: 2, env: b.env, now: NOW });
  return { env: b.env };
}
const inj = (extra: Partial<SkillInjection> = {}) => injection({
  at: at(100), runId: "r-1001-3f9a", params: { version: "1.4.3" }, steps: ["npm run build", "npm publish --access public"],
  gated: [{ step: 2, kind: "publish" }], check: "npm view acme-cli version", ...extra,
});
const run = (calls: RunCall[], extra: Partial<RunState> = {}) => runState({ id: "r-1001-3f9a", repoKey: SHOP, job: "release", closed: true, calls, ...extra });
const uses = (env: NodeJS.ProcessEnv) => readLedger(ID, env).filter((l): l is LedgerUse => l.event === "use");

function settle(env: NodeJS.ProcessEnv, calls: RunCall[], i: Partial<SkillInjection> = {}, now = NOW) {
  const fired: Fired[] = [];
  const st = emptyState({ injected: [inj(i)], runs: [run(calls)] });
  const out = settleCredit(st, { host: "claude", env, now, fired: (f) => fired.push(f) });
  return { out, fired, st };
}

test("fidelity on the use line: every step ran gives ran 2 and nothing else; the flushed use carries the same facts", () => {
  const { env } = setup();
  const { out } = settle(env, [call("npm run build", 110), call("npm publish --access public", 120), CHECK(130)]);
  const [use] = uses(env);
  assert.deepEqual(use!.fid, { ran: 2, missing: 0, extra: 0, changed: 0 });
  assert.deepEqual(use!.extraShas, []);
  assert.deepEqual(use!.changedSteps, []);
  assert.deepEqual(out[0]!.use.fid, use!.fid);
});

test("an extra passing step is counted and keyed by 8 hex, never its text; a failed step done another way is changed", () => {
  const { env } = setup();
  settle(env, [
    call("npm run build", 110), call("node scripts/pack-cli.mjs", 115), call("npm publish --access public", 120, { failed: true }),
    call("npm publish ./build/cli --access public", 125), CHECK(130),
  ]);
  const [use] = uses(env);
  assert.equal(use!.fid!.extra, 1);
  assert.equal(use!.fid!.changed, 1);
  assert.deepEqual(use!.changedSteps, [2]);
  assert.equal(use!.extraShas!.length, 1);
  assert.match(use!.extraShas![0]!, /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(readLedger(ID, env)).includes("pack-cli"));
});

test("the same extra step in two releases with two versions gives one sha (the same where at every flush)", () => {
  const { env } = setup();
  settle(env, [call("npm run build", 110), call("git push origin v1.4.3", 115), call("npm publish --access public", 120), CHECK(130)]);
  settle(env, [call("npm run build", 110), call("git push origin v1.4.4", 115), call("npm publish --access public", 120), CHECK(130)], { params: { version: "1.4.4" } },
    new Date("2026-10-02T11:00:00.000Z"));
  const [a, b] = uses(env);
  assert.equal(a!.extraShas!.length, 1);
  assert.deepEqual(a!.extraShas, b!.extraShas);
});

test("firings: a job or name cue's settled block is a firing, followed when a step ran; compact never; a failed ready probe never", () => {
  const { env } = setup();
  const steps = [call("npm run build", 110), CHECK(130)];
  const a = settle(env, steps);
  assert.deepEqual(a.fired.map((f) => [f.skillId, f.followed]), [[ID, true]]);
  assert.deepEqual(getSkillState(ID, env)!.firings!.map((f) => f.followed), [true]);
  settle(env, steps, { cue: "name", injId: "i-000002" });
  settle(env, steps, { cue: "compact", injId: "i-000003" });
  settle(env, steps, { cue: "check", injId: "i-000005" });
  settle(env, steps, { injId: "i-000004", readyFailed: ["git diff --quiet"] } as Partial<SkillInjection>);
  assert.deepEqual(getSkillState(ID, env)!.firings!.map((f) => f.followed), [true, true]);
});

test("a block nothing ran from is a not-followed firing: reported to the caller, no use line", () => {
  const { env } = setup();
  const { out, fired } = settle(env, [call("git status", 110, { kind: "look" })]);
  assert.deepEqual(out, []);
  assert.deepEqual(uses(env), []);
  assert.deepEqual(fired, [{ skillId: ID, name: "release-npm", followed: false, runId: "r-1001-3f9a", at: NOW.toISOString() }]);
  assert.deepEqual(getSkillState(ID, env)!.firings, [{ at: NOW.toISOString(), followed: false }]);
});

test("firings keep the last 10, oldest first; noteFiring writes nothing for a skill with no state or a retired one", () => {
  const { env } = setup();
  for (let k = 0; k < 12; k++) assert.equal(noteFiring(ID, k % 2 === 0, env, new Date(NOW.getTime() + k * 1000)), true);
  const f = getSkillState(ID, env)!.firings!;
  assert.equal(f.length, 10);
  assert.equal(f[0]!.at, new Date(NOW.getTime() + 2000).toISOString());
  assert.equal(noteFiring("s-000000", false, env, NOW), false);
  updateSkillState(ID, (s) => ({ ...s!, status: "retired" }), env);
  assert.equal(noteFiring(ID, false, env, NOW), false);
  assert.equal(getSkillState(ID, env)!.firings!.length, 10);
});

test("R27: a skill forgotten while its block was live: its flush writes the ledger line, changes no state, counts no firing", () => {
  const { env } = setup();
  const before = getSkillState(ID, env)!;
  assert.equal(forgetSkill("release-npm", env, NOW).ok, true);
  const retired = getSkillState(ID, env)!;
  const { out, fired } = settle(env, [call("npm run build", 110), call("npm publish --access public", 120), CHECK(130)]);
  assert.equal(uses(env).length, 1, "the ledger keeps what happened");
  assert.deepEqual(getSkillState(ID, env), retired);
  assert.equal(retired.uses, before.uses);
  assert.deepEqual(fired, []);
  assert.equal(out[0]!.state, undefined);
});

test("the use line of a skill with no SKILL.md to read has no fidelity facts, and still counts (fail open)", () => {
  const { env } = setup();
  rmSync(`${env.TRAIL_HOME}/skills/release-npm/SKILL.md`);
  settle(env, [call("npm run build", 110), CHECK(130)]);
  const [use] = uses(env);
  assert.equal(use!.fid, undefined);
  assert.equal(getSkillState(ID, env)!.uses, 1);
});
