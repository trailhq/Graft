/**
 * Part 7: the matcher between a learning's words and a skill's steps, with
 * no model. It catches tool and command preferences against a step's program
 * and arguments, and says nothing when it isn't sure: the near-misses here
 * must match nothing. Made-up commands and repos only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSteps, rulesOf } from "../src/skills/learning-steps.js";

const STEPS = [
  "npm ci",
  "python scripts/gen_schema.py",
  "(cd api && npm run build)",
  "npm test",
  "sed -i 's/v1/v2/' src/_schema.py",
  "npx prisma db push",
  "git push origin {branch}",
  "make lint",
];
const verdict = (text: string, steps = STEPS) => matchSteps(rulesOf(text).rules, steps);

test("use pnpm, not npm: every npm step goes against it, each written pnpm's way", () => {
  for (const text of ["use pnpm, not npm", "Use pnpm instead of npm.", "use `pnpm` rather than `npm`", "don't use npm, use pnpm", "prefer pnpm over npm", "prefer pnpm to npm"]) {
    assert.deepEqual(verdict(text), {
      repeats: [],
      contradicts: [
        { step: 1, fix: "pnpm install --frozen-lockfile" },
        { step: 3, fix: "(cd api && pnpm run build)" },
        { step: 4, fix: "pnpm test" },
      ],
    }, text);
  }
});

test("the same preference repeats the steps that already use pnpm", () => {
  assert.deepEqual(verdict("use pnpm, not npm", ["pnpm install", "pnpm test"]), { repeats: [1, 2], contradicts: [] });
});

test("bun runs a package's test script with bun run test; yarn has no safe twin for npm ci", () => {
  assert.deepEqual(verdict("use bun, not npm", ["npm test", "npm ci"]).contradicts, [{ step: 1, fix: "bun run test" }, { step: 2, fix: "bun install --frozen-lockfile" }]);
  assert.deepEqual(verdict("use yarn, not npm", ["npm ci", "npm test"]).contradicts, [{ step: 1, fix: null }, { step: 2, fix: "yarn test" }]);
});

test("a step Trail can't rewrite safely (a pipe, an env prefix, flags it doesn't know) still goes against it, with no fix", () => {
  assert.deepEqual(verdict("use pnpm, not npm", ["npm test | tee out.log", "CI=1 npm test", "npm publish --access public", "npm test -- --watch"]).contradicts,
    [{ step: 1, fix: null }, { step: 2, fix: null }, { step: 3, fix: null }, { step: 4, fix: null }]);
});

test("the schema example: don't edit _schema.py by hand, run scripts/gen_schema.py repeats the step that runs it", () => {
  for (const text of ["don't edit _schema.py by hand, run scripts/gen_schema.py", "run scripts/gen_schema.py instead of editing _schema.py",
    "Don't hand-edit `_schema.py`; run `scripts/gen_schema.py`."]) {
    const r = rulesOf(text);
    assert.equal(r.whole, true, text);
    assert.deepEqual(matchSteps(r.rules, ["python scripts/gen_schema.py", "pytest -q"]), { repeats: [1], contradicts: [] }, text);
    assert.deepEqual(matchSteps(r.rules, ["./scripts/gen_schema.py && pytest -q"]), { repeats: [1], contradicts: [] }, text);
  }
  // A step that writes the file itself goes against it.
  assert.deepEqual(verdict("don't edit _schema.py by hand, run scripts/gen_schema.py").contradicts, [{ step: 5, fix: null }]);
  assert.deepEqual(verdict("never edit src/_schema.py", ["cp /tmp/x.py src/_schema.py", "echo x > src/_schema.py", "cat src/_schema.py"]).contradicts,
    [{ step: 1, fix: null }, { step: 2, fix: null }]);
});

test("never and don't: the program, or the program with its arguments first", () => {
  assert.deepEqual(verdict("never run npx prisma db push").contradicts, [{ step: 6, fix: null }]);
  assert.deepEqual(verdict("don't use npx").contradicts, [{ step: 6, fix: null }]);
  assert.deepEqual(verdict("avoid running npx prisma migrate").contradicts, [], "another subcommand is not this one");
});

test("always run Y before Z: in order repeats, Z without Y first goes against it", () => {
  assert.deepEqual(verdict("always run make lint before git push", ["make lint", "git push origin main"]), { repeats: [1], contradicts: [] });
  assert.deepEqual(verdict("run `make lint` before `git push`", ["git push origin main", "make lint"]).contradicts, [{ step: 1, fix: null }]);
  assert.deepEqual(verdict("before git push, always run make lint", ["make build", "git push origin main"]).contradicts, [{ step: 2, fix: null }]);
});

test("a whole command for a whole command is written the person's way", () => {
  assert.deepEqual(verdict("run `pytest -q` instead of `npm test`").contradicts, [{ step: 4, fix: "pytest -q" }]);
  assert.deepEqual(verdict("run `pytest -q` instead of `npm test`", ["npm test -- --ci"]).contradicts, [{ step: 1, fix: null }], "more than the named command: no fix");
});

test("near-misses say nothing", () => {
  const nothing = [
    "always run the tests before pushing", // no command named
    "npm is slow here", // no shape
    "we decided not to use npm here", // a decision's words, not a command shape
    "use pnpm not npm in CI", // a qualifier the matcher doesn't read
    "use the staging database", // no program
    "prefer small PRs over big ones", // English, not commands
    "run it again", // no program
    "never run git push --force", // the steps push without --force
    "don't use npm ci, it wipes node_modules", // npm ci has args the steps' npm calls don't
  ];
  const steps = ["pnpm install", "git push origin main", "npm test", "make lint"];
  for (const text of nothing) assert.deepEqual(matchSteps(rulesOf(text).rules, steps), { repeats: [], contradicts: [] }, text);
});

test("a program name inside another word or argument never matches", () => {
  assert.deepEqual(verdict("never run npm", ["pnpm test", "npmx run", "node scripts/npm-check.js", "echo npm"]), { repeats: [], contradicts: [] });
  assert.deepEqual(verdict("never run git push", ["git pushx", "git status", "gh pr create"]), { repeats: [], contradicts: [] });
});

test("whole is false when part of the learning isn't read, so a line can't quote it as if it were all of it", () => {
  assert.equal(rulesOf("use pnpm, not npm").whole, true);
  assert.equal(rulesOf("use pnpm, not npm. The lockfile is pnpm-lock.yaml.").whole, false);
  assert.equal(rulesOf("don't use npm, it is slow").whole, false);
  assert.equal(rulesOf("").whole, false);
});

test("two rules that would write one step two ways write it neither way", () => {
  const rules = [...rulesOf("use pnpm, not npm").rules, ...rulesOf("use yarn, not npm").rules];
  assert.deepEqual(matchSteps(rules, ["npm test"]).contradicts, [{ step: 1, fix: null }]);
});
