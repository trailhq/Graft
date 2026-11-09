/**
 * D101 item 5: a check whose pass comes only through an `|| echo ...`,
 * `|| true` or `|| :` fallback is not a check. `docker info || echo "docker
 * not running"` exits 0 when docker is down, so such a call never passes a
 * check, a run proven only by such calls is not a good run for an asked
 * save, and compile never takes such a call as the check. Made-up repo and
 * commands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCheck, fallbackOnly } from "../src/trace/checks.js";
import { checkedSuccess, lastGoodRun } from "../src/trace/runs.js";
import { compileRun } from "../src/skills/compile.js";
import type { CheckHit, RunCall, RunSheet } from "../src/trace/types.js";
import { emptyState, runCall, runState } from "./trace-run-fixtures.js";

const FALLBACKS = [
  'docker info || echo "docker not running"', "npm test || true", "npm test || :", "npm view acme-cli version || printf 'none\\n'",
  "gh pr checks 12 || exit 0", "npm test 2>&1 || echo failed", 'npm run build && npm test || { echo "tests failed"; }',
];
const PLAIN = [
  "npm test", "npm test && echo ok", "npm test; echo done", "npm test || npm test", "rm -f x || true; npm test", "echo a || b", "git push || git push --force-with-lease",
];

test("fallbackOnly: the call's last piece is an echo, printf, true, : or exit 0 after ||", () => {
  for (const c of FALLBACKS) assert.equal(fallbackOnly(c), true, c);
  for (const c of PLAIN) assert.equal(fallbackOnly(c), false, c);
  assert.equal(fallbackOnly(`${"npm test && ".repeat(100_000)}npm test`), false, "linear on a long command");
});

test("classifyCheck: a family call behind a fallback never passes", () => {
  const facts = { versions: ["1.4.3"], shas: [], pushedBranches: [] };
  assert.equal(classifyCheck("npm test", "Tests: 12 passed", { failed: false, isError: false }, facts, "tests")?.passed, true);
  assert.equal(classifyCheck("npm test || true", "Tests: 12 passed", { failed: false, isError: false }, facts, "tests")?.passed, false);
  assert.equal(classifyCheck("npm view acme-cli version || echo none", "1.4.3", { failed: false, isError: false }, facts, "release")?.passed, false);
});

const pass = (family: CheckHit["family"]): CheckHit => ({ family, passed: true, facts: {} });
const step = (cmd: string, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_${cmd.length}_${Math.random()}`, cmd, ...extra });

test("checkedSuccess: a pass stored on a fallback call (an older fold) is not the check", () => {
  const v = checkedSuccess(runState({ job: "tests", calls: [step("npm run build"), step("npm test || true", { check: pass("tests") })] }), "Done.");
  assert.equal(v.checked, false);
  assert.equal(v.why, "no-check");
  assert.equal(checkedSuccess(runState({ job: "tests", calls: [step("npm run build"), step("npm test", { check: pass("tests") })] }), "Done.").checked, true);
});

const home = (): NodeJS.ProcessEnv => ({ ...process.env, TRAIL_HOME: join(mkdtempSync(join(tmpdir(), "trace-fallback-")), ".trail") });

test("lastGoodRun: a run proven only by fallback calls is unproven (H6's docker info || echo)", () => {
  const env = home();
  const h6 = runState({ id: "r-1017-0001", job: null, closed: false, end: "done", calls: [step('docker info || echo "docker not running"')] });
  assert.deepEqual(lastGoodRun(emptyState({ runs: [h6] }), env), { none: "unproven" });
  const lastEcho = runState({ id: "r-1017-0002", job: null, closed: false, end: "done", calls: [step("npm run build"), step("npm run deploy || echo 'deploy failed'")] });
  assert.deepEqual(lastGoodRun(emptyState({ runs: [lastEcho] }), env), { none: "unproven" }, "the last step's echo fallback");
  const cleanup = runState({ id: "r-1017-0003", job: null, closed: false, end: "done", calls: [step("npm run build"), step("rm -rf .cache || true")] });
  assert.ok("sheet" in lastGoodRun(emptyState({ runs: [cleanup] }), env), "a cleanup's || true after real work stays good");
  const checked = runState({ id: "r-1017-0004", job: "tests", closed: false, end: "done", calls: [step("npm test || echo failed"), step("npm test", { check: pass("tests") })] });
  assert.ok("sheet" in lastGoodRun(emptyState({ runs: [checked] }), env), "a real check that passed proves it");
});

test("compile never takes a fallback call as the check", () => {
  const KEY = "github.com/acme/shop";
  const calls: RunCall[] = [
    step("npm publish acme-cli-1.4.3.tgz --access public", { key: KEY }),
    runCall({ id: "toolu_v", cmd: "npm view acme-cli version || echo none", kind: "look", key: KEY, check: pass("npm-view") }),
  ];
  const sheet: RunSheet = {
    v: 1, id: "r-1017-0005", session: "0123456789ab", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 0,
    startedAt: "2026-10-17T10:00:00Z", endedAt: "2026-10-17T10:05:00Z", job: "release", jobWords: [], sharedWords: [], promptParams: {},
    calls, checkIndex: 1, checked: true, end: "done", counts: { commands: 2, failed: 0, toolCalls: 2, edits: 0 }, helpers: [], skillId: null,
  };
  const opts = { repoRoot: "/home/dev/shop", home: "/home/dev", platform: "linux" as const, applies: KEY, taken: () => false };
  const repeated = compileRun(sheet, { ...opts, moment: "repeated" });
  assert.equal(repeated.ok, false);
  assert.equal(repeated.ok ? "" : repeated.reason, "no-check");
  const asked = compileRun(sheet, { ...opts, moment: "asked" });
  assert.ok(asked.ok, asked.ok ? "" : asked.reason);
  assert.equal(asked.ok && asked.skill.check, "", "no check taken from the fallback call");
});
