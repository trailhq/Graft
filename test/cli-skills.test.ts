/**
 * `trail skills` and `trail forget` (design 1.7, 2.10): every command, its
 * exit code, the person-only refusals, `trail skills on`'s 3 lines byte for
 * byte, `--json`'s shape, forget and restore. In process through commander,
 * with a sandbox TRAIL_HOME (a test home, so TRAIL_TEST_NOW is the clock) and
 * the person check faked the way g4's tests do: CLAUDECODE=1, no TTY, a `ps`
 * stub. Synthetic data only (acme/shop, acme/webshop).
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { registerSkillCommands, KEEP_NUMBERS_LINE, OFFERS_OFF_LINE, SKILLS_ON_LINES, personOnly } from "../src/skills/cli-skills.js";
import type { PersonDeps, PsRow } from "../src/skills/person.js";
import { readSettings } from "../src/skills/settings.js";
import { saveHeld, savePersonal } from "../src/skills/store.js";
import { updateSkillState } from "../src/skills/state.js";
import { recordAnswer, recordShown } from "../src/skills/offers.js";
import { notePoolDay } from "../src/trace/pool.js";
import { compileRun } from "../src/skills/compile.js";
import { draftText } from "../src/skills/compile-words.js";
import { findPriorSheet, readRunSheet } from "../src/trace/runs.js";
import type { PendingOffer } from "../src/trace/types.js";
import { tmpRepo } from "./helpers.js";
import { compiled, SHOP } from "./skills-store-fixtures.js";
import * as consent from "./skills-consent-fixtures.js";

const WEBSHOP = "github.com/acme/webshop";
const NOW = "2026-10-29T15:00:00.000Z";

const rows = (...chain: Array<[string, string]>): PsRow[] => chain.map(([comm, args], i) => ({ pid: 4242 - i, ppid: i === chain.length - 1 ? 1 : 4241 - i, comm, args }));
const ME: Array<[string, string]> = [["/usr/local/bin/node", "node /usr/local/bin/trail skills"]];
const PERSON: PersonDeps = { stdinTTY: true, stdoutTTY: true, pid: 4242, ps: () => rows(...ME, ["/bin/zsh", "-zsh"]) };
/** Three ways an agent looks: Claude Code's variable, no terminal, the claude CLI above this process. */
const AGENTS: Array<[string, PersonDeps, Record<string, string>]> = [
  ["CLAUDECODE=1", PERSON, { CLAUDECODE: "1" }],
  ["no TTY", { ...PERSON, stdinTTY: false }, {}],
  ["a claude ancestor", { ...PERSON, ps: () => rows(...ME, ["/bin/zsh", "zsh -c trail skills"], ["/opt/homebrew/bin/claude", "claude"]) }, {}],
];

interface Home { home: string; env: NodeJS.ProcessEnv; cwd: string }
function sandbox(tag: string, skills: "on" | "off" = "on"): Home {
  const home = tmpRepo(`cli-skills-${tag}`);
  const env: NodeJS.ProcessEnv = { HOME: home, TRAIL_HOME: join(home, "trail-home"), TRAIL_TEST_NOW: NOW, PATH: process.env.PATH };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify(skills === "on" ? { v: 1, skills: "on", onSince: "2026-10-20T09:00:00.000Z" } : { v: 1, skills: "off" }));
  return { home, env, cwd: home };
}

interface Ran { code: number; out: string[]; err: string; events: Array<[string, Record<string, string>]> }
async function trail(h: Pick<Home, "env" | "cwd">, args: string[], person: PersonDeps = PERSON, extraEnv: Record<string, string> = {}): Promise<Ran> {
  const program = new Command();
  const out: string[] = [];
  let err = "";
  let code = 0;
  const events: Ran["events"] = [];
  program.exitOverride();
  program.configureOutput({ writeOut: (s) => out.push(s.replace(/\n$/, "")), writeErr: (s) => { err += s; } });
  registerSkillCommands(program, {
    env: { ...h.env, ...extraEnv }, cwd: () => h.cwd, personDeps: person,
    track: (e, p) => events.push([e, p]), out: (l) => out.push(l), err: (l) => { err += `${l}\n`; }, exit: (c) => { code = c; },
  });
  try {
    await program.parseAsync(["node", "trail", ...args]);
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    code = e.exitCode;
  }
  return { code, out, err, events };
}

const settingsText = (h: Home) => {
  const p = join(h.env.TRAIL_HOME!, "settings.json");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

function saveSkill(h: Home, name: string, meta: Record<string, string>, at = "2026-10-27T11:02:13.000Z") {
  const c = compiled(name, meta as never, { source: { runId: `r-${name}`, commands: 23, failed: 4, at: "2026-10-27T10:44:05.000Z" } });
  return savePersonal(c, { from: "repeated", runId: `r-${name}`, consent: "offer-yes", stepsVerified: 2, env: h.env, now: new Date(at) });
}

// --- trail skills on / off ---

test("trail skills on, by the person: the 3 lines word for word, exit 0, skills on since now", async () => {
  const h = sandbox("on", "off");
  const r = await trail(h, ["skills", "on"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out, [...SKILLS_ON_LINES]);
  assert.equal(r.out.join("\n"), [
    "✓ skills on · Trail now counts jobs you ask for on more than one day: job words and dates only, kept on this machine, nothing uploaded.",
    "  When one checks out on its 3rd day, it offers once to keep the commands that worked (at most 1 offer per session, 3 a week).",
    "  See what it counts: trail skills · stop offers: trail skills offers off · all off: trail skills off",
  ].join("\n"));
  const s = readSettings(h.env);
  assert.equal(s.skills, "on");
  assert.equal(s.onSince, NOW);
});

for (const [how, person, env] of AGENTS) {
  test(`person-only commands run by an agent (${how}) are refused, exit 1, and change nothing`, async () => {
    const h = sandbox(`agent-${how.replace(/\W+/g, "-")}`, "off");
    const before = settingsText(h);
    for (const [args, command] of [
      [["skills", "on"], "skills on"], [["skills", "on", "release-npm"], "skills on release-npm"], [["skills", "offers", "on"], "skills offers on"],
      [["skills", "keep", "deploy-preview-2"], "skills keep deploy-preview-2"],
    ] as Array<[string[], string]>) {
      const r = await trail(h, args, person, env);
      assert.equal(r.code, 1, `${command}: ${r.out}`);
      assert.equal(r.err, `${personOnly(command)}\n`);
      assert.equal(r.err, `Only the person can run this, in their own terminal: trail ${command}\n`);
      assert.deepEqual(r.out, []);
    }
    assert.equal(settingsText(h), before, "settings.json untouched");
  });
}

test("trail skills off is open to anyone; one skill off and on again; an unknown name exits 1", async () => {
  const h = sandbox("off");
  saveSkill(h, "release-npm", { applies: SHOP });
  const [how, agent, env] = AGENTS[0]!;
  const off1 = await trail(h, ["skills", "off", "release-npm"], agent, env);
  assert.equal(off1.code, 0, how);
  assert.deepEqual(off1.out, ["✓ release-npm off: it stops reaching the agent · turn it back on: trail skills on release-npm"]);
  assert.deepEqual(readSettings(h.env).skillsOff, ["release-npm"]);
  const on1 = await trail(h, ["skills", "on", "release-npm"]);
  assert.deepEqual(on1.out, ["✓ release-npm on: it reaches the agent again · turn it off: trail skills off release-npm"]);
  assert.deepEqual(readSettings(h.env).skillsOff, []);
  const nope = await trail(h, ["skills", "off", "nope"]);
  assert.equal(nope.code, 1);
  assert.equal(nope.err, "✗ no skill called nope · trail skills lists them\n");
  const all = await trail(h, ["skills", "off"], agent, env);
  assert.equal(all.code, 0);
  assert.deepEqual(all.out, ["✓ skills off: Trail stops counting jobs, offering skills and bringing them back · turn on again: trail skills on"]);
  assert.equal(readSettings(h.env).skills, "off");
});

// --- offers ---

test("trail skills offers off: the exact line, skill_answer{off}, and on again by the person", async () => {
  const h = sandbox("offers");
  const off = await trail(h, ["skills", "offers", "off"], AGENTS[0]![1], AGENTS[0]![2]);
  assert.equal(off.code, 0);
  assert.deepEqual(off.out, [OFFERS_OFF_LINE]);
  assert.equal(OFFERS_OFF_LINE, "Skill offers are off. Turn them back on: trail skills offers on");
  assert.deepEqual(off.events, [["skill_answer", { answer: "off" }]]);
  assert.equal(readSettings(h.env).offers, "off");
  assert.equal(readSettings(h.env).offersOffAt, NOW);
  const on = await trail(h, ["skills", "offers", "on"]);
  assert.deepEqual(on.out, ["✓ skill offers on · stop them: trail skills offers off"]);
  assert.equal(readSettings(h.env).offers, "on");
  const bad = await trail(h, ["skills", "offers", "maybe"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /value 'maybe' is invalid for argument 'state'\. Allowed choices are on, off/);
});

test("trail skills offers off --here: just this repo's key; outside a repo it exits 1", async () => {
  const h = sandbox("offers-here");
  const repo = join(h.home, "src", "webshop");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/webshop.git\n');
  const off = await trail({ env: h.env, cwd: repo }, ["skills", "offers", "off", "--here"]);
  assert.equal(off.code, 0, off.err);
  assert.deepEqual(off.out, ["Skill offers are off in webshop. Turn them back on: trail skills offers on --here"]);
  assert.deepEqual(readSettings(h.env).offRepos, [WEBSHOP]);
  assert.equal(readSettings(h.env).offers, "on");
  const on = await trail({ env: h.env, cwd: repo }, ["skills", "offers", "on", "--here"]);
  assert.deepEqual(on.out, ["✓ skill offers on in webshop · stop them: trail skills offers off --here"]);
  assert.deepEqual(readSettings(h.env).offRepos, []);
  const nowhere = await trail(h, ["skills", "offers", "off", "--here"]);
  assert.equal(nowhere.code, 1);
  assert.equal(nowhere.err, "✗ --here needs a repo: run it inside the repo\n");
});

// --- keep ---

test("trail skills keep: numbers belong to trail keep; the person keeps a held skill once; unknown exits 1", async () => {
  const h = sandbox("keep");
  for (const args of [["1"], ["1", "3"]]) {
    const r = await trail(h, ["skills", "keep", ...args]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `${KEEP_NUMBERS_LINE}\n`);
    assert.equal(KEEP_NUMBERS_LINE, "trail keep <numbers> keeps items from trail init.");
  }
  saveHeld(compiled("deploy-preview", { trail: "s-0d0d0d" }), "no-yes", { host: "claude", job: "release", repoKey: SHOP }, h.env, new Date(NOW));
  const kept = await trail(h, ["skills", "keep", "deploy-preview"]);
  assert.equal(kept.code, 0, kept.err);
  assert.deepEqual(kept.out, ["✓ kept deploy-preview as one of your skills · undo: trail forget deploy-preview"]);
  assert.deepEqual(kept.events, [["skill_saved", { from: "asked", scope: "personal" }]]);
  assert.ok(existsSync(join(h.env.TRAIL_HOME!, "skills", "deploy-preview", "SKILL.md")));
  const again = await trail(h, ["skills", "keep", "deploy-preview"]);
  assert.equal(again.code, 1);
  assert.match(again.err, /^✗ nothing held called deploy-preview: a held skill can be kept for 24 hours after Trail shows it/);
  assert.equal((await trail(h, ["skills", "keep", "a", "b"])).code, 1);
});

// --- forget and restore ---

test("forget and restore round trip: trail forget, the list without it, restore brings its status back", async () => {
  const h = sandbox("forget");
  const ref = saveSkill(h, "release-npm", { applies: SHOP });
  updateSkillState(ref.id, (s) => ({ ...s!, status: "active", uses: 2, checkedUses: 2, lastWorked: "2026-10-29" }), h.env);
  const f = await trail(h, ["forget", "release-npm"], AGENTS[0]![1], AGENTS[0]![2]);
  assert.equal(f.code, 0, f.err);
  assert.deepEqual(f.out, ["✓ release-npm forgotten · bring it back: trail skills restore release-npm"]);
  assert.doesNotMatch((await trail(h, ["skills"])).out.join("\n"), /release-npm/);
  assert.equal((await trail(h, ["skills", "forget", "release-npm"])).code, 1, "already forgotten");
  const back = await trail(h, ["skills", "restore", "release-npm"]);
  assert.equal(back.code, 0, back.err);
  assert.deepEqual(back.out, ["✓ release-npm is back · forget it again: trail forget release-npm"]);
  assert.match((await trail(h, ["skills"])).out[0]!, /^release-npm {3}yours, in shop · active v1 · used 2, checked 2 · last worked Oct 29$/);
  const twice = await trail(h, ["skills", "restore", "release-npm"]);
  assert.equal(twice.code, 1);
  assert.equal(twice.err, "✗ no forgotten skill called release-npm\n");
  // The same through `trail skills forget`.
  assert.deepEqual((await trail(h, ["skills", "forget", "release-npm"])).out, ["✓ release-npm forgotten · bring it back: trail skills restore release-npm"]);
  assert.equal((await trail(h, ["forget", "nope"])).err, "✗ no skill called nope · trail skills lists them\n");
});

// --- the list (2.10) and --json ---

function offerFor(id: string, at: string, h: Home, answer?: "yes" | "no"): void {
  const o = { offerId: id, moment: "repeated", runId: `r-${id}`, name: "x", key: `${SHOP}|job:release`, lines: ["a", "b"], channel: "stop" } as unknown as PendingOffer;
  recordShown(o, SHOP, h.env, new Date(at));
  if (answer) recordAnswer(o, SHOP, answer, h.env, new Date(at));
}

function fullHome(): Home {
  const h = sandbox("list");
  const ship = saveSkill(h, "ship-beta-then-prod", { trail: "s-111111", applies: WEBSHOP, job: "ship" });
  updateSkillState(ship.id, (s) => ({ ...s!, status: "active", uses: 2, checkedUses: 2, lastWorked: "2026-10-29" }), h.env);
  saveSkill(h, "release-npm", { trail: "s-222222", applies: "github.com/acme/trail-code" });
  const fix = saveSkill(h, "deploy-preview", { trail: "s-333333", applies: SHOP });
  updateSkillState(fix.id, (s) => ({ ...s!, status: "needs-fix", prevStatus: "active", statusWhy: "step 2 failed on Oct 25 and Oct 28" }), h.env);
  saveHeld(compiled("deploy-preview-2", { trail: "s-444444" }), "no-yes", { host: "claude", job: "release", repoKey: SHOP }, h.env, new Date(NOW));
  for (const [i, d] of ["2026-10-24", "2026-10-27"].entries()) notePoolDay(WEBSHOP, { job: "report", words: ["report"] }, { d, s: `s${i}`, costly: true }, null, h.env, new Date(NOW));
  notePoolDay(SHOP, { job: "tests", words: ["tests"] }, { d: "2026-10-28", s: "s9", costly: false }, null, h.env, new Date(NOW));
  offerFor("o-000001", "2026-10-27T10:00:00.000Z", h, "yes");
  return h;
}

test("trail skills: each skill with its scope in words and status, held items, what it watches, the offers and skills lines", async () => {
  const h = fullHome();
  const r = await trail(h, ["skills"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out, [
    "deploy-preview        yours, in shop · needs a fix: step 2 failed on Oct 25 and Oct 28 · not used until fixed",
    "release-npm           yours, in trail-code · candidate v1 · saved Oct 27 from a run of 23 commands, 4 failed",
    "ship-beta-then-prod   yours, in webshop · active v1 · used 2, checked 2 · last worked Oct 29",
    "held, not kept: deploy-preview-2 (started without your yes) · keep it: trail skills keep deploy-preview-2",
    "watching: report in webshop, 2 of 3 days · tests in shop, 1 of 3 days",
    "offers: on · at most 1 per session, 3 a week · 1 this week, 1 kept · stop them: trail skills offers off",
    "skills: on since Oct 20 · turn off: trail skills off",
  ]);
});

test("trail skills: nothing yet, offers off since a day, off in a repo, skills off", async () => {
  const h = sandbox("empty", "off");
  assert.deepEqual((await trail(h, ["skills"])).out, ["no skills yet", "offers: on · at most 1 per session, 3 a week · none this week · stop them: trail skills offers off", "skills: off · turn on: trail skills on"]);
  await trail(h, ["skills", "offers", "off"]);
  assert.equal((await trail(h, ["skills"])).out[1], "offers: off since Oct 29 · turn back on: trail skills offers on");
  writeFileSync(join(h.env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "on", offers: "on", offRepos: [WEBSHOP] }));
  assert.match((await trail(h, ["skills"])).out[1]!, /^offers: on, off in webshop · /);
  rmSync(join(h.env.TRAIL_HOME!, "settings.json"));
  assert.equal((await trail(h, ["skills"])).out.at(-1), "skills: on · turn off: trail skills off", "on by default, with no settings file");
});

test("trail skills: a skill whose step the risk rules refuse now (edited by hand) needs a fix and is not used", async () => {
  const h = sandbox("refused");
  const ref = saveSkill(h, "release-npm", { applies: SHOP });
  writeFileSync(ref.file, readFileSync(ref.file, "utf8").replace("npm run build", "sudo npm run build"));
  const line = (await trail(h, ["skills"])).out[0]!;
  assert.match(line, /^release-npm {3}yours, in shop · needs a fix: step 1 runs sudo/);
  assert.match(line, / · not used until fixed$/);
});

test("trail skills --json: the same facts as one object", async () => {
  const h = fullHome();
  const r = await trail(h, ["skills", "--json"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out.join("\n"));
  assert.deepEqual(Object.keys(j).sort(), ["errorsHere", "governor", "guardrails", "held", "lessons", "offers", "settings", "skills", "value", "watching"]);
  assert.deepEqual(j.skills.map((s: { name: string }) => s.name), ["deploy-preview", "release-npm", "ship-beta-then-prod"]);
  assert.deepEqual(Object.keys(j.skills[0]).sort(), ["addedAt", "applies", "checkedUses", "id", "lastWorked", "lessons", "name", "off", "outOfDate", "refused", "scope", "source", "status", "statusWhy", "unusedSince", "uses", "version"]);
  const ship = j.skills[2];
  assert.deepEqual([ship.scope, ship.applies, ship.status, ship.uses, ship.checkedUses, ship.lastWorked], ["personal", WEBSHOP, "active", 2, 2, "2026-10-29"]);
  assert.deepEqual(j.held.map((x: { name: string; why: string }) => [x.name, x.why]), [["deploy-preview-2", "no-yes"]]);
  assert.deepEqual(j.watching, [{ job: "report", repo: WEBSHOP, sessionDays: 2, need: 3 }, { job: "tests", repo: SHOP, sessionDays: 1, need: 3 }]);
  assert.deepEqual(j.offers, { on: true, offSince: null, offIn: [], perSession: 1, perWeek: 3, thisWeek: 1, kept: 1 });
  assert.equal(j.governor, null);
  assert.deepEqual(j.settings, { skills: "on", onSince: "2026-10-20T09:00:00.000Z" });
  assert.equal(JSON.stringify(j).includes("—"), false);
});

test("the governor line comes once under offers, while the governor is on", async () => {
  const h = sandbox("governor");
  for (const [i, a] of (["no", "no", "no"] as const).entries()) offerFor(`o-00000${i}`, `2026-10-1${i}T10:00:00.000Z`, h, a);
  const first = (await trail(h, ["skills"])).out;
  assert.equal(first[2], "you kept fewer than 1 in 3 offers lately, so a job now has to come back a 4th day before Trail offers it");
  assert.ok(!(await trail(h, ["skills"])).out.some((l) => l.startsWith("you kept fewer")), "said once");
});

// --- show and draft ---

test("trail skills show: SKILL.md and its state line; a held one with how to keep it; unknown exits 1", async () => {
  const h = fullHome();
  const r = await trail(h, ["skills", "show", "ship-beta-then-prod"]);
  assert.equal(r.code, 0, r.err);
  const text = r.out.join("\n");
  assert.ok(text.startsWith("---\nname: ship-beta-then-prod\n"), text.slice(0, 80));
  assert.ok(text.endsWith("\n\n· yours, in webshop · active v1 · used 2, checked 2 · last worked Oct 29"), text.slice(-120));
  const held = (await trail(h, ["skills", "show", "deploy-preview-2"])).out.join("\n");
  assert.ok(held.endsWith("· held, not kept: deploy-preview-2 (started without your yes) · keep it: trail skills keep deploy-preview-2"));
  const nope = await trail(h, ["skills", "show", "../ship-beta-then-prod"]);
  assert.equal(nope.code, 1);
  assert.equal(nope.err, "✗ no skill called ../ship-beta-then-prod · trail skills lists them\n");
});

test("trail skills draft: prints what an offer would keep and writes nothing; without --print, or for an unknown run, exit 1", async () => {
  const b = consent.box();
  consent.release(b, 0);
  const runId = consent.stop(b, 50).runId!;
  const h = { env: { ...b.env, TRAIL_TEST_NOW: consent.iso(60) }, cwd: b.repo };
  const r = await trail(h, ["skills", "draft", runId, "--print"]);
  assert.equal(r.code, 0, r.err);
  const sheet = readRunSheet(runId, b.env)!;
  const c = compileRun(sheet, {
    repoRoot: b.repo, home: b.env.HOME!, platform: process.platform, prior: findPriorSheet(sheet, b.env), moment: "repeated", applies: sheet.repoKey,
    now: consent.T(60), readSheet: (id) => readRunSheet(id, b.env), taken: () => false,
  });
  assert.ok(c.ok);
  assert.equal(r.out.join("\n"), draftText(c.skill, sheet));
  assert.match(r.out[0]!, /^release-npm · copied from the run that just worked/);
  assert.deepEqual(consent.kept(b), { skills: [], held: [] }, "writes nothing");
  const bare = await trail(h, ["skills", "draft", runId]);
  assert.equal(bare.code, 1);
  assert.equal(bare.err, `✗ use --print: trail skills draft ${runId} --print\n`);
  const gone = await trail(h, ["skills", "draft", "r-1027-dead", "--print"]);
  assert.equal(gone.code, 1);
  assert.equal(gone.err, "✗ no run called r-1027-dead (runs are kept 7 days)\n");
});

// --- add ---

test("trail skills add: g5's CLI half, its lines and exit code, and skill_saved from what it saved", async () => {
  const b = consent.box();
  const { offer } = consent.offered(b, 0);
  consent.prompt(b, 70, "yes");
  const hook = consent.add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`, { skipCli: true });
  assert.equal(hook.decision, null);
  const h = { env: { ...b.env, TRAIL_TEST_NOW: consent.iso(81) }, cwd: b.repo };
  const r = await trail(h, ["skills", "add", offer.name, "--run", offer.runId], AGENTS[0]![1], AGENTS[0]![2]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out[0]!, new RegExp(`^✓ saved ${offer.name}, just for you in this repo · 2 steps and its check, each one ran here at 10:00 today$`));
  assert.match(r.out[1]!, /^Tell the person what Trail kept: Saved /);
  assert.deepEqual(r.events, [["skill_saved", { from: "repeated", scope: "personal" }]]);
  assert.deepEqual(consent.kept(b).skills, [offer.name]);
  // Skills off: the CLI half's own refusal, exit 1, no event.
  writeFileSync(join(b.env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "off" }));
  const off = await trail(h, ["skills", "add", "other", "--run", offer.runId]);
  assert.equal(off.code, 1);
  assert.equal(off.err, "Skills are off. Turn them on with: trail skills on\n");
  assert.deepEqual(off.events, []);
});

test("trail skills add with any flag but --run is a commander error: nothing saved, nothing sent", async () => {
  const b = consent.box();
  const { offer } = consent.offered(b, 0);
  consent.prompt(b, 70, "yes");
  const h = { env: { ...b.env, TRAIL_TEST_NOW: consent.iso(81) }, cwd: b.repo };
  for (const extra of [["--from", "taught"], ["--force"], ["--yes"], ["--to", "team"], ["--json"], ["--run", "r-other"]]) {
    const r = await trail(h, ["skills", "add", offer.name, "--run", offer.runId, ...extra]);
    if (extra[0] === "--json") assert.equal(r.err, "error: unknown option '--json'\n");
    assert.equal(r.code, 1, extra.join(" "));
    assert.match(r.err, /^error: /, extra.join(" "));
    assert.deepEqual(r.out, []);
    assert.deepEqual(r.events, []);
  }
  assert.equal((await trail(h, ["skills", "--json", "add", offer.name, "--run", offer.runId])).code, 1, "a parent's flag before add");
  assert.equal((await trail(h, ["skills", "add", offer.name])).code, 1, "--run is required");
  assert.equal((await trail(h, ["skills", "add", offer.name, "extra", "--run", offer.runId])).code, 1, "one name only");
  assert.deepEqual(consent.kept(b), { skills: [], held: [] });
});

// --- through the real binary: the real person check, help, and the takeaway commands gone ---

function real(args: string[], home: string, extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, "trail-home"), DO_NOT_TRACK: "1", TRAIL_INVOKED_AS: undefined, TRAIL_CLOUD: undefined, ...extra },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("the real binary: an agent's trail skills on is refused by the real person check; offers off works for anyone", () => {
  const h = sandbox("real", "off");
  const before = settingsText(h);
  const on = real(["skills", "on"], h.home, { CLAUDECODE: "1" });
  assert.equal(on.status, 1, on.err);
  assert.match(on.err, /^Only the person can run this, in their own terminal: trail skills on$/m);
  assert.equal(on.out, "");
  assert.equal(settingsText(h), before);
  const off = real(["skills", "offers", "off"], h.home, { CLAUDECODE: "1" });
  assert.equal(off.status, 0, off.err);
  assert.equal(off.out, `${OFFERS_OFF_LINE}\n`);
});

test("trail --help lists skills under Learnings; trail skills --help lists its commands, and the takeaway ones are gone", () => {
  const h = sandbox("help");
  const help = real(["--help"], h.home);
  assert.equal(help.status, 0, help.err);
  const learnings = help.out.slice(help.out.indexOf("Learnings:"), help.out.indexOf("Setup:"));
  assert.match(learnings, /^ {2}skills .*the steps that worked/m);
  assert.doesNotMatch(help.out, /^ {2}forget /m, "trail forget is the undo, listed under trail skills");
  const sub = real(["skills", "--help"], h.home);
  assert.equal(sub.status, 0, sub.err);
  for (const c of ["show", "draft", "add", "keep", "forget", "restore", "offers", "on", "off"]) assert.match(sub.out, new RegExp(`^ {2}${c}\\b`, "m"), c);
  for (const gone of ["fold", "publish", "confirm"]) {
    assert.doesNotMatch(sub.out, new RegExp(`^ {2}${gone}\\b`, "m"), gone);
    assert.notEqual(real(["skills", gone, "deploys"], h.home).status, 0, `trail skills ${gone} is gone`);
  }
  assert.doesNotMatch(sub.out, /—|\b(?:notes?|rules?|memory|remember|workflows?)\b/i);
});
