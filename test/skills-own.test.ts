/**
 * Which SKILL.md files Trail may rewrite (spec section 6): one key under
 * `metadata`, `trail`, marks a skill as Trail's, and Trail never touches any
 * other. A skill kept on this machine is Trail's too, and so is one an older
 * Trail already versioned with a top-level `version: 3` line. A fold reads
 * the front matter the way the reader does (a BOM, spaces after a fence, CRLF
 * line ends), so a rewrite never loses the skill's name or description.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, getSkill, learn, publish, skillDirs, skillForAgent } from "../src/skills/skills.js";
import { skillProblems } from "../src/skills/validate.js";
import { tmpRepo } from "./helpers.js";

process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-own-home-"));

const DAY = "2026-10-07";
const MARK = /^ {2}trail: "s-[0-9a-f]{6}"$/m;

/** A repo whose `.claude/skills/deploys/SKILL.md` is `text`, with one takeaway waiting. */
function repoWith(tag: string, text: string): { repo: string; file: string } {
  const repo = tmpRepo(tag);
  const dir = join(skillDirs(repo).repo, "deploys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
  learn(repo, { skill: "deploys", text: "Run the migration check first.", author: "Priya", date: DAY });
  return { repo, file: join(dir, "SKILL.md") };
}

test("a hand-written skill is never rewritten: the fold leaves its SKILL.md byte for byte, and the takeaway still reaches the agent", () => {
  for (const [tag, text] of [
    ["plain", "---\nname: deploys\ndescription: How this repo ships\nallowed-tools: Bash(make:*)\n---\n\n# deploys\n\nShip with make ship.\n"],
    ["semver", '---\nname: deploys\ndescription: How this repo ships\nmetadata:\n  author: platform\n  version: "1.0.0"\n---\n\n# deploys\n\nShip.\n'],
    ["float-version", "---\nname: deploys\ndescription: How this repo ships\nversion: 1.0\n---\n\n# deploys\n\nShip.\n"],
  ] as const) {
    const { repo, file } = repoWith(`own-hand-${tag}`, text);
    const r = fold(repo, "deploys")!;
    assert.equal(r.left, "hand-written", tag);
    assert.deepEqual(r.folded, [], tag);
    assert.equal(r.to, r.from, tag);
    assert.equal(readFileSync(file, "utf8"), text, `${tag}: untouched`);
    const s = getSkill(repo, "deploys")!;
    assert.equal(s.takeaways[0]!.foldedIn, undefined, `${tag}: still waiting`);
    assert.match(skillForAgent(s), /## Corrections since v\d[^\n]*\n- Run the migration check first\./, `${tag}: the agent still reads it`);
  }
});

test("a skill Trail starts carries the trail marker, and stays Trail's after it moves into the repo", () => {
  const repo = tmpRepo("own-new");
  const r = learn(repo, { skill: "pdf-coords", text: "Boxes are in points.", author: "Sam", date: DAY, description: "PDF coordinates" });
  assert.match(readFileSync(r.skill.file, "utf8"), MARK);
  fold(repo, "pdf-coords");
  assert.equal(publish(repo, "pdf-coords").ok, true);
  learn(repo, { skill: "pdf-coords", text: "Rotation is clockwise.", author: "Sam", date: DAY });
  const f = fold(repo, "pdf-coords")!;
  assert.equal(f.left, undefined);
  assert.equal(f.where, "repo");
  assert.equal(f.to, 3);
  const md = readFileSync(f.file, "utf8");
  assert.match(md, /- Rotation is clockwise\./);
  assert.equal((md.match(/trail: /g) ?? []).length, 1, "one marker");
});

test("an old skill with a top-level version is Trail's: the fold moves the version, marks it, and the next fold works too", () => {
  const { repo, file } = repoWith("own-old", "---\nname: deploys\ndescription: How this repo ships\nversion: 2\n---\n\n# deploys\n\nShip.\n");
  assert.equal(fold(repo, "deploys")!.to, 3);
  const once = readFileSync(file, "utf8");
  assert.match(once, MARK);
  assert.doesNotMatch(once, /^version:/m);
  learn(repo, { skill: "deploys", text: "Tag after the deploy.", author: "Priya", date: DAY });
  const again = fold(repo, "deploys")!;
  assert.equal(again.left, undefined);
  assert.equal(again.to, 4);
  const md = readFileSync(file, "utf8");
  assert.equal(md.match(MARK)?.[0], once.match(MARK)?.[0], "the marker doesn't change");
  assert.deepEqual(skillProblems(md, "deploys"), []);
});

test("a fold reads the fences as the reader does: a BOM or spaces after a fence never cost a skill its name", () => {
  for (const [tag, text] of [
    ["bom", "﻿---\nname: deploys\ndescription: How this repo ships\nversion: 3\n---\n\n# deploys\n\nShip.\n"],
    ["space-close", "---\nname: deploys\ndescription: How this repo ships\nversion: 3\n--- \n\n# deploys\n\nShip.\n"],
    ["space-open", "--- \nname: deploys\ndescription: How this repo ships\nversion: 3\n---\n\n# deploys\n\nShip.\n"],
  ] as const) {
    const { repo, file } = repoWith(`own-fence-${tag}`, text);
    assert.equal(fold(repo, "deploys")!.to, 4, tag);
    const md = readFileSync(file, "utf8");
    assert.deepEqual(skillProblems(md, "deploys"), [], tag);
    assert.match(md, /^name: deploys$/m, tag);
    assert.match(md, /^description: How this repo ships$/m, tag);
    assert.ok(!md.startsWith("﻿"), `${tag}: no BOM, which the reference validator refuses`);
  }
});

test("a fold keeps a CRLF skill's line ends, so only the lines that changed show in the diff", () => {
  const before = "---\r\nname: deploys\r\ndescription: How this repo ships\r\nversion: 3\r\n---\r\n\r\n# deploys\r\n\r\nShip with make ship.\r\n";
  const { repo, file } = repoWith("own-crlf", before);
  fold(repo, "deploys");
  const md = readFileSync(file, "utf8");
  assert.doesNotMatch(md.replace(/\r\n/g, ""), /\n/, "every line ends in CRLF");
  for (const line of ["name: deploys", "description: How this repo ships", "# deploys", "Ship with make ship."]) assert.ok(md.includes(`${line}\r\n`), line);
  assert.deepEqual(skillProblems(md, "deploys"), []);
});

test("a SKILL.md whose front matter can't be found is left alone, never rewritten without its name", () => {
  const text = "---yaml\nname: deploys\ndescription: How this repo ships\nversion: 3\n---\n\n# deploys\n";
  const { repo, file } = repoWith("own-nofence", text);
  const r = fold(repo, "deploys");
  if (r) assert.deepEqual(r.folded, []);
  assert.equal(readFileSync(file, "utf8"), text);
});

test("a fold finds metadata's indent from its keys, not from a comment above them", () => {
  const { repo, file } = repoWith("own-comment", "---\nname: deploys\ndescription: How this repo ships\nversion: 2\nmetadata:\n    # who to ask\n  owner: platform\n---\n\n# deploys\n");
  fold(repo, "deploys");
  const md = readFileSync(file, "utf8");
  assert.deepEqual(skillProblems(md, "deploys"), []);
  assert.match(md, /^ {2}owner: platform\n {2}trail: "s-[0-9a-f]{6}"\n {2}version: "3"$/m);
});

test("a new skill's description never holds ---, which ends the front matter early for the reference validator", () => {
  const repo = tmpRepo("own-dashes");
  const r = learn(repo, { skill: "release", text: "t", author: "Sam", date: DAY, description: 'Publishes: "npm" --- then tags' });
  assert.deepEqual(skillProblems(readFileSync(r.skill.file, "utf8"), "release"), []);
  assert.equal(getSkill(repo, "release")!.description, 'Publishes: "npm" -- then tags');
});

test("a name with nothing a folder can hold finds no skill, never .claude/skills/SKILL.md itself", () => {
  const repo = tmpRepo("own-empty-name");
  mkdirSync(skillDirs(repo).repo, { recursive: true });
  writeFileSync(join(skillDirs(repo).repo, "SKILL.md"), "---\nname: stray\ndescription: x\nversion: 1\n---\n\nnot a skill folder\n");
  assert.equal(getSkill(repo, "日本語"), null);
  assert.equal(getSkill(repo, "!!!"), null);
  assert.equal(fold(repo, "日本語"), null);
});
