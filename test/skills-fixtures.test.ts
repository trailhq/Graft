/**
 * The SKILL.md files Trail writes, kept as fixtures in `test/fixtures/skills/`
 * so CI can run the Agent Skills reference validator (`skills-ref`) over them
 * (.github/workflows/ci.yml). This test keeps each fixture equal to what the
 * code writes today, and runs Trail's own check over it.
 *
 * After changing what Trail writes, refresh them:
 *   UPDATE_SKILL_FIXTURES=1 node --import tsx --test test/skills-fixtures.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillProblems } from "../src/skills/validate.js";
import { fold, learn, skillDirs } from "../src/skills/skills.js";
import { skillTemplate } from "../src/claude/skill-template.js";
import { tmpRepo } from "./helpers.js";

process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-fixtures-home-"));

const FIXTURES = join(process.cwd(), "test", "fixtures", "skills");
const DAY = "2026-10-07";

/** Each fixture's folder name and the text Trail writes for it now. */
function written(): Record<string, string> {
  const out: Record<string, string> = { trail: skillTemplate("trail"), graft: skillTemplate("graft") };

  // A new skill, with its first takeaway folded in.
  const repo = tmpRepo("fixtures-new");
  learn(repo, { skill: "rotate-pages", text: "Read rotation with page.Rotation(), never from the raw /Rotate key.", author: "Sam", date: DAY, description: "Rotating PDF pages: which way is up, and where boxes land", section: "Rotation" });
  out["rotate-pages"] = readFileSync(fold(repo, "rotate-pages")!.file, "utf8");

  // A repo's skill an older Trail folded into (its top-level `version: 2`), after a fold: Trail's mark and the version under metadata.
  const team = tmpRepo("fixtures-old");
  const dir = join(skillDirs(team).repo, "ship-docs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: ship-docs\ndescription: Builds and publishes the docs site. Use when asked to ship or publish the docs.\nlicense: MIT\nallowed-tools: Bash(make:*)\nversion: 2\n---\n\n# ship-docs\n\n## Run\n1. `make docs`\n2. `make publish-docs`\n",
  );
  learn(team, { skill: "ship-docs", text: "Run make docs-check first: a broken link fails the publish.", author: "Priya", date: DAY, section: "Run" });
  out["ship-docs"] = readFileSync(fold(team, "ship-docs")!.file, "utf8");
  return out;
}

test("the skill fixtures are what Trail writes, and each passes the spec check", () => {
  const now = written();
  if (process.env.UPDATE_SKILL_FIXTURES === "1") {
    for (const [name, text] of Object.entries(now)) {
      mkdirSync(join(FIXTURES, name), { recursive: true });
      writeFileSync(join(FIXTURES, name, "SKILL.md"), text);
    }
  }
  assert.deepEqual(readdirSync(FIXTURES).sort(), Object.keys(now).sort(), "one fixture per kind of SKILL.md Trail writes");
  for (const [name, text] of Object.entries(now)) {
    const file = join(FIXTURES, name, "SKILL.md");
    assert.ok(existsSync(file), `${file} is missing: refresh the fixtures (see the top of this file)`);
    // A Windows checkout may turn the fixture's line ends into CRLF.
    assert.equal(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), text, `${name}'s fixture is stale: refresh the fixtures (see the top of this file)`);
    assert.deepEqual(skillProblems(text, name), [], name);
  }
});

// A fixture that exists only on this disk passes here and fails in CI, where
// the checkout has only what git tracks. `graft/` is ignored repo-wide (the
// code map's own folder), which once hid the graft skill's fixture.
test("every skill fixture is in git, not ignored", () => {
  for (const name of Object.keys(written())) {
    const file = join("test", "fixtures", "skills", name, "SKILL.md");
    const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: process.cwd() });
    assert.equal(ignored.status, 1, `${file} is ignored by .gitignore, so CI never sees it`);
  }
});
