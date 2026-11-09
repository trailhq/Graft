/**
 * A skill saved from "ship it to prod" comes back on "ship it to prod". In a real run on pytest-dev/pluggy the
 * ship went `git push prod HEAD:main`: the remote named prod is where it went, but compile took the branch, named
 * the skill ship-main, and the ask naming prod matched nothing. A push to a remote named for a deploy target (prod,
 * production, staging, live) goes to that remote; the places the person named when the skill was saved count too.
 * Synthetic run sheets only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRun, type CompileOpts, type CompileResult } from "../src/skills/compile.js";
import { stableBranches } from "../src/skills/compile-words.js";
import { matchCue, normalizePrompt } from "../src/skills/recall.js";
import { callKind } from "../src/trace/checks.js";
import type { CheckHit, RunCall, RunSheet } from "../src/trace/types.js";
import type { CompiledSkill } from "../src/skills/types.js";
import { cand } from "./skills-recall-fixtures.js";

const KEY = "github.com/pytest-dev/pluggy";
const OPTS: CompileOpts = { repoRoot: "/home/dev/src/pluggy", home: "/home/dev", platform: "darwin", moment: "asked", applies: KEY, taken: () => false };
const NOW = new Date("2026-10-28T10:00:00.000Z");

let seq = 0;
function call(cmd: string, o: Partial<RunCall> = {}): RunCall {
  seq++;
  return {
    id: `toolu_${String(seq).padStart(3, "0")}`, at: new Date(Date.UTC(2026, 9, 27, 10, 31, 40) + seq * 20_000).toISOString(), cmd,
    key: KEY, cwd: "", bg: false, failed: false, isError: false, kind: callKind(cmd, "ship"), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...o,
  };
}
const passed = (family: CheckHit["family"]): CheckHit => ({ family, passed: true, facts: {} });

function sheet(calls: RunCall[], jobWords: string[]): RunSheet {
  return {
    v: 1, id: "r-1027-3f9a", session: "e76b4ca7f1a0", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 1,
    startedAt: "2026-10-27T10:31:40Z", endedAt: "2026-10-27T10:44:05Z", job: "ship", jobWords, sharedWords: [], promptParams: {},
    calls, checkIndex: calls.length - 1, checked: true, end: "done",
    counts: { commands: calls.length, failed: 0, toolCalls: calls.length, edits: 0 }, helpers: [], skillId: null,
  };
}
function ok(r: CompileResult): CompiledSkill {
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}
const fires = (c: CompiledSkill, prompt: string) => matchCue(normalizePrompt(prompt), [cand(c)], null, NOW)?.cand.ref.name ?? null;

/** pluggy's ship: lint, tests, push to the prod remote, read the remote back. */
const pluggyShip = (push: string) => [
  call("ruff check src testing"),
  call("PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=src python3 -m pytest -q testing"),
  call(push),
  call("git ls-remote prod main", { check: passed("ls-remote") }),
];

test("a push to a remote named for a deploy target goes to that remote", () => {
  const one = (cmd: string) => stableBranches([call(cmd)], []);
  assert.deepEqual(one("git push prod HEAD:main"), ["prod"]);
  assert.deepEqual(one("git push prod main"), ["prod"]);
  assert.deepEqual(one("git push production main"), ["production"]);
  assert.deepEqual(one("git push staging HEAD:main"), ["staging"]);
  assert.deepEqual(one("git push live main"), ["live"]);
  assert.deepEqual(one("git -C app push prod main"), ["prod"]);
  // Any other remote keeps the branch as the target.
  assert.deepEqual(one("git push origin main"), ["main"]);
  assert.deepEqual(one("git push origin HEAD:refs/heads/prod"), ["prod"]);
  assert.deepEqual(one("git push upstream beta"), ["beta"]);
});

test("a skill saved from \"ship it to prod\" fires on \"ship it to prod\", and still on \"ship it\" and \"push to main\"", () => {
  for (const push of ["git push prod HEAD:main", "git push prod main"]) {
    const c = ok(compileRun(sheet(pluggyShip(push), ["ship", "prod"]), OPTS));
    assert.equal(c.name, "ship-prod", push);
    assert.equal(c.title, "Ship pluggy to prod");
    for (const p of ["ship it to prod", "ship it", "push to main", "deploy to prod", "push to prod"]) assert.equal(fires(c, p), "ship-prod", `${push}: ${p}`);
    // A skill for prod still never comes for an ask that names only another place.
    assert.equal(fires(c, "push to beta"), null);
  }
});

test("the places named when the skill was saved count, though the push named a branch", () => {
  // CI deploys main to prod: the person said "ship it to prod", the agent pushed origin main.
  const c = ok(compileRun(sheet([
    call("npm test"), call("git push origin main"), call("git ls-remote origin main", { check: passed("ls-remote") }),
  ], ["ship", "prod"]), OPTS));
  assert.equal(c.name, "ship-main");
  for (const p of ["ship it to prod", "push to main", "ship it"]) assert.equal(fires(c, p), "ship-main", p);
  assert.equal(fires(c, "push to staging"), null);
  // Saved from words that name no place: nothing is added.
  const plain = ok(compileRun(sheet([
    call("npm test"), call("git push origin main"), call("git ls-remote origin main", { check: passed("ls-remote") }),
  ], ["ship"]), OPTS));
  assert.equal(plain.meta.asks, "push to main, deploy to main, update main, ship it");
});
