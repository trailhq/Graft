/**
 * The per-skill ledger (`~/.trail/ledger/<skill-id>.jsonl`, design 2.6):
 * counts and labels only, one line per event; and credit from the commands
 * that ran (4.8), pure, with D57's calls from the run sheet once a closed
 * run's calls are gone from the session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { appendLedger, creditCalls, creditRun, ledgerPath, newUseId, readLedger } from "../src/skills/ledger.js";
import type { LedgerLine } from "../src/skills/types.js";
import type { CheckHit, RunCall } from "../src/trace/types.js";
import { writeRunSheet } from "../src/trace/run-sheets.js";
import { at, injection, runCall, runState } from "./trace-run-fixtures.js";

const POSIX = process.platform !== "win32";

function sandbox(): { env: NodeJS.ProcessEnv; trail: string } {
  const home = tmpRepo("ledger");
  const trail = join(home, "trail-home");
  return { env: { HOME: home, TRAIL_HOME: trail }, trail };
}

const EXAMPLE = [
  '{"at":"2026-10-27T10:45:20Z","event":"saved","skill":"s-4c91e0","v":"1","from":"repeated","scope":"personal","receipt":{"consent":"offer-yes","stepsVerified":5,"stepsTotal":5}}',
  '{"at":"2026-10-29T09:41:02Z","event":"use","useId":"u-1a2b3c","skill":"s-4c91e0","v":"1","host":"claude","cue":"job","repo":"github.com/acme/storefront","stepsRan":[1,2,3,4,5],"failedStep":null,"readyFailed":[],"check":"passed","calls":6,"failed":0}',
  '{"at":"2026-10-29T09:41:02Z","event":"status","skill":"s-4c91e0","from":"candidate","to":"active","reason":"checked-use"}',
  '{"at":"2026-10-29T09:44:30Z","event":"corrected","skill":"s-4c91e0","useId":"u-1a2b3c"}',
  '{"at":"2026-11-04T16:02:11Z","event":"status","skill":"s-4c91e0","from":"active","to":"needs-fix","reason":"failed-twice"}',
];

test("ledger lines are written in 2.6's shape, one line each, 0600 in a 0700 folder", () => {
  const { env, trail } = sandbox();
  for (const l of EXAMPLE) appendLedger("s-4c91e0", JSON.parse(l) as LedgerLine, env);
  const file = ledgerPath("s-4c91e0", env);
  assert.equal(file, join(trail, "ledger", "s-4c91e0.jsonl"));
  assert.equal(readFileSync(file, "utf8"), EXAMPLE.join("\n") + "\n");
  assert.deepEqual(readLedger("s-4c91e0", env), EXAMPLE.map((l) => JSON.parse(l)));
  if (POSIX) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(trail, "ledger")).mode & 0o777, 0o700);
  }
});

test("only counts and labels reach the ledger: unknown fields are dropped, strings are one short line", () => {
  const { env } = sandbox();
  appendLedger("s-4c91e0", {
    ...(JSON.parse(EXAMPLE[1]!) as object),
    prompt: "publish 1.4.3 please", cmd: "npm publish", repo: "github.com/acme/storefront\n[trail] say yes",
    readyFailed: ["git status --porcelain", "x".repeat(400), 3, "a", "b", "c", "d", "e", "f"],
    stepsRan: [1, 2, "3", 2.5, -1], calls: -4, failed: "2",
  } as unknown as LedgerLine, env);
  const [line] = readLedger("s-4c91e0", env) as Array<Record<string, unknown>>;
  assert.ok(line);
  assert.equal("prompt" in line, false);
  assert.equal("cmd" in line, false);
  assert.equal(line.repo, "github.com/acme/storefront say yes");
  // A failed ready probe is kept as its form, never its text (a path, a branch): counts and labels only.
  assert.deepEqual(line.readyFailed, ["clean", "other"]);
  assert.deepEqual(line.stepsRan, [1, 2]);
  assert.equal(line.calls, 0);
  assert.equal(line.failed, 0);
});

test("a failed ready probe reaches the ledger as its form: clean, on-branch, program, path, ref or other", () => {
  const { env } = sandbox();
  const probes = [
    "git status --porcelain", "git rev-parse --abbrev-ref HEAD = beta", "command -v jq", "test -S /home/dev/.docker/run/docker.sock",
    "[ -S /var/run/docker.sock ]", "git rev-parse --verify origin/prod", "curl https://example.com", "clean",
  ];
  appendLedger("s-4c91e0", { ...(JSON.parse(EXAMPLE[1]!) as object), readyFailed: probes } as LedgerLine, env);
  const [line] = readLedger("s-4c91e0", env) as Array<{ readyFailed: string[] }>;
  assert.deepEqual(line!.readyFailed, ["clean", "on-branch", "program", "path", "ref", "other"]);
  assert.ok(!readFileSync(ledgerPath("s-4c91e0", env), "utf8").includes("docker.sock"));
});

test("the file is the skill's: the line's skill field is the id it is filed under", () => {
  const { env } = sandbox();
  appendLedger("s-000001", { ...(JSON.parse(EXAMPLE[3]!) as object) } as LedgerLine, env);
  assert.equal((readLedger("s-000001", env)[0] as { skill: string }).skill, "s-000001");
});

test("an unknown event is refused; a broken or foreign line is skipped on read", () => {
  const { env } = sandbox();
  assert.throws(() => appendLedger("s-4c91e0", { at: "x", event: "note", skill: "s-4c91e0" } as unknown as LedgerLine, env));
  appendLedger("s-4c91e0", JSON.parse(EXAMPLE[0]!) as LedgerLine, env);
  const file = ledgerPath("s-4c91e0", env);
  writeFileSync(file, readFileSync(file, "utf8") + "{nope\n" + '{"event":"use"}\n' + "[1,2]\n" + EXAMPLE[3] + "\n");
  assert.deepEqual(readLedger("s-4c91e0", env).map((l) => l.event), ["saved", "corrected"]);
  assert.deepEqual(readLedger("s-ffffff", env), []);
});

test("a skill id that could leave the ledger folder is refused", () => {
  const { env } = sandbox();
  for (const bad of ["../x", "a/b", "", ".hidden", "s-1\n", "x".repeat(80)]) {
    assert.throws(() => ledgerPath(bad, env), /skill id/, JSON.stringify(bad));
    assert.deepEqual(readLedger(bad, env), []);
  }
});

test("the ledger never writes through a planted link", { skip: !POSIX }, () => {
  const { env, trail } = sandbox();
  mkdirSync(join(trail, "ledger"), { recursive: true });
  const target = join(trail, "elsewhere.txt");
  writeFileSync(target, "keep\n");
  symlinkSync(target, join(trail, "ledger", "s-4c91e0.jsonl"));
  assert.throws(() => appendLedger("s-4c91e0", JSON.parse(EXAMPLE[0]!) as LedgerLine, env));
  assert.equal(readFileSync(target, "utf8"), "keep\n");
});

test("use ids are 'u-' and 6 hex", () => {
  const a = newUseId();
  assert.match(a, /^u-[0-9a-f]{6}$/);
  assert.notEqual(a, newUseId());
});

// creditRun (4.8)

const pass = (family: CheckHit["family"] = "npm-view"): CheckHit => ({ family, passed: true, facts: {} });
const fail = (family: CheckHit["family"] = "npm-view"): CheckHit => ({ family, passed: false, facts: {} });
let n = 0;
const call = (cmd: string, sec: number, extra: Partial<RunCall> = {}) => runCall({ id: `toolu_c${++n}`, cmd, at: at(sec), ...extra });
const inj = (extra = {}) => injection({ at: at(100), runId: "r-1001-3f9a", ...extra });
const EMPTY = { stepsRan: [], failedStep: null, check: "none", calls: 0, failed: 0 };

test("creditRun: every step ran and the check passed", () => {
  const calls = [
    call("npm run build", 110), call("npm version 1.4.3 --no-git-tag-version", 120), call("npm pack", 130),
    call("npm publish acme-cli-1.4.3.tgz --access public", 140), call("npm publish acme-core-1.4.3.tgz --access public", 150),
    call("npm view acme-cli version", 160, { kind: "look", check: pass() }),
  ];
  assert.deepEqual(creditRun(inj(), calls), { stepsRan: [1, 2, 3, 4, 5], failedStep: null, check: "passed", calls: 6, failed: 0 });
});

test("creditRun: calls before the block came in are not its credit (5 s of slack)", () => {
  const calls = [call("npm run build", 10, { failed: true }), call("npm run build", 96), call("npm pack", 130)];
  assert.deepEqual(creditRun(inj(), calls), { stepsRan: [1, 3], failedStep: null, check: "none", calls: 2, failed: 0 });
});

test("creditRun: the last outcome of a step wins; the lowest step still failing is the failed step", () => {
  const calls = [
    call("npm run build", 110, { failed: true }), call("npm run build", 115),
    call("npm pack", 120, { failed: true }),
    call("npm publish acme-core-1.4.3.tgz --access public", 130, { failed: true }),
  ];
  assert.deepEqual(creditRun(inj(), calls), { stepsRan: [1], failedStep: 3, check: "none", calls: 4, failed: 3 });
  // A pass after a failure counts as ran; a failure after a pass is a failure.
  const later = [call("npm pack", 110), call("npm pack", 120, { failed: true })];
  assert.deepEqual(creditRun(inj(), later), { stepsRan: [], failedStep: 3, check: "none", calls: 2, failed: 1 });
});

test("creditRun: a call matches the first step it fits, env prefixes and output filters aside, params filled", () => {
  const i = inj({ steps: ["git fetch origin", "git push origin {sha}:refs/heads/beta", "git fetch origin"], params: { sha: "4e1c9a2" }, check: null });
  const calls = [
    call("CI=1 git fetch origin 2>&1 | tail -3", 110),
    call("git push origin 4e1c9a2:refs/heads/beta", 120),
    call("git push origin 9999999:refs/heads/beta", 130, { failed: true }),
  ];
  assert.deepEqual(creditRun(i, calls), { stepsRan: [1, 2], failedStep: null, check: "none", calls: 3, failed: 1 });
});

test("creditRun: the check fails when it ran and never passed, and is none when it never ran", () => {
  const ran = [call("npm run build", 110), call("npm view acme-cli version", 120, { kind: "look", check: fail() })];
  assert.equal(creditRun(inj(), ran).check, "failed");
  const unread = [call("npm run build", 110), call("npm view acme-cli version", 120, { kind: "look" })];
  assert.equal(creditRun(inj(), unread).check, "failed");
  const twice = [call("npm run build", 110), call("npm view acme-cli version", 120, { check: fail() }), call("npm view acme-cli version", 200, { check: pass() })];
  assert.equal(creditRun(inj(), twice).check, "passed");
  assert.equal(creditRun(inj(), [call("npm run build", 110)]).check, "none");
  assert.equal(creditRun(inj({ check: null }), twice).check, "none");
});

test("creditRun: a check that is also the last step (tests) counts as both", () => {
  const i = inj({ steps: ["go vet ./...", "go test ./..."], params: {}, check: "go test ./...", gated: [] });
  const calls = [call("go vet ./...", 110), call("go test ./...", 120, { check: pass("tests") })];
  assert.deepEqual(creditRun(i, calls), { stepsRan: [1, 2], failedStep: null, check: "passed", calls: 2, failed: 0 });
});

test("creditRun: a call kept piece by piece (over 2,000 characters) still matches its steps", () => {
  const long = call("", 110, {
    cmd: null, truncated: true,
    parts: [{ cmd: "npm run build", sep: "&&", kind: "step" }, { cmd: null, sep: "&&", kind: "work", long: true }, { cmd: "npm pack", sep: "", kind: "step" }],
  });
  assert.deepEqual(creditRun(inj(), [long]).stepsRan, [1]);
  const refused = call("", 110, { cmd: null, secret: "refused" });
  assert.deepEqual(creditRun(inj(), [refused]), { ...EMPTY, calls: 1 });
});

test("creditRun: a deploy status read over MCP (D59b) is no command: never a step, never counted", () => {
  // `tool` marks it (g3 follow-up); `cmd` is null and its check comes from the result.
  const mcp = { ...call("", 115, { cmd: null, kind: "look", key: null, cwd: null, check: pass("deploy") }), tool: "mcp__claude_ai_Vercel__get_deployment" } as RunCall;
  const failedMcp = { ...call("", 116, { cmd: null, kind: "look", failed: true }), tool: "mcp__claude_ai_Vercel__list_deployments" } as RunCall;
  const i = inj({ check: "vercel inspect acme-shop.vercel.app" });
  assert.deepEqual(creditRun(i, [call("npm run build", 110), mcp, failedMcp]), { stepsRan: [1], failedStep: null, check: "none", calls: 1, failed: 0 });
  // Even a tool call whose name would read like a step or the check is skipped.
  const named = { ...call("npm run build", 117, { failed: true }), tool: "mcp__x__npm_run_build" } as RunCall;
  assert.deepEqual(creditRun(i, [call("npm run build", 110), named]).stepsRan, [1]);
});

// D65: the check is the run's only when it ran after the skill's steps began; a check inside a wait loop counts.

test("creditRun: a check that passed before any step ran is not the run's check", () => {
  // The agent looked first (the old version was still up), then ran the steps and never checked again.
  const early = [call("npm view acme-cli version", 101, { kind: "look", check: pass() }), call("npm run build", 110), call("npm pack", 120)];
  assert.deepEqual(creditRun(inj(), early), { stepsRan: [1, 3], failedStep: null, check: "none", calls: 3, failed: 0 });
  // Checked again after the steps: that one counts.
  assert.equal(creditRun(inj(), [...early, call("npm view acme-cli version", 200, { kind: "look", check: pass() })]).check, "passed");
  // A step that failed is not a step that ran: a pass right after it is still not this run's check.
  const afterFail = [call("npm run build", 110, { failed: true }), call("npm view acme-cli version", 120, { kind: "look", check: pass() })];
  assert.equal(creditRun(inj(), afterFail).check, "none");
  // A check that is itself a step (tests) is the run's check even as its first call, passed or not.
  const t = inj({ steps: ["go vet ./...", "go test ./..."], params: {}, check: "go test ./...", gated: [] });
  assert.equal(creditRun(t, [call("go test ./...", 110, { check: pass("tests") })]).check, "passed");
  assert.equal(creditRun(t, [call("go test ./...", 110, { failed: true, check: fail("tests") })]).check, "failed");
});

const SHA = "4e1c9a2";
const STATUS = "gh api repos/acme/storefront/commits/{sha}/statuses --jq '.[0].state'";
const WAIT = `s=$SECONDS; until [ "$(${STATUS.replace("{sha}", SHA)})" = "success" ]; do [ $((SECONDS-s)) -ge 300 ] && echo "not ready after 5 min" && break; sleep 10; done`;
const ship = (extra = {}) => inj({
  params: { sha: SHA }, gated: [], check: STATUS.replace("{sha}", SHA),
  steps: ["git fetch origin", `git push origin ${SHA}:refs/heads/beta`, WAIT, `git merge-base --is-ancestor origin/prod ${SHA}`], ...extra,
});

test("creditRun: a check inside a wait loop counts as the check (the fold reads the poll, D59c)", () => {
  const loop = (sec: number, check?: CheckHit) => call(WAIT, sec, { kind: "look", ...(check ? { check } : {}) });
  const calls = [call("git fetch origin", 110), call(`git push origin ${SHA}:refs/heads/beta`, 120), loop(130, pass("deploy"))];
  assert.deepEqual(creditRun(ship(), calls), { stepsRan: [1, 2, 3], failedStep: null, check: "passed", calls: 3, failed: 0 });
  // The loop gave up (still pending): the check failed, the wait step still ran.
  assert.equal(creditRun(ship(), [...calls.slice(0, 2), loop(130, fail("deploy"))]).check, "failed");
  // The agent's own loop over the same read counts too: a while-not loop, and a command substitution inside a for loop.
  const own = `for i in 1 2 3 4 5; do st=$(${STATUS.replace("{sha}", SHA)}); [ "$st" = success ] && break; sleep 20; done`;
  assert.equal(creditRun(ship(), [...calls.slice(0, 2), call(own, 140, { kind: "look", check: pass("deploy") })]).check, "passed");
  const neg = `while ! ${STATUS.replace("{sha}", SHA)} | grep -q success; do sleep 15; done`;
  assert.equal(creditRun(ship(), [...calls.slice(0, 2), call(neg, 140, { kind: "look", check: pass("deploy") })]).check, "passed");
  // A loop the fold did not read as a check says nothing; a loop over another commit is not this check.
  assert.equal(creditRun(ship(), [...calls.slice(0, 2), loop(130)]).check, "none");
  const other = WAIT.replace(SHA, "9999999");
  assert.equal(creditRun(ship(), [...calls.slice(0, 2), call(other, 140, { kind: "look", check: pass("deploy") })]).check, "none");
  // Words that only mention the check in an echo are not a loop running it.
  assert.equal(creditRun(ship(), [...calls.slice(0, 2), call(`echo "${STATUS.replace("{sha}", SHA)}"`, 140, { kind: "look", check: pass("deploy") })]).check, "none");
});

// D66: a skill whose check is a Vercel deploy read over MCP (metadata.check-tool).

const vercel = (sec: number, state: string, extra: Partial<RunCall> = {}, name = "mcp__claude_ai_Vercel__get_deployment") => ({
  ...call("", sec, { cmd: null, kind: "look", key: null, cwd: null, check: { family: "deploy", passed: state === "READY", facts: { state, sha: `${SHA}f00d` } }, ...extra }),
  tool: name,
}) as RunCall;
const deployInj = (extra = {}) => inj({
  steps: ["npm run build", `git push origin ${SHA}:refs/heads/beta`], params: { sha: SHA }, gated: [],
  check: `read the Vercel deployment for ${SHA} with get_deployment`, checkTool: "get_deployment", ...extra,
});

test("creditRun: a check-tool skill takes its check from the deploy tool's READY result, matched by the tool name", () => {
  const steps = [call("npm run build", 110), call(`git push origin ${SHA}:refs/heads/beta`, 120)];
  // BUILDING then READY (the agent waited): passed; the reads are not Bash calls.
  assert.deepEqual(creditRun(deployInj(), [...steps, vercel(130, "BUILDING"), vercel(160, "READY")]), { stepsRan: [1, 2], failedStep: null, check: "passed", calls: 2, failed: 0 });
  // Only BUILDING or ERROR seen: failed.
  assert.equal(creditRun(deployInj(), [...steps, vercel(130, "BUILDING")]).check, "failed");
  assert.equal(creditRun(deployInj(), [...steps, vercel(130, "ERROR", { failed: true })]).check, "failed");
  // The full MCP name in the skill works too.
  assert.equal(creditRun(deployInj({ checkTool: "mcp__claude_ai_Vercel__get_deployment" }), [...steps, vercel(160, "READY")]).check, "passed");
  // Another tool, a read before any step, a READY for another commit, or no check-tool on the block: not the check.
  assert.equal(creditRun(deployInj(), [...steps, vercel(160, "READY", {}, "mcp__claude_ai_Vercel__list_deployments")]).check, "none");
  assert.equal(creditRun(deployInj(), [vercel(101, "READY"), ...steps]).check, "none");
  const elsewhere = vercel(160, "READY", { check: { family: "deploy", passed: true, facts: { state: "READY", sha: "9999999abc" } } });
  assert.equal(creditRun(deployInj(), [...steps, elsewhere]).check, "none");
  assert.equal(creditRun(deployInj({ checkTool: undefined }), [...steps, vercel(160, "READY")]).check, "none");
  // Before the block came in: not its credit at all.
  assert.equal(creditRun(deployInj(), [...steps, vercel(80, "READY")]).check, "none");
});

test("creditRun: a check-cue injection earns nothing", () => {
  const calls = [call("npm run build", 110), call("npm view acme-cli version", 120, { check: pass() })];
  assert.deepEqual(creditRun(inj({ cue: "check", steps: [] }), calls), EMPTY);
});

test("creditRun is pure: same input, same answer, input untouched", () => {
  const calls = [call("npm run build", 110), call("npm pack", 120, { failed: true })];
  const copy = structuredClone(calls);
  const i = inj();
  assert.deepEqual(creditRun(i, calls), creditRun(i, calls));
  assert.deepEqual(calls, copy);
});

// D57: credit for a run the next typed ask closed.

test("creditCalls: the open run's calls, a just-closed run's calls, else the run sheet", () => {
  const { env } = sandbox();
  const calls = [call("npm run build", 110), call("npm pack", 120)];
  const open = runState({ id: "r-1001-3f9a", closed: false, calls });
  assert.deepEqual(creditCalls(inj(), [open], env), calls);
  const justClosed = runState({ id: "r-1001-3f9a", closed: true, calls });
  assert.deepEqual(creditCalls(inj(), [justClosed], env), calls);

  // The sheet was written and the session emptied the calls (2.8): read them back from the sheet.
  const sheetRun = runState({ id: "r-1001-3f9a", closed: true, calls, stepCalls: 2 });
  writeRunSheet(sheetRun, { checked: false, checkIndex: null, end: "done" }, { host: "claude", tier: "A", sessionHash: "e76b4ca7f1a0", helpers: [] }, env);
  const emptied = runState({ id: "r-1001-3f9a", closed: true, calls: [] });
  assert.deepEqual(creditCalls(inj(), [emptied], env).map((c) => c.cmd), ["npm run build", "npm pack"]);
  // Dropped from the 20 runs the session keeps: the sheet still answers.
  assert.deepEqual(creditCalls(inj(), [], env).map((c) => c.cmd), ["npm run build", "npm pack"]);
  // An open run with nothing yet, or a run with no sheet: nothing.
  assert.deepEqual(creditCalls(inj({ runId: "r-1001-0000" }), [runState({ id: "r-1001-0000", closed: false, calls: [] })], env), []);
  assert.deepEqual(creditCalls(inj({ runId: "r-1001-0001" }), [], env), []);
});

test("creditCalls: with no run, every call of the injection's epoch the session still holds", () => {
  const { env } = sandbox();
  const a = runState({ id: "r-1001-000a", epoch: 1, closed: true, calls: [call("npm run build", 110)] });
  const b = runState({ id: "r-1001-000b", epoch: 1, closed: false, calls: [call("npm pack", 120)] });
  const old = runState({ id: "r-1001-000c", epoch: 0, closed: true, calls: [call("npm pack", 50)] });
  assert.deepEqual(creditCalls(inj({ runId: null, epoch: 1 }), [old, a, b], env).map((c) => c.cmd), ["npm run build", "npm pack"]);
});
