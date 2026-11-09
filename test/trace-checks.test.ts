/**
 * The checks that prove a job worked: tests that pass, `npm view` showing the
 * version this run published, a deploy that is success or READY at the pushed
 * commit, CI checks all green, `git ls-remote` showing the commit, and a
 * report query that came back. And how a turn's last words are read: done,
 * ended in a failure, or ended in a question.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunCall } from "../src/trace/types.js";
import { READ_ONLY_FAMILIES, callKind, checkFamilyOf, classifyCheck, endsInFailure, endsInQuestion, factsFromCalls, type RunFacts } from "../src/trace/checks.js";

const OK = { failed: false, isError: false };
const BAD = { failed: true, isError: true };
const NONE: RunFacts = { versions: [], shas: [], pushedBranches: [] };

let n = 0;
function call(cmd: string, over: Partial<RunCall> = {}): RunCall {
  n++;
  return { id: `toolu_${n}`, at: "2026-10-27T10:31:52Z", cmd, key: "github.com/acme/store", cwd: "", bg: false, failed: false, isError: false, kind: "step", src: { use: n * 100, result: n * 100 + 50 }, ...over };
}

test("check families from the command alone, the last simple command that has one", () => {
  const cases: Array<[string, string | null]> = [
    ["npm test", "tests"], ["npm run test:unit 2>&1 | tail -20", "tests"], ["pnpm run test", "tests"], ["pnpm test", "tests"], ["yarn test", "tests"], ["bun test", "tests"],
    ["npx vitest run src/cart.test.ts", "tests"], ["vitest run", "tests"], ["npx jest cart", "tests"], ["cd backend && go test ./...", "tests"], ["pytest -q", "tests"],
    ["python3 -m pytest tests/", "tests"], ["cargo test", "tests"], ["node --import tsx --test test/a.test.ts", "tests"], ["make test-integration", "tests"],
    ["CI=1 timeout 300 npm test", "tests"],
    ["npm view @acme/cli version", "npm-view"], ["npm view @acme/cli@1.4.3 version", "npm-view"], ["npm info @acme/cli version", "npm-view"], ["npm show acme-cli version", "npm-view"],
    ["gh api repos/acme/store/commits/9c8b7a6/statuses --jq '.[0].state'", "deploy"], ["gh api repos/acme/x/commits/9c8b7a6/check-runs", "deploy"],
    ["vercel inspect https://x.vercel.app", "deploy"], ["netlify status", "deploy"], ["fly status", "deploy"], ["kubectl rollout status deploy/web", "deploy"],
    ["gh pr checks 12", "gh-checks"], ["gh pr checks", "gh-checks"], ["gh run watch 991 --exit-status", "gh-checks"], ["gh run view 991", "gh-checks"],
    ["git ls-remote origin prod", "ls-remote"], ["git ls-remote --heads origin refs/heads/prod", "ls-remote"],
    ["npm run build && npm test", "tests"], ["npm test && npm view @acme/cli version", "npm-view"],
    ["npm run build", null], ["git push origin beta", "push"], ["git -C backend push origin beta", "push"], ["gh run watch 991", null], ["gh api repos/acme/x/pulls", null], ["npm publish", null],
    ['psql "$DATABASE_URL" -c "select count(*) from users"', null],
  ];
  for (const [cmd, want] of cases) assert.equal(checkFamilyOf(cmd, null), want, cmd);
  assert.deepEqual([...READ_ONLY_FAMILIES].sort(), ["deploy", "gh-checks", "ls-remote", "npm-view"]);
});

test("the query family exists only for a report", () => {
  for (const cmd of [
    'psql "$DATABASE_URL" -c "select count(*) from users where created_at > now() - interval \'1 day\'"',
    "docker exec db psql -U app -c 'select 1'", "sqlite3 app.db 'select count(*) from users'", "mysql -u app -e 'select 1'", "bq query 'select 1'",
    "supabase db query 'select 1'", "curl -s https://abc.supabase.co/rest/v1/users?select=id",
  ]) {
    assert.equal(checkFamilyOf(cmd, "report"), "query", cmd);
    assert.equal(checkFamilyOf(cmd, null), null, cmd);
    assert.equal(checkFamilyOf(cmd, "ship"), null, cmd);
  }
});

test("tests: each runner's pass line with no fail line", () => {
  const pass: Array<[string, string, number | undefined]> = [
    ["npx vitest run", " ✓ src/cart.test.ts (12 tests) 30ms\n\n Test Files  3 passed (3)\n      Tests  42 passed (42)\n   Duration  1.2s", 42],
    ["npx jest", "PASS src/cart.test.ts\nTest Suites: 3 passed, 3 total\nTests:       41 passed, 41 total", 41],
    ["go test ./...", "ok  \tacme/shop/cart\t0.2s\nok  \tacme/shop/pay\t0.3s", undefined],
    ["pytest -q", "........\n8 passed in 0.12s", 8],
    ["node --test", "# tests 12\n# pass 12\n# fail 0", 12],
    ["node --test", "ℹ tests 9\nℹ pass 9\nℹ fail 0", 9],
    ["cargo test", "running 5 tests\ntest result: ok. 5 passed; 0 failed; 0 ignored", 5],
    ["make test", "all good", undefined],
  ];
  for (const [cmd, out, count] of pass) {
    const hit = classifyCheck(cmd, out, OK, NONE, null);
    assert.equal(hit?.family, "tests", cmd);
    assert.equal(hit?.passed, true, `${cmd}: ${out}`);
    assert.equal(hit?.facts.passedCount, count, cmd);
  }
  const fail: Array<[string, string]> = [
    ["npx vitest run", " Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 41 passed (42)"],
    ["npx jest", "Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 40 passed, 41 total"],
    ["go test ./...", "ok  \tacme/shop/cart\t0.2s\n--- FAIL: TestPay (0.01s)\nFAIL\tacme/shop/pay\t0.3s"],
    ["pytest -q", "1 failed, 7 passed in 0.2s"],
    ["node --test", "# pass 11\n# fail 1"],
    ["cargo test", "test result: FAILED. 4 passed; 1 failed"],
    ["npm test", "✓ handles a failed upload\n Test Files  0 passed\n Tests  no tests"],
  ];
  for (const [cmd, out] of fail) assert.equal(classifyCheck(cmd, out, OK, NONE, null)?.passed, false, `${cmd}: ${out}`);
  // A test name with "failed" in it is not a failure line.
  assert.equal(classifyCheck("npx vitest run", " ✓ shows a failed upload\n Test Files  3 passed (3)\n      Tests  42 passed (42)", OK, NONE, null)?.passed, true);
  // The call's own failure wins over a pass line.
  assert.equal(classifyCheck("npx vitest run", " Test Files  3 passed (3)", BAD, NONE, null)?.passed, false);
});

test("tests: through a pipe the exit code is the last program's, so only a runner's summary can say they passed", () => {
  // head cut the summary off; grep -v hid the failures; the exit code was head's or grep's.
  for (const [cmd, out] of [
    ["npm test 2>&1 | head -50", " ✓ src/cart.test.ts (12 tests)\n ✓ src/pay.test.ts (3 tests)\n"],
    ["npm test 2>&1 | grep -v -i fail", " ✓ src/cart.test.ts\n"],
    ["pytest -q | head -3", "........\n"],
    ["make test | tee test.log", "all good"],
  ]) assert.equal(classifyCheck(cmd!, out!, OK, NONE, null)?.passed, false, cmd);
  // The summary made it through: a pass.
  assert.equal(classifyCheck("npm test 2>&1 | tail -5", "      Tests  42 passed (42)\n", OK, NONE, null)?.passed, true);
  assert.equal(classifyCheck("pytest -q | tail -1", "8 passed in 0.12s", OK, NONE, null)?.passed, true);
  // mocha says passing and failing.
  assert.deepEqual(classifyCheck("npm test", "  cart\n    ✓ adds\n\n  5 passing (10ms)\n", OK, NONE, null), { family: "tests", passed: true, facts: { passedCount: 5 } });
  assert.equal(classifyCheck("npm test | tail -3", "  5 passing (10ms)\n  1 failing\n", OK, NONE, null)?.passed, false);
});

test("npm-view passes on a version this run is about", () => {
  const facts: RunFacts = { versions: ["1.4.3"], shas: [], pushedBranches: [] };
  const hit = classifyCheck("npm view @acme/cli version", "1.4.3\n", OK, facts, "release");
  assert.deepEqual(hit, { family: "npm-view", passed: true, facts: { version: "1.4.3", pkg: "@acme/cli" } });
  assert.equal(classifyCheck("npm view @acme/cli version", "1.4.2\n", OK, facts, "release")?.passed, false);
  assert.equal(classifyCheck("npm view @acme/cli version", "1.4.30\n", OK, facts, "release")?.passed, false, "a longer version is another version");
  assert.equal(classifyCheck("npm view @acme/cli versions --json", '[\n  "1.4.2",\n  "1.4.3"\n]', OK, facts, "release")?.passed, true);
  assert.equal(classifyCheck("npm view @acme/cli version", "npm error code E404", BAD, facts, "release")?.passed, false);
  // Nothing known to look for: any version, but only after a publish that worked in this run.
  assert.equal(classifyCheck("npm view @acme/cli version", "1.4.3", OK, NONE, "release")?.passed, false);
  const published: RunFacts = { ...NONE, published: true };
  assert.deepEqual(classifyCheck("npm view @acme/cli version", "1.4.3", OK, published, "release")?.facts, { version: "1.4.3", pkg: "@acme/cli" });
  assert.equal(classifyCheck("npm view @acme/cli@1.4.3 version", "1.4.3", OK, facts, null)?.facts.pkg, "@acme/cli");
});

test("deploy: success or READY, never pending or failure", () => {
  const cmd = "gh api repos/acme/store/commits/9c8b7a6/statuses --jq '.[0].state'";
  assert.deepEqual(classifyCheck(cmd, "success\n", OK, NONE, "ship"), { family: "deploy", passed: true, facts: { sha: "9c8b7a6", state: "success" } });
  assert.equal(classifyCheck(cmd, "pending\n", OK, NONE, "ship")?.passed, false);
  assert.equal(classifyCheck(cmd, '"success"', OK, NONE, "ship")?.passed, true);
  const combined = '{"state": "success", "statuses": [{"state": "success", "context": "Vercel"}]}';
  assert.equal(classifyCheck("gh api repos/acme/store/commits/9c8b7a6/status", combined, OK, NONE, "ship")?.passed, true);
  assert.equal(classifyCheck("gh api repos/acme/store/commits/9c8b7a6/status", '{"state": "pending", "statuses": [{"state": "pending"}]}', OK, NONE, "ship")?.passed, false);
  const runs = '{"check_runs": [{"status": "completed", "conclusion": "success"}, {"status": "completed", "conclusion": "skipped"}]}';
  assert.equal(classifyCheck("gh api repos/acme/x/commits/9c8b7a6/check-runs", runs, OK, NONE, "ship")?.passed, true);
  const runFailed = '{"check_runs": [{"status": "completed", "conclusion": "failure"}]}';
  assert.equal(classifyCheck("gh api repos/acme/x/commits/9c8b7a6/check-runs", runFailed, OK, NONE, "ship")?.passed, false);
  assert.equal(classifyCheck("vercel inspect https://x.vercel.app", "  id   dpl_1\n  status   ● Ready\n  url  https://x.vercel.app", OK, NONE, "ship")?.passed, true);
  assert.equal(classifyCheck("vercel inspect https://x.vercel.app", "  status   ● Error", OK, NONE, "ship")?.passed, false);
  assert.equal(classifyCheck("kubectl rollout status deploy/web", 'deployment "web" successfully rolled out', OK, NONE, "ship")?.passed, true);
  assert.equal(classifyCheck("vercel ls", "Age  Deployment  Status\n1m  x.vercel.app  ● Ready\n2d  y.vercel.app  ● Error", OK, NONE, "ship")?.passed, false);
});

test("gh-checks: every check passing or skipped", () => {
  assert.deepEqual(classifyCheck("gh pr checks 12", "build\tpass\t1m2s\thttps://x\nlint\tskipping\t0\thttps://y", OK, NONE, null),
    { family: "gh-checks", passed: true, facts: { pr: "12" } });
  assert.equal(classifyCheck("gh pr checks 12", "build\tpass\t1m\thttps://x\ne2e\tpending\t0\thttps://y", BAD, NONE, null)?.passed, false);
  assert.equal(classifyCheck("gh pr checks 12", "build\tfail\t1m\thttps://x", BAD, NONE, null)?.passed, false);
  assert.equal(classifyCheck("gh pr checks 12", "", OK, NONE, null)?.passed, false);
  assert.equal(classifyCheck("gh run watch 991 --exit-status", "✓ main CI · 991\nRun CI (991) completed with 'success'", OK, NONE, null)?.passed, true);
  assert.equal(classifyCheck("gh run watch 991 --exit-status", "X main CI · 991\nRun CI (991) completed with 'failure'", BAD, NONE, null)?.passed, false);
  assert.equal(classifyCheck("gh run view 991", "✓ main CI · 991\nTriggered via push\n\nJOBS\n✓ build in 1m2s", OK, NONE, null)?.passed, true);
  // The run's state read as fields: completed with a success conclusion, and nothing else in it.
  assert.equal(classifyCheck("gh run view 991 --json status,conclusion -q '\"\\(.status) \\(.conclusion)\"'", "completed success", OK, NONE, null)?.passed, true);
  assert.equal(classifyCheck("gh run view 991 --json status,conclusion", '{"conclusion":"success","status":"completed"}', OK, NONE, null)?.passed, true);
  assert.equal(classifyCheck("gh run view 991 --json status,conclusion", '{"conclusion":"","status":"in_progress"}', OK, NONE, null)?.passed, false);
  assert.equal(classifyCheck("gh run view 991 --json status,conclusion", "completed cancelled", OK, NONE, null)?.passed, false);
  assert.equal(classifyCheck("gh run view 991 --json jobs", '{"jobs":[{"conclusion":"success","status":"completed"},{"conclusion":"failure","status":"completed"}]}', OK, NONE, null)?.passed, false);
  assert.equal(classifyCheck("gh run view 991 --json status", "in_progress", OK, NONE, null)?.passed, false);
});

test("ls-remote: the remote has a commit this run pushed", () => {
  const facts: RunFacts = { versions: [], shas: ["9c8b7a6"], pushedBranches: ["beta", "prod"] };
  const out = "9c8b7a6f00ba5e0a1c2d3e4f5a6b7c8d9e0f1a2b\trefs/heads/prod\n";
  assert.deepEqual(classifyCheck("git ls-remote origin prod", out, OK, facts, "ship"),
    { family: "ls-remote", passed: true, facts: { sha: "9c8b7a6", remote: "origin", branch: "prod" } });
  assert.equal(classifyCheck("git ls-remote origin prod", "1f2e3d4aa00ba5e0a1c2d3e4f5a6b7c8d9e0f1a2\trefs/heads/prod", OK, facts, "ship")?.passed, false);
  assert.equal(classifyCheck("git ls-remote origin prod", out, OK, NONE, "ship")?.passed, false);
});

test("query: no error and something came back", () => {
  const cmd = 'psql "$DATABASE_URL" -c "select count(*) from users"';
  assert.equal(classifyCheck(cmd, " count \n-------\n    12\n(1 row)\n", OK, NONE, "report")?.passed, true);
  assert.equal(classifyCheck(cmd, "(0 rows)", OK, NONE, "report")?.passed, true);
  assert.equal(classifyCheck(cmd, 'ERROR:  relation "user" does not exist', OK, NONE, "report")?.passed, false);
  assert.equal(classifyCheck(cmd, "", OK, NONE, "report")?.passed, false);
  assert.equal(classifyCheck(cmd, "12", BAD, NONE, "report")?.passed, false);
  assert.equal(classifyCheck(cmd, "12", OK, NONE, null), null, "not a check outside a report");
});

test("facts from the beta-then-prod pushes: branches in order and the new sha from the tails", () => {
  const calls = [
    call("git fetch origin"),
    call("git push origin beta", { tail: "To github.com:acme/store.git\n   1f2e3d4..9c8b7a6  beta -> beta" }),
    call("git merge-base --is-ancestor origin/prod 9c8b7a6 && echo ok"),
    call("git push origin beta:prod 2>&1 | tail -3", { tail: "To github.com:acme/store.git\n   1f2e3d4..9c8b7a6  beta -> prod" }),
  ];
  const facts = factsFromCalls(calls, {});
  assert.deepEqual(facts.pushedBranches, ["beta", "prod"]);
  assert.ok(facts.shas.includes("9c8b7a6"));
  assert.equal(classifyCheck("gh api repos/acme/store/commits/9c8b7a6/statuses --jq '.[0].state'", "success", OK, facts, "ship")?.passed, true);
  assert.equal(classifyCheck("git ls-remote origin prod", "9c8b7a6f00ba5e0a1c2d3e4f5a6b7c8d9e0f1a2b\trefs/heads/prod", OK, facts, "ship")?.passed, true);
});

test("facts: refspec shas, rev-parse tails, commits/<sha>, versions, PR, and only from calls that worked", () => {
  const calls = [
    call("git push git@github.com:acme/store.git 9c8b7a6:refs/heads/beta 2>&1 | tail -5", { failed: true, isError: true, tail: "fatal: Authentication failed" }),
    call("git push git@github.com:acme/store.git 9c8b7a6:refs/heads/beta"),
    call("git rev-parse HEAD", { kind: "look", tail: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432" }),
    call("gh api repos/acme/store/commits/abc1234/statuses", { kind: "look", tail: "pending" }),
    call("npm version 1.4.3 --no-git-tag-version"),
    call("npm pack"),
    call("npm publish acme-cli-1.4.3.tgz --access public", { tail: "+ @acme/cli@1.4.3" }),
    call("npm publish acme-core-1.4.4.tgz --access public", { failed: true, tail: "npm error code E403" }),
    call("gh pr view 77"),
    call("git push origin v1.4.3", { tail: " * [new tag]         v1.4.3 -> v1.4.3" }),
    call("git push -u origin feat/cart", { tail: " * [new branch]      feat/cart -> feat/cart" }),
  ];
  const facts = factsFromCalls(calls, { version: "1.4.3" });
  assert.deepEqual(facts.pushedBranches, ["beta", "feat/cart"]);
  for (const sha of ["9c8b7a6", "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432", "abc1234"]) assert.ok(facts.shas.includes(sha), sha);
  assert.deepEqual(facts.versions, ["1.4.3"]);
  assert.equal(facts.pr, "77");
  assert.equal(facts.published, true);
  assert.equal(factsFromCalls([call("npm publish x-2.0.0.tgz", { failed: true })], {}).published, false);
  // A command that held an unnameable secret is null and gives nothing.
  assert.deepEqual(factsFromCalls([call("x", { cmd: null })], {}), { versions: [], shas: [], pushedBranches: [], published: false });
});

test("how a turn ended: the 4.3 fixtures", () => {
  const done = ["Published 0.22.1; npm shows it.", "All 42 tests pass, 0 failed.", "Prod is at 9c8b7a6 and the deploy is success.",
    "Here is what ran:\n\n```\nnpm error code E401\nfailed\n```\n\nDone.", "No errors, nothing failed. Shipped."];
  for (const t of done) {
    assert.equal(endsInFailure(t), false, t);
    assert.equal(endsInQuestion(t), false, t);
  }
  assert.equal(endsInQuestion("Tests pass. Want me to push it too?"), true);
  assert.equal(endsInFailure("Tests pass. Want me to push it too?"), false);
  assert.equal(endsInFailure("The publish failed with E401. Can you tap your key?"), true);
  assert.equal(endsInFailure("I couldn't confirm the deploy."), true);
  assert.equal(endsInQuestion("Should I ff prod now"), true);
  assert.equal(endsInQuestion("Run `npm login` and let me know when you're done."), true);
  assert.equal(endsInQuestion("Is that what you wanted?)**"), true);
  assert.equal(endsInFailure("Prod is still pending."), true);
  assert.equal(endsInFailure("It is not deployed yet."), true);
  // Only the last paragraph counts.
  assert.equal(endsInFailure("The first push failed.\n\nThe second push worked and prod is at 9c8b7a6."), false);
  assert.equal(endsInQuestion(""), false);
});

test("callKind: 4.1's kinds, a read-only check counting as look for its own segment only", () => {
  const cases: Array<[string, string]> = [
    ["cd backend", "plumbing"],
    ["git add -A && git commit -m x", "work"],
    ["cat > x.sh <<'EOF'\necho a\nEOF", "work"],
    ["git status", "look"],
    ["gh api repos/acme/store/commits/9c8b7a6/statuses --jq '.[0].state'", "look"],
    ["sleep 30 && gh api repos/acme/store/commits/9c8b7a6/statuses | jq -r .", "look"],
    ["npm view @acme/cli version", "look"],
    ["gh pr checks 12", "look"],
    ["git ls-remote origin prod", "look"],
    ["git push origin beta && gh pr checks", "step"],
    ["npm test", "step"],
    ["(cd backend && go test ./...)", "step"],
    ["git push origin beta:prod", "step"],
  ];
  for (const [cmd, want] of cases) assert.equal(callKind(cmd, "ship"), want, cmd);
  assert.equal(callKind('psql "$DATABASE_URL" -c "select 1"', "report"), "step", "running the query is the job");
});
