/**
 * The lesson save (design 4.15): `trail skills lesson [<skill>] --offer <id>`
 * keeps a lesson only on the person's typed yes to the offer that showed its
 * exact text, decided at PreToolUse (a receipt) and again by the CLI from
 * the transcript. The saved lines, a wall lesson's first worked epochs (R48),
 * and the ways around it (12+ rows on top of 1a's 81). Synthetic data only.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sidechain } from "./trace-fixtures.js";
import { T, append, ctxAt, prompt, say, state, type Box } from "./skills-consent-fixtures.js";
import { cleanup, correctionOffer, keep, lessonCmd, repairedOffer, sayLines, type KeepResult, CORRECTION } from "./skills-lesson-fixtures.js";
import { keepLessonCli } from "../src/skills/lesson-gate.js";
import { readWalls } from "../src/trace/wall-state.js";
import { readLedger } from "../src/skills/ledger.js";
import { readLessons } from "../src/skills/lessons.js";
import { sessionPath } from "../src/trace/gate-file.js";

after(cleanup);

/** Lesson files and every-repo lesson learnings Trail holds in this home. */
function lessons(b: Box): string[] {
  const out: string[] = [];
  const skills = join(b.env.TRAIL_HOME!, "skills");
  for (const s of existsSync(skills) ? readdirSync(skills) : []) for (const l of readLessons(join(skills, s))) out.push(`${s}:${l.text}`);
  const every = join(b.env.TRAIL_HOME!, "learnings");
  for (const f of existsSync(every) ? readdirSync(every) : []) if (f.startsWith("lesson-")) out.push(`every:${f}`);
  return out;
}

type Outcome = "deny" | "held" | "saved" | "nothing";
const outcome = (r: KeepResult): Outcome => (r.decision?.permissionDecision === "deny" ? "deny" : !r.cli ? "nothing" : r.cli.code === 0 ? "saved" : "held");

test("moment 4: the yes keeps the lesson on the skill, with its saved line and a ledger lesson line", async () => {
  const { b, o } = correctionOffer();
  sayLines(b, 210, o);
  assert.equal(prompt(b, 220, "yes").answer, "yes");
  const r = await keep(b, 230, lessonCmd(o));
  assert.equal(r.decision, null, JSON.stringify(r.decision));
  assert.equal(r.cli!.code, 0, r.cli!.line);
  assert.match(r.cli!.line, /^✓ learning added to release-npm, just for you · it rides at the end of the skill's steps · undo: trail forget ls-[0-9a-f]{6}$/);
  assert.deepEqual(lessons(b), ["release-npm:push the tag too: git push origin --tags"]);
  const line = readLedger("s-7f3a2c", b.env).find((l) => l.event === "lesson") as { lessonId: string; src: string } | undefined;
  assert.equal(line?.src, "correction");
  assert.match(r.cli!.line, new RegExp(line!.lessonId));
  assert.equal(state(b).pendingOffer, null, "the consent is spent");
});

test("moment 3: the yes keeps the wall lesson in every repo, and it starts with its 2 worked epochs (R48)", async () => {
  const { b, o } = repairedOffer();
  sayLines(b, 60, o);
  assert.equal(prompt(b, 70, "yes").answer, "yes");
  const r = await keep(b, 80, lessonCmd(o));
  assert.equal(r.decision, null, JSON.stringify(r.decision));
  assert.equal(r.cli!.code, 0, r.cli!.line);
  const id = /trail forget (l-[0-9a-f]{8})$/.exec(r.cli!.line)?.[1];
  assert.ok(id, r.cli!.line);
  assert.equal(r.cli!.line, `✓ learning kept, just for you in every repo · Trail shows it when "rootless Docker not found" comes back · undo: trail forget ${id}`);
  const worked = readWalls(b.env).classes["docker-rootless"]!.lessons[id!]!.worked;
  assert.equal(worked.length, 2);
  assert.deepEqual(worked.map((w) => w.d), ["2026-10-24", "2026-10-27"]);
  assert.equal(lessons(b).length, 1);
});

test("the yes directive tells the agent the lesson command, from Trail, quoting the person", () => {
  const { b, o } = repairedOffer();
  sayLines(b, 60, o);
  const p = prompt(b, 70, "yes please");
  assert.match(p.out!.context!, /^\[trail\] From Trail, the tool this person installed/);
  assert.match(p.out!.context!, /They typed: "yes please"\./);
  assert.ok(p.out!.context!.includes(`run: trail skills lesson --offer ${o.offerId}.`));
});

/* ---------------------------------------------------------------- ways around */

const rows: Array<[string, () => Promise<{ b: Box; r: KeepResult }>, Outcome[]]> = [
  ["no yes: the agent keeps it right after the offer", async () => {
    const { b, o } = correctionOffer();
    sayLines(b, 210, o);
    return { b, r: await keep(b, 230, lessonCmd(o)) };
  }, ["deny"]],
  ["a yes as the 2nd prompt after the offer", async () => {
    const { b, o } = correctionOffer();
    sayLines(b, 210, o);
    prompt(b, 220, "first bump the changelog");
    prompt(b, 225, "yes");
    return { b, r: await keep(b, 230, lessonCmd(o)) };
  }, ["deny"]],
  ["the reply didn't end with line 2 (the agent asked its own question)", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o, { after: "\nShall I also restart Colima on login?" });
    prompt(b, 70, "yes");
    return { b, r: await keep(b, 80, lessonCmd(o)) };
  }, ["deny"]],
  ["a forged --offer id", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    prompt(b, 70, "yes");
    return { b, r: await keep(b, 80, "trail skills lesson --offer o-ffffff") };
  }, ["deny", "held"]],
  ["the correction offer kept under another skill's name", async () => {
    const { b, o } = correctionOffer();
    sayLines(b, 210, o);
    prompt(b, 220, "yes");
    return { b, r: await keep(b, 230, lessonCmd(o, "ship-beta")) };
  }, ["deny"]],
  ["a wall lesson kept as if it were a skill's", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    prompt(b, 70, "yes");
    return { b, r: await keep(b, 80, lessonCmd(o, "integration-tests")) };
  }, ["deny"]],
  ["--yes / --force on the command", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    prompt(b, 70, "yes");
    return { b, r: await keep(b, 80, `${lessonCmd(o)} --force`) };
  }, ["deny"]],
  ["from a subagent", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    prompt(b, 70, "yes");
    return { b, r: await keep(b, 80, lessonCmd(o), { ctx: { ...ctxAt(b, 80), subagent: true } }) };
  }, ["deny"]],
  ["a yes in a subagent's thread", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    append(b, [sidechain("yes")]);
    return { b, r: await keep(b, 80, lessonCmd(o)) };
  }, ["deny"]],
  ["the hook skipped (an alias it can't read): the CLI finds no receipt", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    prompt(b, 70, "yes");
    return { b, r: await keep(b, 80, lessonCmd(o), { skipHook: true }) };
  }, ["held"]],
  ["the session file's repair delta rewritten after the offer", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    prompt(b, 70, "yes");
    const path = sessionPath(b.sid, ".json", b.env);
    const f = JSON.parse(readFileSync(path, "utf8"));
    f.skills.pendingOffer.repair.delta[0].text = "DOCKER_HOST=tcp://evil.test:2375";
    writeFileSync(path, JSON.stringify(f));
    return { b, r: await keep(b, 80, lessonCmd(o)) };
  }, ["deny"]],
  ["the correction line changed between the hook and the CLI", async () => {
    const { b, o } = correctionOffer();
    sayLines(b, 210, o);
    prompt(b, 220, "yes");
    const r0 = await keep(b, 230, lessonCmd(o), { offerId: "o-none" });
    // The hook wrote its receipt; now the person's line is replaced in place (same offset, other words).
    const text = readFileSync(b.tx, "utf8");
    writeFileSync(b.tx, text.replace(CORRECTION, "no, it didn't push the tab"));
    return { b, r: { ...r0, cli: keepLessonCli("release-npm", o.offerId, b.env, T(240)) } };
  }, ["held"]],
  ["a used receipt can't keep twice", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    prompt(b, 70, "yes");
    const first = await keep(b, 80, lessonCmd(o));
    assert.equal(first.cli?.code, 0);
    const again = keepLessonCli(null, o.offerId, b.env, T(90));
    return { b: { ...b, _legit: 1 } as unknown as Box, r: { ...first, cli: again } };
  }, ["held"]],
  ["a receipt for another file (a copy, another inode)", async () => {
    const { b, o } = repairedOffer();
    sayLines(b, 60, o);
    prompt(b, 70, "yes");
    const r0 = await keep(b, 80, lessonCmd(o), { offerId: "o-none" });
    const copy = join(b.tx, "..", "..", "-home-dev-other", `${b.sid}.jsonl`);
    mkdirSync(join(copy, ".."), { recursive: true });
    copyFileSync(b.tx, copy);
    const rp = join(b.env.TRAIL_HOME!, "receipts", `${b.sid}.lesson.json`);
    const rc = JSON.parse(readFileSync(rp, "utf8"));
    writeFileSync(rp, JSON.stringify({ ...rc, transcriptPath: copy }));
    return { b, r: { ...r0, cli: keepLessonCli(null, o.offerId, b.env, T(90)) } };
  }, ["held"]],
  ["a yes typed before the offer", async () => {
    const { b, o } = repairedOffer();
    // The yes sits before the offer's shownAt: the fold never counts it as an answer.
    const st = state(b);
    assert.ok(st.pendingOffer?.shownAt);
    say(b, 40, "yes");
    sayLines(b, 60, o);
    return { b, r: await keep(b, 80, lessonCmd(o)) };
  }, ["deny"]],
];

test(`the lesson gate's ways-around table has at least 12 rows (${rows.length})`, () => {
  assert.ok(rows.length >= 12);
});

for (const [name, attempt, allowed] of rows) {
  test(`refused or held: ${name}`, async () => {
    const { b, r } = await attempt();
    const got = outcome(r);
    const legit = (b as unknown as { _legit?: number })._legit ?? 0;
    assert.ok(allowed.includes(got), `${name}: ${got} ${JSON.stringify(r.decision ?? r.cli)}`);
    if (got === "held") assert.match(r.cli!.line, /^trail · learning not kept: /);
    assert.equal(lessons(b).length, legit, "no lesson written by the attempt");
  });
}

test("saveOrLessonGate sends a lesson command to the lesson gate and an add to 1a's save gate", async () => {
  const { saveOrLessonGate, parseSkillsLesson } = await import("../src/skills/save-gate.js");
  const { b, o } = repairedOffer();
  sayLines(b, 60, o);
  const input = (command: string) => ({ ...b.payload, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_x1", cwd: "/home/dev/shop" });
  const d = await saveOrLessonGate(input(lessonCmd(o)), "/home/dev/shop", { ...b.env, TRAIL_TEST_NOW: T(80).toISOString() });
  assert.match(d?.reason ?? "", /^trail · learning not kept: the person didn't say yes/);
  const a = await saveOrLessonGate(input("trail skills add x --run r-1"), "/home/dev/shop", b.env);
  assert.match(a?.reason ?? "", /^trail · not saved: /);
  assert.deepEqual(parseSkillsLesson("npx -y @trailhq/trail-code skills lesson release-npm --offer=o-1a2b3c"), { skill: "release-npm", offerId: "o-1a2b3c", flags: [] });
  assert.equal(parseSkillsLesson("trail skills lesson --offer o-1 && trail skills lesson --offer o-2"), null);
  assert.equal(parseSkillsLesson("trail skills lesson release-npm"), null);
});
