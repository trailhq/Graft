/**
 * Part 7: learnings and skills never repeat or contradict each other in what
 * the agent hears. Which learnings count (live ones only), how a save
 * follows them and names it in one line, how a run block says each once,
 * and how the update offer proposes the change. Made-up acme/shop only.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRun, type CompileOpts } from "../src/skills/compile.js";
import { skillSha } from "../src/skills/offer-moment.js";
import { parseSkillMd, renderSkillMd } from "../src/skills/skillmd.js";
import { callKind } from "../src/trace/checks.js";
import { renderNote, type Note } from "../src/notes/notes.js";
import { writeEveryRepo } from "../src/notes/every-repo.js";
import { repoNotesDir } from "../src/notes/repo-notes-dir.js";
import { runBlock } from "../src/skills/runblock.js";
import {
  followAtSave, markLines, onlyRepeats, recallMarks, saidIn, stepLearningOf, stepLearnings, withFixes, withFollowLine, type StepLearning,
} from "../src/skills/follow-learnings.js";
import type { RunCall, RunSheet } from "../src/trace/types.js";
import { cand } from "./skills-recall-fixtures.js";
import { box, SHOP } from "./skills-store-fixtures.js";
import { rmSync } from "node:fs";

const homes: string[] = [];
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

let seq = 0;
const call = (cmd: string, o: Partial<RunCall> = {}): RunCall => {
  seq++;
  return { id: `toolu_f${seq}`, at: new Date(Date.UTC(2026, 9, 27, 10, 0, 0) + seq * 20_000).toISOString(), cmd, key: SHOP, cwd: "", bg: false, failed: false,
    isError: false, kind: callKind(cmd, "tests"), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...o };
};
/** The test suite, the way the person's agent ran it: a failed run first, then install, build and the passing suite. */
function testsSheet(cmds = ["npm ci", "npm run build"], check = "npm test"): RunSheet {
  const calls = [call(check, { failed: true, isError: true, errorLine: "Tests: 1 failed" }), ...cmds.map((c) => call(c)),
    call(check, { check: { family: "tests", passed: true, facts: { passedCount: 12 } } })];
  return {
    v: 1, id: "r-1027-7c1d", session: "e76b4ca7f1a0", repoKey: SHOP, branch: "main", host: "claude", tier: "A", epoch: 0,
    startedAt: calls[0]!.at, endedAt: calls.at(-1)!.at, job: "tests", jobWords: ["test"], sharedWords: [], promptParams: {}, calls,
    checkIndex: calls.length - 1, checked: true, end: "done", counts: { commands: calls.length, failed: 1, toolCalls: calls.length, edits: 0 }, helpers: [], skillId: null,
  };
}
const OPTS: CompileOpts = { repoRoot: "/home/dev/shop", home: "/home/dev", platform: "linux", moment: "repeated", applies: SHOP, taken: () => false, name: "run-tests" };
const learning = (title: string, o: Partial<Note> = {}): StepLearning => stepLearningOf({ id: "l-1a2b3c4d", kind: "preference", scope: "personal", title, body: title, ...o })!;
const PNPM = learning("use pnpm, not npm");
const SCHEMA = learning("don't edit _schema.py by hand, run scripts/gen_schema.py");

function compiled(sheet: RunSheet, ls: StepLearning[] = []) {
  const r = compileRun(sheet, { ...OPTS, learnings: ls });
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}

/* ------------------------------------------------------------ which learnings count */

function note(dir: string, file: string, title: string, o: Partial<Note> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), renderNote({ title, author: "", date: "2026-10-20", touches: [], body: title, id: "l-00000000", ...o }));
}

test("only live learnings count: retired, replaced, held and lesson ones never do, nor another repo's", () => {
  const b = box("follow-live");
  homes.push(b.home);
  const mine = repoNotesDir(SHOP, b.env);
  note(mine, "a.md", "use pnpm, not npm", { id: "l-aaaaaaa1", kind: "preference", applies: SHOP });
  note(mine, "b.md", "never run npx prisma db push", { id: "l-aaaaaaa2", kind: "decision", status: "retired" });
  note(mine, "c.md", "use yarn, not npm", { id: "l-aaaaaaa3", kind: "preference", date: "2026-10-01" });
  note(mine, "d.md", "use bun, not npm", { id: "l-aaaaaaa4", kind: "preference", date: "2026-10-02", replaces: "l-aaaaaaa3" });
  note(mine, "e.md", "don't use npx", { id: "l-aaaaaaa5", kind: "preference", status: "held" });
  note(mine, "f.md", "never run make deploy", { id: "l-aaaaaaa6", kind: "lesson" });
  note(mine, "g.md", "never run make clean", { id: "l-aaaaaaa7", kind: "preference", applies: "github.com/acme/other" });
  note(mine, "h.md", "The staging database is read-only on Fridays.", { id: "l-aaaaaaa8", kind: "decision" });
  note(join(b.checkout, ".trail", "learnings"), "r.md", "always run make lint before git push", { id: "l-bbbbbbb1", kind: "decision" });
  writeEveryRepo({ title: "run `pytest -q` instead of `npm test`", body: "run `pytest -q` instead of `npm test`", author: "", date: "2026-10-20", kind: "preference" }, "pref-pytest.md", b.env);
  const got = stepLearnings({ repoKeys: [SHOP], checkout: b.checkout, env: b.env });
  assert.deepEqual(got.map((l) => [l.quote, l.kind, l.scope]).sort(), [
    ["always run make lint before git push", "decision", "repo"],
    ["run `pytest -q` instead of `npm test`", "preference", "personal"],
    ["use bun, not npm", "preference", "personal"],
    ["use pnpm, not npm", "preference", "personal"],
  ]);
  // Nothing to read is no learning, never an error.
  assert.deepEqual(stepLearnings({ repoKeys: ["github.com/acme/none"], checkout: "", env: { HOME: b.home, TRAIL_HOME: join(b.home, "nowhere") } }), []);
});

test("a learning's tried-and-ruled-out part is never read as what to do", () => {
  const l = stepLearningOf({ id: "l-1", kind: undefined, scope: "repo", title: "Test setup", body: "## Decided\nuse pnpm, not npm\n## Tried and ruled out\nuse yarn instead of pnpm" });
  assert.deepEqual(l?.rules, [{ t: "swap", use: { prog: "pnpm", args: [] }, not: { prog: "npm", args: [] } }]);
  assert.equal(l?.whole, false, "the quote is the title, not the whole learning");
});

/* ------------------------------------------------------------ at a save */

test("pnpm vs npm at a save: the steps follow the preference, the check too, and one line says so", () => {
  const sheet = testsSheet();
  const plain = compiled(sheet);
  assert.deepEqual(plain.steps.map((s) => s.cmd), ["npm ci", "npm run build", "npm test"]);
  assert.equal(plain.followed, undefined);
  const c = compiled(sheet, [PNPM]);
  assert.deepEqual(c.steps.map((s) => s.cmd), ["pnpm install --frozen-lockfile", "pnpm run build", "pnpm test"]);
  assert.equal(c.check, "pnpm test");
  assert.equal(c.checkIsStep, true);
  assert.equal(c.meta.needs, "pnpm");
  assert.deepEqual(c.steps.map((s) => s.from), plain.steps.map((s) => s.from), "each step still points at the call it was copied from");
  assert.equal(c.followed, 'Steps 1, 2 and 3 follow your learning "use pnpm, not npm" rather than this run\'s commands.');
  // The same learnings give the same skill: both halves of a save agree on what the yes was to.
  assert.equal(skillSha(compiled(sheet, [PNPM])), skillSha(c));
  assert.notEqual(skillSha(c), skillSha(plain));
  const back = parseSkillMd(renderSkillMd(c), c.name)!;
  assert.deepEqual(back.steps.map((s) => s.cmd), c.steps.map((s) => s.cmd));
});

test("a step that can't follow safely is left out, and the line says which and why", () => {
  const c = compiled(testsSheet(["npm ci", "npx prisma db push", "npm run build"]), [learning("never run npx prisma db push", { kind: "decision" })]);
  assert.deepEqual(c.steps.map((s) => s.cmd), ["npm ci", "npm run build", "npm test"]);
  assert.equal(c.followed, "Trail left out 'npx prisma db push': it goes against your learning \"never run npx prisma db push\", and Trail can't change it safely.");
  // The check itself can't be left out: no skill.
  const r = compileRun(testsSheet(), { ...OPTS, learnings: [learning("never run npm test", { scope: "repo" })] });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.detail : "", /^goes against this repo's learning "never run npm test", and it is the check$/);
});

test("a learning that only repeats a step changes nothing at a save", () => {
  const c = compiled(testsSheet(["python scripts/gen_schema.py", "npm run build"]), [SCHEMA]);
  assert.deepEqual(c.steps.map((s) => s.cmd), ["python scripts/gen_schema.py", "npm run build", "npm test"]);
  assert.equal(c.followed, undefined);
});

test("the offer names it at the end of line 1; line 2 is the question as always", () => {
  const lines: [string, string] = ["Tests pass (12 passed). That's the 3rd day I've worked out the tests from scratch (5 commands this time, 1 failed).", "Keep the 3 that worked as a skill, just for you in this repo? (yes / show me / no)"];
  const f = 'Steps 1, 2 and 3 follow your learning "use pnpm, not npm" rather than this run\'s commands.';
  assert.deepEqual(withFollowLine(lines, f), [`${lines[0]} ${f}`, lines[1]]);
  assert.deepEqual(withFollowLine(lines, undefined), lines);
  const long = withFollowLine(lines, "x".repeat(300));
  assert.equal(long[0], `${lines[0]} Some steps follow your learnings rather than this run; say show me to see them.`);
  assert.ok(long[0].length <= 400);
});

test("followAtSave keeps a gated step as it is: it never rewrites a step that can't be undone", () => {
  const f = followAtSave([{ cmd: "npm run build", gated: false, isCheck: false }, { cmd: "npm publish --access public", gated: true, isCheck: false }], [PNPM]);
  assert.deepEqual(f.keep, [{ i: 0, cmd: "pnpm run build" }]);
  // Both sentences are too long for an offer's line 1 together: the counts instead.
  assert.equal(f.line, "To follow your learnings, Trail changed 1 step and left out 1 step; say show me to see them.");
  const short = learning("use bun, not npm");
  assert.equal(followAtSave([{ cmd: "npm test", gated: false, isCheck: false }, { cmd: "npm pack", gated: false, isCheck: false }], [short]).line,
    "Step 1 runs 'bun run test' rather than this run's 'npm test', as your learning \"use bun, not npm\" says. Trail left out 'npm pack': it goes against your learning \"use bun, not npm\", and Trail can't change it safely.");
});

/* ------------------------------------------------------------ at recall */

const skillOf = (cmds: string[]) => cand(compiled(testsSheet(cmds)), { lastWorked: "2026-10-27" });
const blockCtx = { values: {}, notes: [], probes: [], canAsk: true, header: "job" as const, lastFail: null, lessons: [], gone: [] };

test("recall, a repeat: the block says the preference once, under its steps, and the prompt leaves it out", () => {
  const c = skillOf(["python scripts/gen_schema.py", "npm run build"]);
  const marks = recallMarks(c.skill.steps, [SCHEMA]);
  const block = runBlock(c, { ...blockCtx, marks });
  assert.deepEqual(block.split("\n"), [
    "[trail] Skill run-tests fits (yours, v1, last worked Oct 27). Start from these exact steps, in order:",
    "  1 python scripts/gen_schema.py",
    "  2 npm run build",
    "  3 npm test",
    "  check: step 3 passing is the check.",
    "  Step 1 follows your learning: \"don't edit _schema.py by hand, run scripts/gen_schema.py\".",
    "  If a step fails, fix that step and say so. End with \"Used skill run-tests\".",
  ]);
  assert.deepEqual(saidIn(block, marks), ["l-1a2b3c4d"]);
});

test("recall, a contradiction: the preference wins, the block marks each step and shows it the preference's way", () => {
  const c = skillOf(["npm ci", "npm run build"]);
  const marks = recallMarks(c.skill.steps, [PNPM]);
  const block = runBlock(c, { ...blockCtx, marks });
  assert.deepEqual(block.split("\n").slice(1), [
    "  1 pnpm install --frozen-lockfile (your learning's way; the skill has npm ci)",
    "  2 pnpm run build (your learning's way; the skill has npm run build)",
    "  3 pnpm test (your learning's way; the skill has npm test)",
    "  check: step 3 passing is the check.",
    "  Your learning wins over the skill: \"use pnpm, not npm\". Steps 1, 2 and 3 are written its way; run them as shown.",
    "  If a step fails, fix that step and say so. End with \"Used skill run-tests\".",
  ]);
  // What credit and fidelity read: the steps as the block showed them.
  const shown = withFixes(c.skill, marks);
  assert.deepEqual(shown.steps.map((s) => s.cmd), ["pnpm install --frozen-lockfile", "pnpm run build", "pnpm test"]);
  assert.equal(shown.check, "pnpm test");
  assert.deepEqual(saidIn(block, marks), ["l-1a2b3c4d"]);
});

test("recall, a step to leave out: marked on its line, and why after the steps", () => {
  const c = skillOf(["npm ci", "npx prisma db push"]);
  const never = learning("never run npx prisma db push", { kind: "decision", scope: "repo", id: "l-2b3c4d5e" });
  const lines = runBlock(c, { ...blockCtx, marks: recallMarks(c.skill.steps, [never]) }).split("\n");
  assert.equal(lines[2], "  2 npx prisma db push (against this repo's learning: see below)");
  assert.ok(lines.includes("  This repo's learning \"never run npx prisma db push\" goes against step 2: leave it out, do that part its way, and tell the person."), lines.join("\n"));
});

test("a contradiction wins over a repeat; a plain learning quoted only in part repeats nothing; at most 3 learnings", () => {
  const c = skillOf(["npm ci", "npm run build"]);
  const marks = recallMarks(c.skill.steps, [learning("use npm"), PNPM]);
  assert.deepEqual(marks.map((m) => [m.l.quote, m.against, m.steps]), [["use pnpm, not npm", true, [1, 2, 3]]]);
  const partly = learning("use npm. Also the staging database is read-only.");
  assert.equal(partly.whole, false);
  assert.deepEqual(recallMarks(c.skill.steps, [partly]), []);
  const guard = learning("always run npm ci", { kind: "guardrail" });
  assert.deepEqual(recallMarks(c.skill.steps, [guard]), [], "a guardrail is enforced where the command runs; a repeat of one is not said here");
  const many = ["use npm", "always run npm ci", "always run npm test", "always run npm run build"].map((t, k) => learning(t, { id: `l-0000000${k}` }));
  assert.equal(recallMarks(c.skill.steps, many).length, 3);
  assert.deepEqual(markLines([]), []);
});

/* ------------------------------------------------------------ init's fold */

test("onlyRepeats: what init folds into a kept skill as a lesson", () => {
  const steps = ["python scripts/gen_schema.py", "pytest -q"];
  assert.equal(onlyRepeats("don't edit _schema.py by hand, run scripts/gen_schema.py", steps), true);
  assert.equal(onlyRepeats("run scripts/gen_schema.py, then tell me what changed", steps), false, "part of it isn't a step");
  assert.equal(onlyRepeats("use pnpm, not npm", ["npm test"]), false, "a contradiction is no repeat");
  assert.equal(onlyRepeats("explain it simply", steps), false);
});

test("a learning saved by trail note, through #663's gate, is one part 7 reads: same store, live, and its steps follow it", () => {
  const repo = mkdtempSync(join(tmpdir(), "follow-663-"));
  const home = mkdtempSync(join(tmpdir(), "follow-663-home-"));
  homes.push(repo, home);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Priya S"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), '{ "scripts": { "test": "vitest" } }\n');
  spawnSync("git", ["add", "package.json"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=p@example.com", "commit", "-qm", "init"], { cwd: repo });
  const body = "## Decided\n- Use pnpm, not npm.\n- Because npm rewrites the pnpm-lock.yaml that package.json is installed from.\n";
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "note", repo, "--title", "Use pnpm, not npm", "--touches", "package.json"], {
    input: body,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  const ls = stepLearnings({ repoKeys: [], checkout: repo, env: { ...process.env, TRAIL_HOME: join(home, ".trail") } });
  assert.deepEqual(ls.map((l) => l.quote), ["Use pnpm, not npm"]);
  const c = compiled(testsSheet(), ls);
  assert.deepEqual(c.steps.map((st) => st.cmd), ["pnpm install --frozen-lockfile", "pnpm run build", "pnpm test"]);
  assert.match(c.followed ?? "", /this repo's learning "Use pnpm, not npm"/);
});
