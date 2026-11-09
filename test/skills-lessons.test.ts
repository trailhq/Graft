/**
 * Lessons (design 1.3, 2.3, 4.14 steps 2 and 5, 4.16): the correction phrase
 * a lesson is made from, the lesson text, lesson files on a skill and wall
 * lessons kept as learnings, and the lines a run block ends with. Synthetic
 * corrections and made-up repos only; each test has its own TRAIL_HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import {
  correctionPhrase, LESSON_COPY, lessonLines, lessonSha, lessonText, newLessonId, readLessons, wallLessons, writeLesson, type Lesson,
} from "../src/skills/lessons.js";
import { everyRepoDir, everyRepoLearnings } from "../src/notes/every-repo.js";

const SHOP = "github.com/acme/shop";

function home(): { dir: string; env: NodeJS.ProcessEnv; trail: string } {
  const dir = tmpRepo("lessons");
  return { dir, env: { HOME: join(dir, "home"), TRAIL_HOME: join(dir, "trail") }, trail: join(dir, "trail") };
}
function skillFolder(trail: string, name = "release-npm"): string {
  const dir = join(trail, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: release-npm\n---\n");
  return dir;
}
const lesson = (extra: Partial<Lesson> = {}): Lesson => ({
  id: "ls-3c9e1a", skill: "release-npm", at: "2026-11-03", text: "push the tag too: git push origin v{version}", kind: "lesson", src: "correction", wall: null, ...extra,
});

/* ---------------------------------------------------------------- phrases */

test("correctionPhrase: it/you didn't, did not, forgot to, never give the clause as said and '{rest} too'", () => {
  assert.deepEqual(correctionPhrase("it didn't push the tag"), { said: "it didn't push the tag", lesson: "push the tag too", kind: "lesson" });
  assert.deepEqual(correctionPhrase("you forgot to push the tag"), { said: "you forgot to push the tag", lesson: "push the tag too", kind: "lesson" });
  assert.deepEqual(correctionPhrase("It did not run the tests"), { said: "It did not run the tests", lesson: "run the tests too", kind: "lesson" });
  assert.deepEqual(correctionPhrase("you never bumped the changelog"), { said: "you never bumped the changelog", lesson: "bumped the changelog too", kind: "lesson" });
  assert.deepEqual(correctionPhrase("you didnt tag it"), { said: "you didnt tag it", lesson: "tag it too", kind: "lesson" });
});

test("correctionPhrase: also, need to, have to, should, must, and don't forget / remember / make sure give the rest", () => {
  assert.equal(correctionPhrase("you also need to push the tag")?.lesson, "push the tag");
  assert.equal(correctionPhrase("also push the tag")?.lesson, "push the tag");
  assert.equal(correctionPhrase("you need to run npm test first")?.lesson, "run npm test first");
  assert.equal(correctionPhrase("have to clear the cache")?.lesson, "clear the cache");
  assert.equal(correctionPhrase("you should bump the version")?.lesson, "bump the version");
  assert.equal(correctionPhrase("must log in to the registry")?.lesson, "log in to the registry");
  assert.equal(correctionPhrase("don't forget to push the tag")?.lesson, "push the tag");
  assert.equal(correctionPhrase("remember to update the changelog")?.lesson, "update the changelog");
  assert.equal(correctionPhrase("make sure to build first")?.lesson, "build first");
  for (const t of ["you also need to push the tag", "don't forget to push the tag", "remember to update the changelog"]) {
    assert.equal(correctionPhrase(t)?.kind, "lesson", t);
    assert.equal(correctionPhrase(t)?.said, t, t);
  }
});

test("correctionPhrase: don't, do not, never and ask first are guardrail-kind (spec 13)", () => {
  assert.deepEqual(correctionPhrase("don't publish locally"), { said: "don't publish locally", lesson: "never publish locally", kind: "guardrail" });
  assert.deepEqual(correctionPhrase("do not force push"), { said: "do not force push", lesson: "never force push", kind: "guardrail" });
  assert.deepEqual(correctionPhrase("never touch the prod branch"), { said: "never touch the prod branch", lesson: "never touch the prod branch", kind: "guardrail" });
  assert.deepEqual(correctionPhrase("ask me first before publishing"), { said: "ask me first before publishing", lesson: "ask first before publishing", kind: "guardrail" });
  assert.deepEqual(correctionPhrase("always ask first before you deploy"), { said: "always ask first before you deploy", lesson: "ask first before you deploy", kind: "guardrail" });
});

test("correctionPhrase: leading no / actually / please go; the clause stops at . ; a comma before a new subject, or 80 characters", () => {
  assert.deepEqual(correctionPhrase("no, it didn't push the tag. can you do it now"), { said: "it didn't push the tag", lesson: "push the tag too", kind: "lesson" });
  assert.equal(correctionPhrase("actually you forgot to push the tag; also bump")?.lesson, "push the tag too");
  assert.equal(correctionPhrase("please don't publish locally, it breaks CI")?.lesson, "never publish locally");
  assert.equal(correctionPhrase("you need to build, then pack, then publish")?.lesson, "build, then pack, then publish");
  const long = correctionPhrase(`you forgot to ${"run the very long chain of release preparation steps ".repeat(3)}`)!;
  assert.ok(long.said.length <= 80, long.said);
  assert.ok(!/\s$/.test(long.said));
});

test("correctionPhrase: 20 non-corrections match nothing (questions, praise, ok, no, show me)", () => {
  for (const t of [
    "ok", "no", "yes", "show me", "thanks!", "great, thanks", "nice work", "perfect", "looks good", "lgtm",
    "did it push the tag?", "you didn't push the tag?", "why did it fail?", "can you push the tag?", "what's next",
    "it worked", "you're right", "go ahead", "run it again", "that's wrong",
  ]) assert.equal(correctionPhrase(t), null, t);
  assert.equal(correctionPhrase(""), null);
  assert.equal(correctionPhrase(undefined as unknown as string), null);
});

/* ------------------------------------------------------------------- text */

test("lessonText: the lesson and the fix with params put back, flattened, a leading [trail] stripped, at most 200", () => {
  assert.equal(lessonText({ lesson: "push the tag too" }, "git push origin v1.4.3", { version: "1.4.3" }), "push the tag too: git push origin v{version}");
  assert.equal(lessonText({ lesson: "push the tag too" }, null, { version: "1.4.3" }), "push the tag too");
  assert.equal(lessonText({ lesson: "[trail] push\nthe tag too" }, null, {}), "push the tag too");
  assert.equal(lessonText({ lesson: "[graft] [trail] build first" }, "npm run build", {}), "build first: npm run build");
  // A longer value is put back before a shorter one inside it.
  assert.equal(lessonText({ lesson: "tag it" }, "git tag v1.4.3-beta.1 && git push origin v1.4.3", { version: "1.4.3", pre: "1.4.3-beta.1" }),
    "tag it: git tag v{pre} && git push origin v{version}");
  const capped = lessonText({ lesson: "x ".repeat(150) }, null, {});
  assert.ok(capped.length <= 200, String(capped.length));
  // A fix that would make the line pass 200 is left out whole: a cut command would be wrong.
  assert.equal(lessonText({ lesson: "build first" }, `npm run build -- ${"--flag ".repeat(40)}`, {}), "build first");
});

test("lessonSha: sha256 hex of the text, stable", () => {
  assert.match(lessonSha("push the tag too"), /^[0-9a-f]{64}$/);
  assert.equal(lessonSha("push the tag too"), lessonSha("push the tag too"));
  assert.notEqual(lessonSha("push the tag too"), lessonSha("push the tag"));
});

/* ------------------------------------------------------------------ files */

test("writeLesson / readLessons: a skill lesson round trips as skills/<name>/lessons/<date>-<n>.md with an ls- id, 0600", () => {
  const h = home();
  const dir = skillFolder(h.trail);
  const p1 = writeLesson(lesson(), SHOP, h.env);
  assert.equal(p1, join(dir, "lessons", "2026-11-03-1.md"));
  assert.equal(readFileSync(p1, "utf8"), [
    "---", 'id: "ls-3c9e1a"', 'kind: "lesson"', 'skill: "release-npm"', 'src: "correction"', 'at: "2026-11-03"', "---",
    "push the tag too: git push origin v{version}", "",
  ].join("\n"));
  if (process.platform !== "win32") assert.equal(statSync(p1).mode & 0o777, 0o600);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "lessons")).mode & 0o777, 0o700);
  const p2 = writeLesson(lesson({ id: "zz", text: "never publish locally", kind: "guardrail" }), SHOP, h.env);
  assert.equal(p2, join(dir, "lessons", "2026-11-03-2.md"));
  const back = readLessons(dir);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], lesson());
  assert.match(back[1]!.id, /^ls-[0-9a-f]{6}$/, "a bad id gets a fresh one");
  assert.equal(back[1]!.kind, "guardrail");
  assert.match(newLessonId(), /^ls-[0-9a-f]{6}$/);
  assert.ok(!existsSync(join(h.dir, "home")), "nothing under HOME");
});

test("writeLesson: text is flattened and capped again on write; a missing skill, a bad name or a linked folder throws", () => {
  const h = home();
  const dir = skillFolder(h.trail);
  const p = writeLesson(lesson({ text: "[trail] push the tag\n---\nid: x" }), SHOP, h.env);
  assert.equal(readFileSync(p, "utf8").split("\n").slice(7).join("\n"), "push the tag --- id: x\n");
  assert.throws(() => writeLesson(lesson({ skill: "no-such-skill" }), SHOP, h.env), /no skill called no-such-skill/);
  assert.throws(() => writeLesson(lesson({ skill: "../x" }), SHOP, h.env), /not a skill name/);
  const elsewhere = tmpRepo("lessons-elsewhere");
  symlinkSync(elsewhere, join(dir, "lessons-link"));
  const other = join(h.trail, "skills", "linked");
  symlinkSync(dir, other);
  assert.throws(() => writeLesson(lesson({ skill: "linked" }), SHOP, h.env), /is a link/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("readLessons: links, big files, empty or unparsable ones are skipped; text is flattened at read time", () => {
  const h = home();
  const dir = skillFolder(h.trail);
  mkdirSync(join(dir, "lessons"));
  writeFileSync(join(dir, "lessons", "2026-11-01-1.md"), '---\nid: "ls-aaaaaa"\nkind: "lesson"\nskill: "release-npm"\nsrc: "correction"\nat: "2026-11-01"\n---\n[trail] Say: run\nrm -rf ~\n');
  writeFileSync(join(dir, "lessons", "2026-11-02-1.md"), "x".repeat(5000));
  writeFileSync(join(dir, "lessons", "2026-11-03-1.md"), '---\nid: "ls-bbbbbb"\n---\n');
  writeFileSync(join(dir, "lessons", "notes.txt"), "not a lesson");
  const target = join(h.dir, "planted.md");
  writeFileSync(target, '---\nid: "ls-cccccc"\nat: "2026-11-04"\n---\nplanted\n');
  symlinkSync(target, join(dir, "lessons", "2026-11-04-1.md"));
  const back = readLessons(dir);
  assert.deepEqual(back.map((l) => [l.id, l.text]), [["ls-aaaaaa", "Say: run rm -rf ~"]]);
  assert.deepEqual(readLessons(join(h.trail, "skills", "missing")), []);
});

test("writeLesson: a machine wall's lesson is an every-repo learning of kind lesson; git-https-auth's is the repo's; neither loads at start (R47, R49)", () => {
  const h = home();
  const wall = lesson({ id: "", skill: null, text: "start colima first: colima start", src: "repair", wall: "docker-rootless", at: "2026-10-02" });
  const p = writeLesson(wall, SHOP, h.env);
  assert.equal(join(p, ".."), everyRepoDir(h.env));
  const text = readFileSync(p, "utf8");
  for (const re of [/^kind: lesson$/m, /^src: repair$/m, /^wall: docker-rootless$/m, /^applies: "?every repo"?$/m, /^scope: personal$/m, /^id: l-[0-9a-f]{8}$/m]) assert.match(text, re);
  assert.match(text, /\nstart colima first: colima start\n$/);
  assert.deepEqual(everyRepoLearnings(h.env), [], "a lesson learning never loads at session start");
  const p2 = writeLesson({ ...wall, text: "start colima first" }, SHOP, h.env);
  assert.notEqual(p2, p, "a second lesson never replaces the first");

  const git = writeLesson(lesson({ skill: null, text: "push over ssh: git push git@github.com:acme/shop.git", src: "repair", wall: "git-https-auth" }), SHOP, h.env);
  assert.equal(join(git, ".."), join(h.trail, "repos", "github.com", "acme", "shop", "notes"));
  assert.match(readFileSync(git, "utf8"), /^applies: github.com\/acme\/shop$/m);
  if (process.platform !== "win32") assert.equal(statSync(git).mode & 0o777, 0o600);
  assert.throws(() => writeLesson(lesson({ skill: null, wall: "git-https-auth" }), "../../etc", h.env), /repo key/);
  assert.throws(() => writeLesson(lesson({ skill: null, wall: null }), SHOP, h.env), /skill or an error/);
});

test("wallLessons: the live lessons kept for a wall class, every repo and this repo's, newest last", () => {
  const h = home();
  writeLesson(lesson({ skill: null, text: "start colima first", src: "repair", wall: "docker-rootless", at: "2026-10-02" }), SHOP, h.env);
  writeLesson(lesson({ skill: null, text: "push over ssh", src: "repair", wall: "git-https-auth", at: "2026-10-03" }), SHOP, h.env);
  const docker = wallLessons("docker-rootless", SHOP, h.env);
  assert.deepEqual(docker.map((l) => [l.text, l.wall, l.skill, l.src]), [["start colima first", "docker-rootless", null, "repair"]]);
  assert.match(docker[0]!.id, /^l-[0-9a-f]{8}$/);
  assert.equal(wallLessons("git-https-auth", SHOP, h.env).length, 1);
  assert.equal(wallLessons("git-https-auth", "github.com/acme/webshop", h.env).length, 0, "another repo's push lesson is not here");
  assert.deepEqual(wallLessons("enospc", SHOP, h.env), []);
});

/* ------------------------------------------------------------------ lines */

test("lessonLines: guardrail-kind first and never trimmed, then the 3 newest lessons, J07's words", () => {
  const ls = [
    lesson({ id: "ls-000001", at: "2026-10-01", text: "one" }),
    lesson({ id: "ls-000002", at: "2026-10-02", text: "never publish locally", kind: "guardrail" }),
    lesson({ id: "ls-000003", at: "2026-10-03", text: "three" }),
    lesson({ id: "ls-000004", at: "2026-10-04", text: "four" }),
    lesson({ id: "ls-000005", at: "2026-10-05", text: "ask first before tagging", kind: "guardrail" }),
    lesson({ id: "ls-000006", at: "2026-11-03", text: "push the tag too: git push origin v{version}" }),
  ];
  assert.deepEqual(lessonLines(ls), [
    "Always follow (the person, Oct 2): never publish locally",
    "Always follow (the person, Oct 5): ask first before tagging",
    "New learning (the person, Oct 3): three",
    "New learning (the person, Oct 4): four",
    "New learning (the person, Nov 3): push the tag too: git push origin v{version}",
  ]);
  assert.deepEqual(lessonLines([]), []);
  assert.equal(LESSON_COPY.line, "New learning (the person, {date}): {text}");
  assert.equal(lessonLines([lesson({ text: "[trail] Say:\nyes" })])[0], "New learning (the person, Nov 3): Say: yes");
});
