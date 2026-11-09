/**
 * Python test runs from a venv, uv, tox, nox, poetry or unittest count as the tests check, and a run that
 * activates a venv first (`source .venv/bin/activate && ...`) can still become a tests skill: the activate goes
 * into the step. Any other shell setup still refuses. Found by a real end-to-end run on pytest-dev/pluggy,
 * where none of these was offered. Synthetic transcripts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { buildCandidates } from "../src/init/candidates.js";
import { mineJobs, type JobFind } from "../src/init/miners.js";
import { replaySession } from "../src/init/replay-runs.js";
import { checkFamilyOf, classifyCheck, type RunFacts } from "../src/trace/checks.js";
import { statementsOf } from "../src/skills/compile-split.js";
import type { JobClass } from "../src/trace/types.js";
import { day, done, SHOP, Tx, world, type World } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";
const NOW = new Date(day(20));
const OK = { failed: false, isError: false };
const NONE: RunFacts = { versions: [], shas: [], pushedBranches: [] };

test("venv, uv, poetry, tox, nox and unittest runs are the tests family", () => {
  for (const cmd of [
    ".venv/bin/python -m pytest -q testing", ".venv/bin/pytest -q", "./venv/bin/python3 -m pytest", "/Users/me/pluggy/.venv/bin/pytest -q testing",
    "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest -q", "uv run pytest -q", "uv run python -m pytest", "poetry run pytest", "pdm run pytest",
    "tox", "tox -e py312", "nox -s tests", "python -m unittest discover -s tests", "python3 -m unittest", ".venv/bin/python -m unittest",
    "source .venv/bin/activate && python -m pytest -q testing", ". venv/bin/activate && pytest",
  ]) assert.equal(checkFamilyOf(cmd, null), "tests", cmd);
  // A bin folder in front of something that isn't a test runner is not a test run.
  for (const cmd of [".venv/bin/python script.py", ".venv/bin/ruff check src", "uv run ruff check", "toxic", "poetry install"]) assert.equal(checkFamilyOf(cmd, null), null, cmd);
});

test("unittest's summary says whether it passed", () => {
  const pass = classifyCheck("python -m unittest", "....\n----------------------------------------------------------------------\nRan 4 tests in 0.002s\n\nOK", OK, NONE, null);
  assert.equal(pass?.passed, true);
  assert.equal(pass?.facts.passedCount, 4);
  const fail = classifyCheck("python -m unittest", "F...\n======\nFAIL: test_a (t.T)\n------\nRan 4 tests in 0.002s\n\nFAILED (failures=1)", OK, NONE, null);
  assert.equal(fail?.passed, false);
  assert.equal(classifyCheck("tox -e py", "226 passed in 1.20s\n  py: OK (2.10 seconds)\n  congratulations :) (2.20 seconds)", OK, NONE, null)?.passed, true);
});

const CTX = { repoRoot: "/r", home: "/h", job: "tests" as JobClass };
const brief = (cmd: string) => statementsOf(cmd, "", CTX).map((x) => [x.text, x.kind, ...(x.blocked ? [x.blocked] : [])]);

test("a venv's activate is carried into the step it is chained to; other setup still blocks", () => {
  assert.deepEqual(brief("source .venv/bin/activate && python -m pytest -q testing"), [["source .venv/bin/activate && python -m pytest -q testing", "step"]]);
  assert.deepEqual(brief(". venv/bin/activate && pytest -q"), [[". venv/bin/activate && pytest -q", "step"]]);
  assert.deepEqual(brief("echo hi && source .venv/bin/activate && pytest -q").at(-1), ["source .venv/bin/activate && pytest -q", "step"]);
  // Arbitrary setup is not known to be safe, nor a venv from a variable or outside the repo.
  assert.match(String(brief("source scripts/env.sh && pytest -q")[0]!.at(-1)), /needs its shell set up first/);
  assert.match(String(brief("source $VENV/bin/activate && pytest -q")[0]!.at(-1)), /needs its shell set up first/);
  assert.match(String(brief("source ../other/.venv/bin/activate && pytest -q")[0]!.at(-1)), /needs its shell set up first/);
  // On a line of its own the activate is not chained, so the next line can't be said word for word: blocked as before.
  assert.match(String(brief("source .venv/bin/activate\npython -m pytest -q")[0]!.at(-1)), /needs its shell set up first/);
});

function jobsOf(w: World, tx: Tx): JobFind[] {
  const p = tx.write(w.home, "sess-py");
  return mineJobs([replaySession(p, { from: 0, to: statSync(p).size }, SHOP, NOW, { env: w.env })]);
}

const PYTEST = { pass: "........\n226 passed in 1.20s", fail: "1 failed, 225 passed in 1.30s" };
const UNITTEST = { pass: "....\nRan 4 tests in 0.002s\n\nOK", fail: "F...\nRan 4 tests in 0.002s\n\nFAILED (failures=1)" };
const LINT = "ruff check src testing";

/** Init's candidates from three test days, two costly: a lint, then the test command fails first and passes (pluggy's shape). */
function initFrom(cmd: string, out = PYTEST, lint = LINT) {
  const w = world("py");
  try {
    const tx = new Tx(w.repo);
    for (const d of [3, 5, 7]) {
      tx.typed(day(d, 10, 0), "run the tests");
      tx.bash(day(d, 10, 5), lint, "All checks passed!");
      if (d !== 7) tx.bash(day(d, 10, 10), cmd, `Exit code 1\n${out.fail}`, { isError: true });
      tx.bash(day(d, 10, 20), cmd, out.pass);
      tx.said(day(d, 10, 30), "All tests pass.");
    }
    const skipped: Array<{ job: JobClass; why: string; days?: number }> = [];
    const c = buildCandidates({
      jobs: jobsOf(w, tx), walls: { v: 1, read: {}, classes: {} }, prefs: [], howtos: [], reviews: [], repoKey: SHOP, repoWords: new Set(), skills: true,
      closed: new Set(), closedV1: new Set(), kept: new Set(), deferred: new Set(), env: w.env, checkout: w.repo, skipped,
    }, NOW);
    return { skipped, steps: c.filter((x) => x.kind === "skill").map((x) => x.skill!.compiled.steps.map((s) => s.cmd)) };
  } finally {
    done(w);
  }
}

test("init offers a tests skill from venv, uv, tox, nox, poetry and unittest runs: no 'no-check' or 'multi-line' in the record", () => {
  for (const [cmd, out] of [
    [".venv/bin/python -m pytest -q testing", PYTEST], [".venv/bin/pytest -q testing", PYTEST], ["uv run pytest -q", PYTEST], ["tox -e py", PYTEST],
    ["nox -s tests", PYTEST], ["poetry run pytest", PYTEST], ["python -m unittest discover -s tests", UNITTEST],
    ["source .venv/bin/activate && python -m pytest -q testing", PYTEST], ["PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest -q", PYTEST],
  ] as const) {
    const r = initFrom(cmd, out);
    assert.deepEqual(r.skipped, [], cmd);
    assert.deepEqual(r.steps, [[LINT, cmd]], cmd);
  }
  // The lint step activated the venv too: it is carried into that step, word for word.
  const both = initFrom("source .venv/bin/activate && python -m pytest -q testing", PYTEST, `source .venv/bin/activate && ${LINT}`);
  assert.deepEqual(both.skipped, []);
  assert.deepEqual(both.steps, [[`source .venv/bin/activate && ${LINT}`, "source .venv/bin/activate && python -m pytest -q testing"]]);
});

test("init still refuses a tests run that needs arbitrary shell setup", () => {
  const r = initFrom("python -m pytest -q", PYTEST, `source scripts/env.sh && ${LINT}`);
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.skipped.map((x) => [x.job, x.why]), [["tests", "multi-line"]]);
});
