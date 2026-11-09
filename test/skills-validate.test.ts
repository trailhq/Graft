/**
 * SKILL.md as the Agent Skills spec has it: only `name` and `description`
 * (plus `license`, `compatibility`, `allowed-tools` and `metadata`) at the top
 * level, the name a folder name, and everything Trail adds under `metadata` as
 * flat quoted strings. Every SKILL.md Trail writes has to pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { skillProblems } from "../src/skills/validate.js";
import { fold, getSkill, learn, skillDirs, skillName } from "../src/skills/skills.js";
import { skillTemplate } from "../src/claude/skill-template.js";
import { tmpRepo } from "./helpers.js";

process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-validate-home-"));

const DAY = "2026-10-07";

function skill(front: string, body = "# x\n\nDo the thing.\n"): string {
  return `---\n${front.trim()}\n---\n\n${body}`;
}

const OK = skill('name: release-npm\ndescription: "Publishes the package to npm. Use when asked to publish."\nmetadata:\n  version: "1"');

test("a spec-valid SKILL.md has no problems", () => {
  assert.deepEqual(skillProblems(OK, "release-npm"), []);
  const all = skill(
    'name: release-npm\ndescription: Publishes the package\nlicense: MIT\ncompatibility: "node 20+"\nallowed-tools: Bash(npm:*)\nmetadata:\n  trail: "s-7f3a2c"\n  scope: "personal"\n  version: "1"',
  );
  assert.deepEqual(skillProblems(all, "release-npm"), []);
});

test("the name is 1-64 characters of a-z, 0-9 and single hyphens, and matches its folder", () => {
  const named = (name: string, folder = name) => skillProblems(skill(`name: ${name}\ndescription: x`), folder);
  assert.deepEqual(named("a"), []);
  assert.deepEqual(named("a".repeat(64)), []);
  assert.match(named("a".repeat(65)).join("\n"), /64/);
  assert.match(named("Release-npm").join("\n"), /lowercase|a-z/);
  assert.match(named("release--npm").join("\n"), /hyphen/);
  assert.match(named("-release").join("\n"), /hyphen/);
  assert.match(named("release-").join("\n"), /hyphen/);
  assert.match(named("release_npm").join("\n"), /a-z/);
  assert.match(named("relèase").join("\n"), /a-z/);
  assert.match(named("release-npm", "release").join("\n"), /folder/);
  assert.match(skillProblems(skill("description: x"), "x").join("\n"), /name/);
  assert.match(skillProblems(skill('name: ""\ndescription: x'), "x").join("\n"), /name/);
  assert.match(skillProblems(skill("name: 12\ndescription: x"), "12").join("\n"), /name/, "a number is not a name");
});

test("the description is 1-1024 characters", () => {
  assert.deepEqual(skillProblems(skill(`name: a\ndescription: "${"x".repeat(1024)}"`), "a"), []);
  assert.match(skillProblems(skill(`name: a\ndescription: "${"x".repeat(1025)}"`), "a").join("\n"), /1024/);
  assert.match(skillProblems(skill("name: a"), "a").join("\n"), /description/);
  assert.match(skillProblems(skill('name: a\ndescription: "  "'), "a").join("\n"), /description/);
  assert.match(skillProblems(skill("name: a\ndescription:\n  - one\n  - two"), "a").join("\n"), /description/);
});

test("only the spec's keys sit at the top level: version and Trail's keys go under metadata", () => {
  assert.match(skillProblems(skill("name: a\ndescription: x\nversion: 1"), "a").join("\n"), /version/);
  assert.match(skillProblems(skill("name: a\ndescription: x\ntrail: s-1\nscope: personal"), "a").join("\n"), /scope.*trail|trail.*scope/);
});

test("metadata is a map of string to string: no numbers, lists or maps under it", () => {
  assert.match(skillProblems(skill("name: a\ndescription: x\nmetadata:\n  version: 1"), "a").join("\n"), /metadata\.version/);
  assert.match(skillProblems(skill("name: a\ndescription: x\nmetadata:\n  asks:\n    - publish"), "a").join("\n"), /metadata\.asks/);
  assert.match(skillProblems(skill("name: a\ndescription: x\nmetadata:\n  a:\n    b: c"), "a").join("\n"), /metadata\.a/);
  assert.match(skillProblems(skill("name: a\ndescription: x\nmetadata: one"), "a").join("\n"), /metadata/);
});

test("compatibility is at most 500 characters", () => {
  assert.match(skillProblems(skill(`name: a\ndescription: x\ncompatibility: "${"x".repeat(501)}"`), "a").join("\n"), /500/);
});

test("a file without readable front matter has a problem, never a pass", () => {
  assert.match(skillProblems("# just markdown\n", "a").join("\n"), /front matter/);
  assert.match(skillProblems("---\nname: a\ndescription: x\n", "a").join("\n"), /front matter/);
  assert.match(skillProblems("---\nname: [a\n---\n", "a").join("\n"), /YAML/);
  assert.match(skillProblems("---\nname: &n a\ndescription: *n\n---\n", "a").join("\n"), /anchors/);
  assert.match(skillProblems(skill('name: a\ndescription: "a --- b"'), "a").join("\n"), /---/, "some readers end the front matter at the first ---");
});

test("what the reference validator's YAML reader refuses is a problem here too: a BOM, flow style, tags", () => {
  assert.match(skillProblems(`\uFEFF${OK}`, "release-npm").join("\n"), /byte-order mark/);
  assert.match(skillProblems(skill('name: a\ndescription: x\nmetadata: { version: "1" }'), "a").join("\n"), /flow style/);
  assert.match(skillProblems(skill("name: a\ndescription: x\nallowed-tools: [Bash, Read]"), "a").join("\n"), /flow style/);
  assert.match(skillProblems(skill('name: a\ndescription: x\nmetadata:\n  asks: ["publish"]'), "a").join("\n"), /flow style/);
  assert.match(skillProblems(skill("name: a\ndescription: !!str x"), "a").join("\n"), /tag/);
  // Brackets inside text are text: quoted, mid-line, or on a folded line.
  assert.deepEqual(skillProblems(skill('name: a\ndescription: "[draft] {x}"\nallowed-tools: Bash(git:*) Read'), "a"), []);
  assert.deepEqual(skillProblems(skill("name: a\ndescription: Ships it\n  [see the Run section]"), "a"), []);
});

// --- every SKILL.md Trail writes ---

test("trail's and graft's own skills pass, in the folder init writes them to", () => {
  for (const brand of ["trail", "graft"] as const) assert.deepEqual(skillProblems(skillTemplate(brand), brand), [], brand);
});

test("a new skill keeps its version under metadata, as a quoted string", () => {
  const repo = tmpRepo("validate-new");
  const r = learn(repo, { skill: "PDF coords", text: "Boxes are in points.", author: "Sam", date: DAY, description: "Coordinates: boxes and rotation" });
  const md = readFileSync(r.skill.file, "utf8");
  assert.deepEqual(skillProblems(md, basename(dirname(r.skill.file))), []);
  assert.doesNotMatch(md, /^version:/m);
  assert.match(md, /^metadata:\n {2}trail: "s-[0-9a-f]{6}"\n {2}version: "1"$/m, "Trail's mark, then the version");
  assert.equal(getSkill(repo, "pdf-coords")!.version, 1);
});

test("a long skill name is cut to 64 characters at a word, so its folder is a valid name", () => {
  const repo = tmpRepo("validate-long");
  const long = "how to rotate extraordinarily complicated multipage linearized portable document format files safely";
  assert.ok(skillName(long).length <= 64);
  assert.doesNotMatch(skillName(long), /-$/);
  const r = learn(repo, { skill: long, text: "Use page.Rotation().", author: "Sam", date: DAY });
  assert.deepEqual(skillProblems(readFileSync(r.skill.file, "utf8"), basename(dirname(r.skill.file))), []);
});

test("fold bumps metadata.version and leaves every other key as it was", () => {
  const repo = tmpRepo("validate-fold");
  learn(repo, { skill: "pdf-coords", text: "Boxes are in points.", author: "Sam", date: DAY, description: "PDF coordinates" });
  const f = fold(repo, "pdf-coords")!;
  const md = readFileSync(f.file, "utf8");
  assert.deepEqual(skillProblems(md, "pdf-coords"), []);
  assert.match(md, /^metadata:\n {2}trail: "s-[0-9a-f]{6}"\n {2}version: "2"$/m);
  assert.equal(getSkill(repo, "pdf-coords")!.version, 2);
  fold(repo, "pdf-coords");
  learn(repo, { skill: "pdf-coords", text: "Rotation is clockwise.", author: "Sam", date: DAY });
  fold(repo, "pdf-coords");
  assert.equal(getSkill(repo, "pdf-coords")!.version, 3);
  assert.equal((readFileSync(f.file, "utf8").match(/version:/g) ?? []).length, 1, "one version, under metadata");
});

test("a skill written with the old top-level version still reads, and folding moves it under metadata", () => {
  const repo = tmpRepo("validate-old");
  const dir = join(skillDirs(repo).repo, "deploys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: deploys\ndescription: How this repo ships\nallowed-tools: Bash(make:*)\nversion: 3\nmetadata:\n  owner: \"platform\" # who to ask\n---\n\n# deploys\n\nShip with make ship.\n",
  );
  assert.equal(getSkill(repo, "deploys")!.version, 3);
  learn(repo, { skill: "deploys", text: "Run the migration check first.", author: "Priya", date: DAY });
  fold(repo, "deploys");
  const md = readFileSync(join(dir, "SKILL.md"), "utf8");
  assert.deepEqual(skillProblems(md, "deploys"), []);
  assert.match(md, /^allowed-tools: Bash\(make:\*\)$/m, "the team's own keys stay as they wrote them");
  assert.match(md, /^ {2}owner: "platform" # who to ask$/m, "and so do their metadata lines");
  assert.match(md, /^ {2}version: "4"$/m);
  assert.doesNotMatch(md, /^version:/m);
  assert.equal(getSkill(repo, "deploys")!.version, 4);
});

test("fold adds metadata to an old skill that has none, and writes an inline one out as a block", () => {
  const repo = tmpRepo("validate-inline");
  for (const [name, front] of [
    ["plain", "name: plain\ndescription: x\nversion: 1"],
    ["inline", 'name: inline\ndescription: x\nmetadata: { trail: "s-0a1b2c", owner: "platform", version: "2" }'],
  ] as const) {
    const dir = join(skillDirs(repo).repo, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skill(front));
    learn(repo, { skill: name, text: "A takeaway.", author: "Priya", date: DAY });
    fold(repo, name);
    const md = readFileSync(join(dir, "SKILL.md"), "utf8");
    assert.deepEqual(skillProblems(md, name), [], name);
  }
  assert.equal(getSkill(repo, "plain")!.version, 2);
  assert.equal(getSkill(repo, "inline")!.version, 3);
  const inline = readFileSync(join(skillDirs(repo).repo, "inline", "SKILL.md"), "utf8");
  assert.match(inline, /^ {2}owner: "platform"$/m);
  assert.match(inline, /^ {2}trail: "s-0a1b2c"$/m, "its own mark stays");
});
