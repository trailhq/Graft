/**
 * A SKILL.md Trail wrote, back to the CompiledSkill that renders it (phase 2
 * design 4.4, P11): a fold edits through the renderer only when the file
 * round-trips byte for byte; a hand-edited file is read loosely, for a
 * proposal beside it (4.6), never for a write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildCompiled, rebuildLoose } from "../src/skills/skill-rebuild.js";
import { parseSkillMd, renderSkillMd } from "../src/skills/skillmd.js";
import { compileRun, type CompileOpts } from "../src/skills/compile.js";
import { HOME, KEY, ROOT, call, passed, renderedFixtures, sheet } from "./skills-fold-fixtures.js";
import { releaseSkill } from "./skills-recall-fixtures.js";
import type { CompiledSkill } from "../src/skills/types.js";

const SOURCE = { commands: 9, failed: 1, at: "2026-10-27T10:44:05.000Z" };
const rebuild = (text: string, name: string, extra = { source: SOURCE, helpers: [] as string[] }) => {
  const parsed = parseSkillMd(text, name);
  assert.ok(parsed, "parses");
  return rebuildCompiled(text, parsed, extra);
};

for (const { label, skill } of renderedFixtures()) {
  test(`rebuildCompiled round-trips: ${label}`, () => {
    const text = renderSkillMd(skill);
    const back = rebuild(text, skill.name);
    assert.ok(back, "rebuilt");
    assert.equal(renderSkillMd(back), text);
    assert.equal(back.name, skill.name);
    assert.equal(back.title, skill.title);
    assert.deepEqual(back.steps.map((s) => s.cmd), skill.steps.map((s) => s.cmd));
    assert.equal(back.checkIsStep, skill.checkIsStep && !!skill.check);
  });
}

const OPTS: CompileOpts = { repoRoot: ROOT, home: HOME, platform: "darwin", moment: "repeated", applies: KEY, taken: () => false };

test("rebuildCompiled round-trips what compile writes: a release with a version check, and a tests run whose check is a step", () => {
  const release = compileRun(sheet([
    call("git pull --ff-only origin main"),
    call("npm run build"),
    call("npm version 0.22.4 --no-git-tag-version"),
    call("npm publish --access public"),
    call("npm view acme-cli version", { tail: "0.22.4", check: passed("npm-view", { version: "0.22.4", pkg: "acme-cli" }) }),
  ], { checkIndex: 4, checked: true, promptParams: { version: "0.22.4" } }), OPTS);
  const tests = compileRun(sheet([
    call("npm ci", { job: "tests" }),
    call("npm test 2>&1 | tail -20", { job: "tests", check: passed("tests", { passedCount: 40 }) }),
  ], { job: "tests", checkIndex: 1, checked: true, counts: { commands: 2, failed: 1, toolCalls: 4, edits: 0 } }), OPTS);
  for (const r of [release, tests]) {
    assert.ok(r.ok, r.ok ? "" : `${r.reason}: ${r.detail}`);
    const text = renderSkillMd(r.skill);
    const back = rebuild(text, r.skill.name, { source: SOURCE, helpers: [] });
    assert.ok(back);
    assert.equal(renderSkillMd(back), text);
  }
  assert.equal(tests.ok && tests.skill.checkIsStep, true, "the tests skill's check is a step");
});

test("rebuildCompiled: one changed space gives null", () => {
  const text = renderSkillMd(releaseSkill());
  const edited = text.replace("2. `npm run build`", "2.  `npm run build`");
  assert.notEqual(edited, text);
  assert.equal(rebuild(edited, "release-npm"), null);
  assert.equal(rebuild(text.replace("## If it fails", "## If it fails "), "release-npm"), null);
  assert.equal(rebuild(text + "\n", "release-npm"), null);
});

test("rebuildCompiled: a parse of some other text gives null", () => {
  const text = renderSkillMd(releaseSkill());
  const other = parseSkillMd(renderSkillMd(releaseSkill({ asks: "publish" })), "release-npm")!;
  assert.equal(rebuildCompiled(text, other, { source: SOURCE, helpers: [] }), null);
});

test("rebuildCompiled: a file with no version line gives null (the renderer would write one)", () => {
  const text = renderSkillMd(releaseSkill()).replace('  version: "1"\n', "");
  assert.equal(rebuild(text, "release-npm"), null);
});

test("rebuildCompiled: an older layout and a hand-written skill give null", () => {
  const rotate = readFileSync(join(import.meta.dirname, "fixtures", "skills", "rotate-pages", "SKILL.md"), "utf8");
  assert.equal(rebuild(rotate, "rotate-pages"), null);
});

test("rebuildCompiled: source and helpers come from state and scripts/; the run id from the state's run", () => {
  const text = renderSkillMd(releaseSkill());
  const back = rebuildCompiled(text, parseSkillMd(text, "release-npm")!, { source: SOURCE, helpers: ["pack.sh"], runId: "r-1027-3f9a" });
  assert.ok(back);
  assert.deepEqual(back.source, { runId: "r-1027-3f9a", ...SOURCE });
  assert.deepEqual(back.helpers.map((h) => h.file), ["pack.sh"]);
  assert.deepEqual(back.helpers.map((h) => h.content), [""], "names only: a fold never writes scripts/");
  const none = rebuildCompiled(text, parseSkillMd(text, "release-npm")!, { source: null, helpers: [] });
  assert.deepEqual(none?.source, { runId: "", commands: 0, failed: 0, at: "" });
});

test("rebuildCompiled: the gated steps keep their marks and the meta stays in its order", () => {
  const skill = releaseSkill();
  const text = renderSkillMd(skill);
  const back = rebuild(text, "release-npm")!;
  assert.deepEqual(back.steps.map((s) => !!s.gated), skill.steps.map((s) => !!s.gated));
  assert.deepEqual(Object.keys(back.meta), Object.keys(skill.meta));
});

test("rebuildLoose reads a hand-edited file: a step added by hand, a sentence of prose, a space changed", () => {
  const text = renderSkillMd(releaseSkill())
    .replace("3. `npm pack`", "3. `npm pack`\n4. `npm run lint`")
    .replace("## Check it worked", "Some words the person wrote.\n\n## Check it worked")
    .replace("2. `npm run build`", "2.  `npm run build`");
  const parsed = parseSkillMd(text, "release-npm")!;
  assert.equal(rebuildCompiled(text, parsed, { source: SOURCE, helpers: [] }), null);
  const loose = rebuildLoose(text, parsed);
  assert.ok(loose);
  assert.equal(loose.title, "release-npm");
  assert.deepEqual(loose.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(loose.steps[3]!.cmd, "npm run lint");
  assert.equal(loose.checkIsStep, false);
  const again = parseSkillMd(renderSkillMd(loose), "release-npm")!;
  assert.deepEqual(again.steps.map((s) => s.cmd), parsed.steps.map((s) => s.cmd));
});

test("rebuildLoose: a file with no steps gives null; a check that is a step is read from its words", () => {
  const empty = renderSkillMd(releaseSkill({}, { steps: [] }));
  assert.equal(rebuildLoose(empty, parseSkillMd(empty, "release-npm")!), null);
  const tests: CompiledSkill = { ...releaseSkill({ check: "go test ./...", "check-shows": "ok" }), steps: [{ n: 1, cmd: "go test ./...", gated: null, bg: false, wait: false }], check: "go test ./...", checkShows: "ok", checkIsStep: true };
  const text = renderSkillMd(tests).replace("## Don't use for", "A line by hand.\n\n## Don't use for");
  const loose = rebuildLoose(text, parseSkillMd(text, "release-npm")!);
  assert.equal(loose?.checkIsStep, true);
});
