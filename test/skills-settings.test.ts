/**
 * `~/.trail/settings.json`: the one switch for learned skills, the offer
 * switches, pauses and the governor cache. Defaults when the file is missing
 * or broken; keys a later version adds survive every write; the test clock
 * works in a test home only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import {
  DEFAULT_SETTINGS, isTestHome, labInteractive, localDate, noteGovernor, noteSkillsStarted, offersHere, pauseRepo, readSettings, setOffers, setSkillOff, setSkills, skillsOn, trailNow,
} from "../src/skills/settings.js";
import { withLock } from "../src/util/private-fs.js";

const POSIX = process.platform !== "win32";

/** A sandbox: TRAIL_HOME of its own (so a test home). */
function sandbox(): { env: NodeJS.ProcessEnv; file: string; home: string } {
  const home = tmpRepo("settings");
  const trail = join(home, "trail-home");
  return { env: { HOME: home, TRAIL_HOME: trail }, file: join(trail, "settings.json"), home };
}
const onDisk = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

test("re-exports the test-home answers", () => {
  assert.equal(typeof isTestHome, "function");
  assert.equal(typeof labInteractive, "function");
});

test("defaults on a missing or broken file, and a copy each time: skills on", () => {
  const { env, file } = sandbox();
  assert.deepEqual(DEFAULT_SETTINGS, {
    v: 1, skills: "on", onSince: null, offers: "on", offersOffAt: null, offRepos: [], pausedUntil: {},
    skillsOff: [], lastNine: [], governorSaidAt: null,
  });
  assert.deepEqual(readSettings(env), DEFAULT_SETTINGS);
  const got = readSettings(env);
  got.offRepos.push("x");
  assert.deepEqual(DEFAULT_SETTINGS.offRepos, []);
  mkdirSync(join(file, ".."), { recursive: true });
  for (const bad of ["{nope", "[]", "null", "3", ""]) {
    writeFileSync(file, bad);
    assert.deepEqual(readSettings(env), DEFAULT_SETTINGS, bad);
  }
  assert.equal(skillsOn(env), true, "on by default");
});

test("only skills: off in the file turns them off", () => {
  const { env, file } = sandbox();
  mkdirSync(join(file, ".."), { recursive: true });
  for (const [skills, on] of [["off", false], ["on", true], [undefined, true], ["no", true]] as const) {
    writeFileSync(file, JSON.stringify({ v: 1, skills }));
    assert.equal(skillsOn(env), on, String(skills));
  }
});

test("noteSkillsStarted dates skills on by default once, and never turns them on or off", () => {
  const { env, file } = sandbox();
  const t1 = new Date("2026-10-20T09:12:00Z");
  noteSkillsStarted(env, t1);
  assert.equal(readSettings(env).onSince, t1.toISOString(), "the first session start with skills on dates them");
  noteSkillsStarted(env, new Date("2026-10-27T09:00:00Z"));
  assert.equal(readSettings(env).onSince, t1.toISOString(), "once");
  const off = sandbox();
  mkdirSync(join(off.file, ".."), { recursive: true });
  writeFileSync(off.file, JSON.stringify({ v: 1, skills: "off" }));
  const before = readFileSync(off.file, "utf8");
  noteSkillsStarted(off.env, t1);
  assert.equal(readFileSync(off.file, "utf8"), before, "skills off: nothing written");
  assert.equal(onDisk(file).skills, "on");
});

test("a field of the wrong shape falls back to its default; the rest is read", () => {
  const { env, file } = sandbox();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, skills: "yes", offers: "off", offRepos: "x", pausedUntil: { a: "2026-11-10", b: 3 }, skillsOff: ["a", 2], lastNine: ["yes", "maybe", "no"] }));
  const s = readSettings(env);
  assert.equal(s.skills, "on", "not \"off\", so the default");
  assert.equal(s.offers, "off");
  assert.deepEqual(s.offRepos, []);
  assert.deepEqual(s.pausedUntil, { a: "2026-11-10" });
  assert.deepEqual(s.skillsOff, ["a"]);
  assert.deepEqual(s.lastNine, ["yes", "no"]);
});

test("setSkills(true) turns skills on and sets onSince; again keeps it; files are private", () => {
  const { env, file } = sandbox();
  const t1 = new Date("2026-10-20T09:12:00Z");
  const s = setSkills(true, env, t1);
  assert.equal(s.skills, "on");
  assert.equal(s.onSince, t1.toISOString());
  assert.equal(skillsOn(env), true);
  assert.equal(setSkills(true, env, new Date("2026-10-22T09:00:00Z")).onSince, t1.toISOString(), "already on: not turned on now");
  const off = setSkills(false, env, new Date("2026-10-23T09:00:00Z"));
  assert.equal(off.skills, "off");
  const t2 = new Date("2026-10-25T09:00:00Z");
  assert.equal(setSkills(true, env, t2).onSince, t2.toISOString(), "turned on again");
  if (POSIX) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
  }
});

test("unknown keys survive every write", () => {
  const { env, file } = sandbox();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, skills: "off", later: { kept: true } }));
  setSkills(true, env, new Date("2026-10-20T09:00:00Z"));
  setOffers(false, "github.com/acme/shop", env);
  setSkillOff("ship-beta", true, env);
  pauseRepo("github.com/acme/shop", new Date(2026, 10, 10, 12), env);
  noteGovernor(["no"], null, env);
  assert.deepEqual(onDisk(file).later, { kept: true });
});

test("setOffers with a repo touches only offRepos; without one, the global switch and when", () => {
  const { env, file } = sandbox();
  setSkills(true, env, new Date("2026-10-20T09:00:00Z"));
  const before = onDisk(file);
  setOffers(false, "github.com/acme/shop", env, new Date("2026-10-21T09:00:00Z"));
  const after = onDisk(file);
  assert.deepEqual({ ...after, offRepos: before.offRepos }, before);
  assert.deepEqual(after.offRepos, ["github.com/acme/shop"]);
  setOffers(false, "github.com/acme/shop", env);
  assert.deepEqual(readSettings(env).offRepos, ["github.com/acme/shop"], "no duplicate");
  setOffers(true, "github.com/acme/shop", env);
  assert.deepEqual(readSettings(env).offRepos, []);

  const t = new Date("2026-10-22T08:00:00Z");
  const off = setOffers(false, null, env, t);
  assert.equal(off.offers, "off");
  assert.equal(off.offersOffAt, t.toISOString());
  const on = setOffers(true, null, env, new Date("2026-10-23T08:00:00Z"));
  assert.equal(on.offers, "on");
  assert.equal(on.offersOffAt, null);
});

test("setSkillOff adds and removes one name", () => {
  const { env } = sandbox();
  setSkillOff("ship-beta-then-prod", true, env);
  setSkillOff("ship-beta-then-prod", true, env);
  setSkillOff("release-npm", true, env);
  assert.deepEqual(readSettings(env).skillsOff, ["ship-beta-then-prod", "release-npm"]);
  setSkillOff("ship-beta-then-prod", false, env);
  assert.deepEqual(readSettings(env).skillsOff, ["release-npm"]);
});

test("pauseRepo stores a local date; noteGovernor keeps the last nine", () => {
  const { env } = sandbox();
  const until = new Date(2026, 10, 10, 23, 30);
  assert.deepEqual(pauseRepo("github.com/acme/shop", until, env).pausedUntil, { "github.com/acme/shop": "2026-11-10" });
  const ten: Array<"yes" | "no" | "none"> = ["yes", "no", "none", "no", "no", "none", "yes", "no", "no", "none"];
  const g = noteGovernor(ten, "2026-10-24T10:00:00Z", env);
  assert.deepEqual(g.lastNine, ten.slice(-9));
  assert.equal(g.governorSaidAt, "2026-10-24T10:00:00Z");
  assert.equal(noteGovernor(["yes"], null, env).governorSaidAt, null);
});

test("offersHere: off, off here, paused until a later day, else ok", () => {
  const { env } = sandbox();
  const key = "github.com/acme/shop";
  const today = new Date(2026, 9, 27, 10);
  assert.deepEqual(offersHere(key, today, env), { ok: true });
  pauseRepo(key, new Date(2026, 10, 10, 9), env);
  assert.deepEqual(offersHere(key, today, env), { ok: false, why: "paused" });
  assert.deepEqual(offersHere("github.com/acme/store", today, env), { ok: true });
  assert.deepEqual(offersHere(key, new Date(2026, 10, 10, 9), env), { ok: true }, "the pause ends on its day");
  setOffers(false, key, env);
  assert.deepEqual(offersHere(key, new Date(2026, 10, 12), env), { ok: false, why: "off-here" });
  setOffers(false, null, env);
  assert.deepEqual(offersHere("github.com/acme/store", today, env), { ok: false, why: "off" });
});

test("a setter on a settings file someone else is writing says so instead of losing the change", () => {
  const { env, file } = sandbox();
  setSkills(true, env, new Date("2026-10-20T09:00:00Z"));
  withLock(file, () => {
    assert.throws(() => setOffers(false, null, env), /busy/);
  });
  assert.equal(readSettings(env).offers, "on");
});

test("trailNow follows TRAIL_TEST_NOW in a test home only", () => {
  const fixed = "2026-10-27T10:44:05.000Z";
  const { env, home } = sandbox();
  assert.equal(trailNow({ ...env, TRAIL_TEST_NOW: fixed }).toISOString(), fixed);
  // A real home: $HOME/.trail, no lab marker.
  const real = { HOME: home, TRAIL_TEST_NOW: fixed };
  assert.notEqual(trailNow(real).toISOString(), fixed);
  assert.notEqual(trailNow({ ...real, TRAIL_HOME: join(home, ".trail") }).toISOString(), fixed);
  mkdirSync(join(home, ".trail-lab"));
  // A lab box: the marker in HOME, Trail's files in that HOME.
  assert.equal(trailNow({ ...real, TRAIL_HOME: join(home, ".trail") }).toISOString(), fixed);
  // A clock that can't be read is the real one.
  const t0 = Date.now();
  const bad = trailNow({ ...env, TRAIL_TEST_NOW: "soon" }).getTime();
  assert.ok(bad >= t0 && bad <= Date.now() + 5);
});

test("localDate is the calendar date where the person is", () => {
  assert.equal(localDate(new Date(2026, 0, 5, 0, 30)), "2026-01-05");
  assert.equal(localDate(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
  const at = new Date(2026, 9, 27, 23, 59);
  assert.equal(localDate(at.toISOString()), "2026-10-27");
});
