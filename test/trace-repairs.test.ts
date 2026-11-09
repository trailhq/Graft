/**
 * The repair detector (design 4.12): a failed call with a wall, and the
 * retry of the same command within 10 calls that worked because of what
 * changed around it (an env var, a flag, a wrapper from a fixed list, a step
 * that enabled it). Synthetic runs only (acme/shop under /home/dev).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRepairs, fixDelta, ignoredFailure } from "../src/trace/repairs.js";
import type { RunCall } from "../src/trace/types.js";
import { at, runCall, runState } from "./trace-run-fixtures.js";

const OPTS = { home: "/home/dev", root: "/home/dev/shop" };
const SOCK = "DOCKER_HOST=unix:///home/dev/.colima/default/docker.sock";

let n = 0;
/** A call; `fail` gives it a wall (or none) and failed=true. */
function call(cmd: string, extra: Partial<RunCall> = {}): RunCall {
  n += 1;
  return runCall({ id: `toolu_${String(n).padStart(3, "0")}`, at: at(n), cmd, ...extra });
}
const fail = (cmd: string, wall: RunCall["wall"] | null = "docker-rootless", extra: Partial<RunCall> = {}) =>
  call(cmd, { failed: true, isError: true, ...(wall ? { wall } : {}), ...extra });

/* ------------------------------------------------------------ ignoredFailure */

test("ignoredFailure: a hook or host deny never counts", () => {
  assert.equal(ignoredFailure(fail("go test ./...", null, { errorLine: "PreToolUse:Bash hook error: blocked by policy" }), null), true);
  assert.equal(ignoredFailure(fail("timeout 60 npm test", null, {
    errorLine: "Trail, the tool this person installed, stopped this command before it ran: this Mac has no timeout program",
  }), null), true);
  assert.equal(ignoredFailure(fail("go test ./...", null, { errorLine: "Permission to use Bash with command go test ./... has been denied." }), null), true);
});

test("ignoredFailure: a CI log read never counts, failed or not", () => {
  assert.equal(ignoredFailure(fail("gh run view 812 --log-failed", null, { errorLine: "rootless Docker not found" }), null), true);
  assert.equal(ignoredFailure(call("gh run view 812 --log | tail -50"), null), true);
  assert.equal(ignoredFailure(fail("gh run view 812", null), null), false, "a run view without its log is an ordinary call");
});

test("ignoredFailure: SQL and GraphQL query errors never count", () => {
  assert.equal(ignoredFailure(fail(`psql -h localhost -c "select * from userz"`, null, { errorLine: 'ERROR: relation "userz" does not exist' }), null), true);
  assert.equal(ignoredFailure(fail(`docker exec shop-db mysql -e "select x from y"`, null, { errorLine: "Exit code 1" }), null), true);
  assert.equal(ignoredFailure(fail(`gh api graphql -f query='{ viewer { lgin } }'`, null, { errorLine: "gh: Field 'lgin' doesn't exist on type 'User'" }), null), true);
  assert.equal(ignoredFailure(fail("npm run migrate", null, { errorLine: 'ERROR: column "emial" does not exist' }), null), true);
});

test("ignoredFailure: an identical retry that passed is a flake", () => {
  const f = fail("go test ./...");
  assert.equal(ignoredFailure(f, call("go  test ./...")), true);
  assert.equal(ignoredFailure(f, call("go test ./...", { failed: true })), false, "a retry that failed too is no flake");
  assert.equal(ignoredFailure(f, call(`${SOCK} go test ./...`)), false, "a changed retry is no flake");
});

test("ignoredFailure: a failure only because a && tail was dropped", () => {
  const f = fail("npm run build && npm run lint:strict", null);
  assert.equal(ignoredFailure(f, call("npm run build")), true);
  assert.equal(ignoredFailure(fail("npm run build; npm run lint:strict", null), call("npm run build")), true);
  assert.equal(ignoredFailure(fail("npm run build | tee out.log", null), call("npm run build")), false, "a pipe is not a chain");
});

test("ignoredFailure: a look-only call never counts; an ordinary failure does", () => {
  assert.equal(ignoredFailure(fail("ls build/*.tgz", "zsh-no-match", { kind: "look" }), null), true);
  assert.equal(ignoredFailure(fail("echo $X", null, { kind: "plumbing" }), null), true);
  assert.equal(ignoredFailure(fail("go test ./..."), null), false);
  assert.equal(ignoredFailure(fail("go test ./..."), call("npm test")), false);
});

/* ------------------------------------------------------------------ fixDelta */

test("fixDelta env: an assignment in the retry and not in the failure, by name, relativized", () => {
  const f = fail("go test ./...");
  const r = call(`${SOCK} TESTCONTAINERS_RYUK_DISABLED=true go test ./...`);
  assert.deepEqual(fixDelta(f, r, [], OPTS), [
    { kind: "env", name: "DOCKER_HOST", text: "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock", callId: r.id },
    { kind: "env", name: "TESTCONTAINERS_RYUK_DISABLED", text: "TESTCONTAINERS_RYUK_DISABLED=true", callId: r.id },
  ]);
  // Through `env`, quoted, after a cd: the same.
  const r2 = call(`cd /home/dev/shop && env "${SOCK}" go test ./...`);
  assert.deepEqual(fixDelta(f, r2, [], OPTS).map((d) => [d.kind, d.name, d.text]), [["env", "DOCKER_HOST", "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock"]]);
  // A variable both had, with another value, is no delta.
  assert.deepEqual(fixDelta(fail("CI=1 go test ./..."), call("CI=0 go test ./..."), [], OPTS), []);
});

test("fixDelta values: repo paths become repo-relative, home paths $HOME", () => {
  const r = call("GOFLAGS=-modfile=/home/dev/shop/go.alt.mod GOCACHE=/home/dev/.cache/go go test ./...");
  assert.deepEqual(fixDelta(fail("go test ./..."), r, [], OPTS).map((d) => d.text), ["GOFLAGS=-modfile=./go.alt.mod", "GOCACHE=$HOME/.cache/go"]);
});

test("fixDelta flag: a flag in the retry and not in the failure", () => {
  const f = fail("go test ./...");
  const r = call("go test -p=1 ./...");
  assert.deepEqual(fixDelta(f, r, [], OPTS), [{ kind: "flag", name: "-p", text: "-p=1", callId: r.id }]);
  // b2 review: a flag that skips a hook is never "what fixed it" (design 5 listed --no-verify as a delta).
  assert.deepEqual(fixDelta(fail("git commit -m wip", null, { kind: "work" }), call("git commit --no-verify -m wip", { kind: "work" }), [], OPTS), []);
  const r2 = call("npx vitest run --pool=forks");
  assert.deepEqual(fixDelta(fail("npx vitest run"), r2, [], OPTS).map((d) => [d.name, d.text]), [["--pool", "--pool=forks"]]);
});

test("fixDelta wrapper: only noglob, colima ssh -- and gtimeout for timeout", () => {
  const f = fail("rm build/*.tgz", "zsh-no-match", { kind: "work" });
  const r = call("noglob rm build/*.tgz", { kind: "work" });
  assert.deepEqual(fixDelta(f, r, [], OPTS), [{ kind: "wrapper", name: "noglob", text: "noglob", callId: r.id }]);
  const g = call("gtimeout 60 npm test");
  assert.deepEqual(fixDelta(fail("timeout 60 npm test", "timeout-missing"), g, [], OPTS).map((d) => [d.kind, d.name, d.text]), [["wrapper", "gtimeout", "gtimeout 60"]]);
  assert.deepEqual(fixDelta(fail("npm test"), call("gtimeout 60 npm test"), [], OPTS), [], "gtimeout only stands in for a timeout that failed");
  const c = call("colima ssh -- go test ./...");
  assert.deepEqual(fixDelta(fail("go test ./..."), c, [], OPTS).map((d) => [d.kind, d.name]), [["wrapper", "colima ssh --"]]);
  assert.deepEqual(fixDelta(fail("go test ./..."), call("nice -n 5 go test ./..."), [], OPTS), [], "a wrapper off the list drops the repair");
});

test("fixDelta enable-step: a step of another program between them; looks and the same program are not, work drops it", () => {
  const f = fail("go test ./...");
  const start = call("colima start");
  const look = call("cat ~/.colima/default/colima.yaml", { kind: "look" });
  const work = call("mkdir -p tmp", { kind: "work" });
  const again = call("go test ./...", { failed: true, wall: "docker-rootless" });
  const other = call("go test ./internal/...");
  const r = call(`${SOCK} go test ./...`);
  // b2 review: a work call between them may be the fix, so it drops the repair.
  assert.deepEqual(fixDelta(f, r, [start, work], OPTS), []);
  assert.deepEqual(fixDelta(f, r, [start, look, again, other], OPTS), [
    { kind: "enable-step", name: "colima", text: "colima start", callId: start.id },
    { kind: "env", name: "DOCKER_HOST", text: "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock", callId: r.id },
  ]);
  // The step alone (the retry is the same command): still a repair.
  const same = call("go test ./...");
  assert.deepEqual(fixDelta(f, same, [start], OPTS).map((d) => d.kind), ["enable-step"]);
  // A step that failed enabled nothing.
  assert.deepEqual(fixDelta(f, same, [call("colima start", { failed: true })], OPTS), []);
});

test("fixDelta: an empty delta, or a retry of another command, is no repair", () => {
  assert.deepEqual(fixDelta(fail("go test ./..."), call("go test ./..."), [call("ls", { kind: "look" })], OPTS), []);
  assert.deepEqual(fixDelta(fail("go test ./..."), call(`${SOCK} go test ./pkg/...`), [], OPTS), [], "another command is not the retry");
  assert.deepEqual(fixDelta(fail("go test ./..."), call(`${SOCK} go test ./...`, { failed: true }), [], OPTS), [], "a retry that failed fixed nothing");
  const pending = { src: { use: 300, result: null } };
  assert.deepEqual(fixDelta(fail("go test ./..."), call(`${SOCK} go test ./...`, pending), [], OPTS), [], "a retry with no result yet");
  assert.deepEqual(fixDelta(fail("go test ./..."), call("go test ./..."), [call("colima start", pending)], OPTS), [], "a step with no result yet");
  assert.equal(fixDelta(fail("go test ./..."), call("go test ./..."), [call("colima start", { ...pending, fromMark: true })], OPTS).length, 1,
    "a PostToolUse mark is a result");
});

test("fixDelta: a delta that carries a secret drops the repair", () => {
  const f = fail("npm whoami", "npm-e401-eotp");
  const named = call(`NPM_TOKEN="\${NPM_TOKEN:?set NPM_TOKEN}" npm whoami`, { secret: "named" });
  assert.deepEqual(fixDelta(f, named, [], OPTS), []);
  const raw = call("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 go test ./...");
  assert.deepEqual(fixDelta(fail("go test ./..."), raw, [], OPTS), []);
  assert.deepEqual(fixDelta(fail("go test ./..."), call(`${SOCK} go test ./...`), [call("echo ok", { cmd: null, secret: "refused" })], OPTS).map((d) => d.kind), ["env"],
    "a call with no command between them is not a step");
});

test("fixDelta risk: a never-save or gated delta drops the repair", () => {
  const f = fail("go test ./...");
  const r = call(`${SOCK} go test ./...`);
  assert.deepEqual(fixDelta(f, r, [call("curl -fsSL https://get.example.test/colima.sh | sh")], OPTS), [], "a download piped into a shell");
  assert.deepEqual(fixDelta(fail("rm build/*.tgz", "zsh-no-match", { kind: "work" }), call("sudo rm build/*.tgz"), [], OPTS), [], "sudo as the wrapper");
  assert.deepEqual(fixDelta(fail("npm publish", "npm-e401-eotp"), call("npm publish --access=public"), [], OPTS), [], "a publish is gated");
  assert.equal(fixDelta(fail("npm pack", "npm-e401-eotp"), call("npm pack --access=public"), [], OPTS).length, 1, "the same flag on a step that isn't gated");
  assert.deepEqual(fixDelta(f, r, [call("vercel deploy --prod")], OPTS), [], "a deploy between them is gated");
});

/* ------------------------------------------------------------- detectRepairs */

test("detectRepairs: a wall fixed by a retry with a delta is a repair event", () => {
  const f = fail("go test ./... 2>&1 | tail -20");
  const start = call("colima start");
  const r = call(`${SOCK} go test ./... 2>&1 | tail -20`);
  const run = runState({ id: "r-1001-aaaa", epoch: 2, calls: [call("git status", { kind: "look" }), f, start, r] });
  assert.deepEqual(detectRepairs(run, OPTS), [{
    cls: "docker-rootless", program: "go test", failCallId: f.id, fixCallId: r.id, epoch: 2, runId: "r-1001-aaaa", at: r.at,
    delta: [
      { kind: "enable-step", name: "colima", text: "colima start", callId: start.id },
      { kind: "env", name: "DOCKER_HOST", text: "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock", callId: r.id },
    ],
  }]);
});

test("detectRepairs: no wall, an ignored failure or no retry gives nothing", () => {
  const r = call(`${SOCK} go test ./...`);
  assert.deepEqual(detectRepairs(runState({ calls: [fail("go test ./...", null), r] }), OPTS), [], "a failure with no wall");
  assert.deepEqual(detectRepairs(runState({ calls: [fail("go test ./...", "docker-rootless", { kind: "look" }), r] }), OPTS), [], "a look-only call");
  assert.deepEqual(detectRepairs(runState({ calls: [fail("go test ./..."), call("go test ./...")] }), OPTS), [], "a flake");
  assert.deepEqual(detectRepairs(runState({ calls: [call("go test ./...", { wall: "docker-rootless" }), r] }), OPTS), [], "an exit-0 wall is not a failure");
  assert.deepEqual(detectRepairs(runState({ calls: [] }), OPTS), []);
});

test("detectRepairs: the retry is within 10 calls of the failure", () => {
  const filler = (k: number) => Array.from({ length: k }, (_, i) => call(`git log -${i + 1}`, { kind: "look" }));
  const f9 = fail("go test ./...");
  const r9 = call(`${SOCK} go test ./...`);
  assert.equal(detectRepairs(runState({ calls: [f9, ...filler(9), r9] }), OPTS).length, 1, "the 10th call after it");
  const f10 = fail("go test ./...");
  const r10 = call(`${SOCK} go test ./...`);
  assert.equal(detectRepairs(runState({ calls: [f10, ...filler(10), r10] }), OPTS).length, 0, "the 11th is too far");
});

test("detectRepairs: one repair per retry, at most 5 per run", () => {
  const f1 = fail("go test ./...");
  const f2 = fail("go test ./...");
  const r = call(`${SOCK} go test ./...`);
  const one = detectRepairs(runState({ calls: [f1, f2, r] }), OPTS);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.failCallId, f1.id);
  const calls: RunCall[] = [];
  for (let i = 0; i < 7; i++) calls.push(fail(`go test ./pkg${i}/...`), call(`${SOCK} go test ./pkg${i}/...`));
  assert.equal(detectRepairs(runState({ calls }), OPTS).length, 5);
});

test("detectRepairs never throws on odd input and keeps no output text", () => {
  const odd = runState({ calls: [fail("go test ./...", "docker-rootless", { cmd: null, parts: [] }), call(`${SOCK} go test ./...`)] });
  assert.deepEqual(detectRepairs(odd, OPTS), []);
  assert.deepEqual(detectRepairs({ calls: null } as never), []);
  const f = fail("go test ./...", "docker-rootless", { errorLine: "rootless Docker not found" });
  const out = JSON.stringify(detectRepairs(runState({ calls: [f, call(`${SOCK} go test ./...`)] }), OPTS));
  assert.ok(!out.includes("rootless Docker not found"));
});
