/**
 * Phase 1b's CLI surface (design 1.7): `trail skills lesson` (the CLI half
 * of a lesson save: no yes, no lesson; skills off says so), `trail skills
 * draft init-<n> --print` (init's pending skill compiled again, nothing
 * written), `trail skills keep <numbers>` pointing at `trail keep`, and
 * `trail forget` taking a skill lesson id, a learning id or a guardrail's
 * name before a skill's. In process through commander, sandbox Trail home,
 * made-up repos and commands only.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { registerSkillCommands, KEEP_NUMBERS_LINE } from "../src/skills/cli-skills.js";
import type { PersonDeps, PsRow } from "../src/skills/person.js";
import { savePersonal } from "../src/skills/store.js";
import { readLessons, writeLesson } from "../src/skills/lessons.js";
import { writeEveryRepo } from "../src/notes/every-repo.js";
import { guardrailLearning } from "../src/notes/guardrails.js";
import { parseNote } from "../src/notes/notes.js";
import { readInitRecord, updateInitRecord } from "../src/init/init-record.js";
import { lookBack } from "../src/init/look-back-mine.js";
import { LESSON_DENY } from "../src/skills/lesson-gate.js";
import { tmpRepo } from "./helpers.js";
import { compiled, SHOP } from "./skills-store-fixtures.js";
import { guardrailCandidate } from "./init-screen-fixtures.js";
import { day, done, releaseJob, testsJob, Tx, world } from "./init-mine-fixtures.js";

const NOW = "2026-10-29T15:00:00.000Z";
const rows = (...chain: Array<[string, string]>): PsRow[] => chain.map(([comm, args], i) => ({ pid: 4242 - i, ppid: i === chain.length - 1 ? 1 : 4241 - i, comm, args }));
const PERSON: PersonDeps = { stdinTTY: true, stdoutTTY: true, pid: 4242, ps: () => rows(["/usr/local/bin/node", "node /usr/local/bin/trail skills"], ["/bin/zsh", "-zsh"]) };
const AGENT: PersonDeps = { ...PERSON, stdinTTY: false };

interface Home { home: string; env: NodeJS.ProcessEnv; cwd: string }
/** Each sandbox's folder, removed when the file is done. */
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function sandbox(tag: string, skills: "on" | "off" = "on"): Home {
  const home = tmpRepo(`cli-1b-${tag}`);
  made.push(home);
  const env: NodeJS.ProcessEnv = { HOME: home, TRAIL_HOME: join(home, "trail-home"), TRAIL_TEST_NOW: NOW, PATH: process.env.PATH };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify(skills === "on" ? { v: 1, skills: "on", onSince: "2026-10-20T09:00:00.000Z" } : { v: 1, skills: "off" }));
  return { home, env, cwd: home };
}

interface Ran { code: number; out: string[]; err: string }
async function trail(h: Pick<Home, "env" | "cwd">, args: string[], person: PersonDeps = PERSON): Promise<Ran> {
  const program = new Command();
  const out: string[] = [];
  let err = "";
  let code = 0;
  program.exitOverride();
  program.configureOutput({ writeOut: (s) => out.push(s.replace(/\n$/, "")), writeErr: (s) => { err += s; } });
  registerSkillCommands(program, {
    env: h.env, cwd: () => h.cwd, personDeps: person,
    track: () => undefined, out: (l) => out.push(l), err: (l) => { err += `${l}\n`; }, exit: (c) => { code = c; },
  });
  try {
    await program.parseAsync(["node", "trail", ...args]);
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    code = e.exitCode;
  }
  return { code, out, err };
}

function saveSkill(h: Home, name: string) {
  const c = compiled(name, { trail: "s-0d0d0d" } as never, { source: { runId: `r-${name}`, commands: 23, failed: 4, at: "2026-10-27T10:44:05.000Z" } });
  return savePersonal(c, { from: "repeated", runId: `r-${name}`, consent: "offer-yes", stepsVerified: 2, env: h.env, now: new Date("2026-10-27T11:02:13.000Z") });
}

test("trail skills lesson: with no yes in the conversation nothing is kept (exit 1); skills off says so; --offer is required and given once", async () => {
  const h = sandbox("lesson");
  saveSkill(h, "release-npm");
  const r = await trail(h, ["skills", "lesson", "release-npm", "--offer", "o-1a2b3c4d"], AGENT);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(LESSON_DENY.noYes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 30)));
  assert.deepEqual(readLessons(join(h.env.TRAIL_HOME!, "skills", "release-npm")), []);
  const off = sandbox("lesson-off", "off");
  const o = await trail(off, ["skills", "lesson", "--offer", "o-1a2b3c4d"], AGENT);
  assert.equal(o.code, 1);
  assert.match(o.err, /Skills are off\. Turn them on with: trail skills on/);
  assert.notEqual((await trail(h, ["skills", "lesson", "release-npm"], AGENT)).code, 0, "--offer is required");
  assert.notEqual((await trail(h, ["skills", "lesson", "--offer", "o-1", "--offer", "o-2"], AGENT)).code, 0, "once");
});

test("trail skills keep <numbers> points at trail keep (R59)", async () => {
  const h = sandbox("keep-numbers");
  const r = await trail(h, ["skills", "keep", "1", "3"]);
  assert.equal(r.code, 1);
  assert.equal(r.err, `${KEEP_NUMBERS_LINE}\n`);
  assert.equal(KEEP_NUMBERS_LINE, "trail keep <numbers> keeps items from trail init.");
});

test("trail forget ls-<id> moves a skill lesson aside; an unknown lesson id is an error, never a skill", async () => {
  const h = sandbox("forget-ls");
  saveSkill(h, "release-npm");
  writeLesson({ id: "ls-4f2e1a", skill: "release-npm", at: "2026-10-28", text: "bump the version before npm publish", kind: "lesson", src: "correction", wall: null }, SHOP, h.env);
  const skillDir = join(h.env.TRAIL_HOME!, "skills", "release-npm");
  assert.equal(readLessons(skillDir).length, 1);
  const r = await trail(h, ["forget", "ls-4f2e1a"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out, ["✓ learning ls-4f2e1a forgotten · it no longer rides with release-npm"]);
  assert.deepEqual(readLessons(skillDir), []);
  assert.equal(readdirSync(join(skillDir, "lessons", ".forgotten")).length, 1, "moved, not deleted");
  assert.ok(existsSync(join(skillDir, "SKILL.md")), "the skill stays");
  const again = await trail(h, ["skills", "forget", "ls-4f2e1a"]);
  assert.equal(again.code, 1);
  assert.match(again.err, /no learning called ls-4f2e1a/);
});

test("trail forget l-<id> and trail forget no-timeout retire the learning (it stops loading; the file stays)", async () => {
  const h = sandbox("forget-l");
  const wall = writeLesson({ id: "", skill: null, at: "2026-10-28", text: "\"rootless Docker not found\": colima start", kind: "lesson", src: "repair", wall: "docker-rootless" }, SHOP, h.env);
  const id = parseNote(readFileSync(wall, "utf8"), wall)!.id!;
  const r = await trail(h, ["forget", id]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out[0]!, /^✓ learning forgotten: /);
  assert.equal(parseNote(readFileSync(wall, "utf8"), wall)!.status, "retired");
  assert.match((await trail(h, ["forget", id])).out[0]!, /was already forgotten/);

  const guard = writeEveryRepo(guardrailLearning("timeout-missing", "every repo", "\"timeout: command not found\" on 6 days", new Date(NOW)), "no-timeout.md", h.env);
  const g = await trail(h, ["forget", "no-timeout"]);
  assert.equal(g.code, 0, g.err);
  assert.match(g.out[0]!, /^✓ always-follow learning forgotten: /);
  assert.equal(parseNote(readFileSync(guard, "utf8"), guard)!.status, "retired");
  const none = await trail(h, ["forget", "no-timeout"]);
  assert.equal(none.code, 1, "a retired guardrail is not forgotten twice; the name falls through to skills");
  assert.equal((await trail(h, ["forget", "l-00000000"])).code, 1);
});

test("trail skills draft init-<n> --print shows init's pending skill compiled again and writes nothing; other items and numbers say why not", async () => {
  const w = world("cli-1b-draft");
  try {
    for (const [d, v] of [[1, "1.0.1"], [3, "1.0.3"], [5, "1.0.5"]] as const) {
      const tx = new Tx(w.repo);
      releaseJob(tx, d, v, { failedFirst: d !== 5 });
      testsJob(tx, d, { failedFirst: d !== 5, h: 11 });
      tx.write(w.home, `s-${d}`);
    }
    const env = { ...w.env, PATH: "/nonexistent", TRAIL_TEST_NOW: day(20) };
    const lb = lookBack(w.repo, { env, capMs: 60_000, skills: true, now: new Date(day(20)) });
    const skill = lb.candidates.find((x) => x.kind === "skill");
    assert.ok(skill, JSON.stringify(lb.candidates.map((x) => x.key)));
    updateInitRecord(SHOP, (r) => {
      r.pending = [{ ...skill, n: 1 }, { ...guardrailCandidate(), n: 2 }];
      r.pendingFrom = "ir-0001";
    }, env);
    const before = JSON.stringify(readInitRecord(SHOP, env));
    const h = { env, cwd: w.repo };
    const r = await trail(h, ["skills", "draft", "init-1", "--print"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.length > 2, r.out.join("\n"));
    assert.ok(r.out.some((l) => /npm publish|make release/.test(l)), r.out.join("\n"));
    assert.equal(existsSync(join(w.trail, "skills")), false, "nothing saved");
    assert.equal(JSON.stringify(readInitRecord(SHOP, env)), before, "the record unchanged");
    const g = await trail(h, ["skills", "draft", "init-2", "--print"]);
    assert.equal(g.code, 1);
    assert.match(g.err, /item 2 is an always-follow learning, not a skill/);
    const n = await trail(h, ["skills", "draft", "init-7", "--print"]);
    assert.equal(n.code, 1);
    assert.match(n.err, /no item 7 waits for an answer in this repo/);
  } finally {
    done(w);
  }
});

test("lesson id shapes are reserved: no skill is saved or named ls-<6 hex> or l-<hex> (D114 (2)); names that only start alike are fine", async () => {
  const { goodName } = await import("../src/skills/compile-words.js");
  const { checkSaveName } = await import("../src/skills/store-fs.js");
  for (const id of ["ls-4f2e1a", "l-1a2b3c4d", "l-0a0b0c"]) {
    assert.equal(goodName(id), false, id);
    assert.throws(() => checkSaveName(id), /not a skill name/, id);
  }
  for (const ok of ["ls-deploy", "l-release", "ls-4f2e1a-prod", "release-npm"]) assert.equal(goodName(ok), true, ok);
  const h = sandbox("reserved");
  assert.throws(() => saveSkill(h, "ls-4f2e1a"), /not a skill name/);
});

test("trail skills adds 2.12's lines: lessons per skill, out of date here, unused since, guardrails, errors here (30 days), the lesson count; --json carries them", async () => {
  const { checkout } = await import("./init-mine-fixtures.js");
  const { noteWalls } = await import("../src/trace/wall-state.js");
  const h = sandbox("report");
  const repo = checkout(join(h.home, "work", "shop"), "git@github.com:acme/shop.git");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "acme-shop", scripts: { lint: "eslint ." } }));
  const here = { env: h.env, cwd: repo };
  saveSkill(h, "release-npm");
  writeLesson({ id: "ls-4f2e1a", skill: "release-npm", at: "2026-10-28", text: "bump the version before npm publish", kind: "lesson", src: "correction", wall: null }, SHOP, h.env);
  writeLesson({ id: "", skill: null, at: "2026-10-20", text: "\"rootless Docker not found\": colima start", kind: "lesson", src: "repair", wall: "docker-rootless" }, SHOP, h.env);
  const old = compiled("report-users", { trail: "s-1a1a1a", applies: "github.com/acme/assign" } as never, { source: { runId: "r-old", commands: 5, failed: 0, at: "2026-07-30T10:00:00.000Z" } });
  savePersonal(old, { from: "repeated", runId: "r-old", consent: "offer-yes", stepsVerified: 2, env: h.env, now: new Date("2026-08-01T11:00:00.000Z") });
  writeEveryRepo(guardrailLearning("timeout-missing", "every repo", "\"timeout: command not found\" on 6 days", new Date(NOW)), "no-timeout.md", h.env);
  const seen = (d: string, epoch: number) => ({ cls: "docker-rootless" as const, d, sh: "a1b2c3d4e5f6", epoch, repo: SHOP, program: "go" });
  noteWalls({
    seen: [seen("2026-10-02", 0), seen("2026-10-09", 1), seen("2026-10-20", 2), seen("2026-08-01", 3)],
    fixed: [{ ...seen("2026-10-09", 1), delta: [{ kind: "env", name: "DOCKER_HOST" }] }, { ...seen("2026-10-20", 2), delta: [{ kind: "env", name: "DOCKER_HOST" }] }],
  }, h.env);

  const r = await trail(here, ["skills"]);
  assert.equal(r.code, 0, r.err);
  const text = r.out.join("\n");
  assert.match(text, /^release-npm +yours, in shop · .* · 1 learning · may be out of date: it runs npm run build, and package\.json has no build script now$/m);
  assert.match(text, /^report-users +yours, in assign · .* · unused since Aug 1 \(not in the list agents see; asking for it still brings it\)$/m);
  assert.doesNotMatch(text, /report-users.*may be out of date/, "another repo's skill is not checked here");
  const g = r.out.indexOf("always follow:");
  assert.ok(g > 0, text);
  assert.match(r.out[g + 1]!, /^ {2}no-timeout +every repo · stops `timeout N` while this Mac has no timeout$/);
  assert.ok(r.out.includes('errors Trail knows here (30 days): "rootless Docker not found" 3 times, fixed 2 times'), text);
  assert.ok(r.out.includes("new learnings: 2 (trail skills show <name> lists them)"), text);

  const j = JSON.parse((await trail(here, ["skills", "--json"])).out.join("\n"));
  const rel = j.skills.find((s: { name: string }) => s.name === "release-npm");
  assert.equal(rel.lessons, 1);
  assert.match(rel.outOfDate, /^it runs npm run build/);
  assert.equal(j.skills.find((s: { name: string }) => s.name === "report-users").unusedSince, "2026-08-01");
  assert.deepEqual(j.guardrails.map((x: { name: string; applies: string }) => [x.name, x.applies]), [["no-timeout", "every repo"]]);
  assert.deepEqual(j.errorsHere, [{ class: "docker-rootless", times: 3, fixed: 2 }]);
  assert.equal(j.lessons, 2);

  const show = await trail(here, ["skills", "show", "release-npm"]);
  assert.ok(show.out.includes("  New learning (the person, Oct 28): bump the version before npm publish"), show.out.join("\n"));
  // Elsewhere (no repo): no out-of-date check, no errors line.
  const away = await trail(h, ["skills"]);
  assert.doesNotMatch(away.out.join("\n"), /may be out of date|errors Trail knows here/);
});
