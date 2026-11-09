/**
 * D101 item 4: compile refuses a step that answers a login or confirmation
 * prompt for the person, by piping or feeding keystrokes into `script`,
 * `expect`, `yes |` or `printf ... |` into a login or a publish. A real
 * release did `(sleep 15; printf '\n'; sleep 300) | script -q /dev/null npm
 * login`; kept as a step, an agent read it as an attempt to skip the
 * person's own confirmation. The matcher stays linear on a 2 MB command.
 * Made-up repo, paths and package.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { answersPrompt } from "../src/skills/answers-prompt.js";
import { compileRun, refusalWords, type CompileOpts } from "../src/skills/compile.js";
import { callKind } from "../src/trace/checks.js";
import { isMultiLine } from "../src/trace/shell.js";
import type { RunCall, RunSheet } from "../src/trace/types.js";
import { timeBar } from "./machine-speed.js";

const KEY = "github.com/acme/widget";
let seq = 0;
function call(raw: string, o: Partial<RunCall> = {}): RunCall {
  seq++;
  return {
    id: `toolu_${String(seq).padStart(3, "0")}`, at: new Date(Date.UTC(2026, 9, 27, 10, 0, 0) + seq * 20_000).toISOString(), cmd: raw,
    key: KEY, cwd: "", bg: false, failed: false, isError: false, ...(isMultiLine(raw) ? { multiLine: true } : {}),
    kind: callKind(raw, "release"), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...o,
  };
}
function sheet(calls: RunCall[]): RunSheet {
  return {
    v: 1, id: "r-1027-aa01", session: "0123456789ab", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 0,
    startedAt: "2026-10-27T10:00:00Z", endedAt: "2026-10-27T10:20:00Z", job: "release", jobWords: [], sharedWords: [], promptParams: {},
    calls, checkIndex: null, checked: false, end: "done",
    counts: { commands: calls.length, failed: 0, toolCalls: calls.length, edits: 0 }, helpers: [], skillId: null,
  };
}
const OPTS: CompileOpts = { repoRoot: "/home/dev/src/widget", home: "/home/dev", platform: "linux", moment: "asked", applies: KEY, taken: () => false };

/** The two shapes from real release data, and the other ways to feed a prompt. */
const FEEDS = [
  "(sleep 15; printf '\\n'; sleep 300) | script -q /dev/null npm login",
  "(sleep 15; printf '\\n'; sleep 300) | script -q /dev/null npm publish",
  "printf 'y\\n' | npm publish --access public",
  "echo yes | npm login",
  "yes | npm publish acme-widget-1.2.3.tgz",
  "yes | npx vercel login",
  "printf '\\n' | script -q /dev/null gh auth login",
  "expect -c 'spawn npm login; expect Username; send dev\\r'",
  "expect ./answers.exp",
  "npm run build && printf 'y\\n' | npm publish",
  "{ sleep 2; echo; } | script -q /dev/null npm login",
  "npm login <<< $'dev\\n'",
  "cd packages/widget && yes | npm publish",
];
/** Look-alikes: no prompt is answered for the person. */
const PLAIN = [
  "npm login", "script -q /dev/null npm login", "npm publish --access public", "printf 'built\\n'", "echo done | tee build.log",
  "yes | head -n 3", "npm run build | tee build.log", "git log --oneline | head -5", "echo $PATH", "npm view acme-widget version",
  "printf '%s\\n' a b | sort", "echo 'expect this to pass' && npm test",
  // Flags made to read stdin are input, not a prompt answered (a literal password there is refused as a secret).
  "echo \"$REGISTRY_TOKEN\" | docker login -u bot --password-stdin registry.example.test", "printf '%s' \"$GH_TOKEN\" | gh auth login --with-token",
];

test("answersPrompt: the feeds are caught, the look-alikes are not", () => {
  for (const cmd of FEEDS) assert.ok(answersPrompt(cmd), cmd);
  for (const cmd of PLAIN) assert.equal(answersPrompt(cmd), false, cmd);
});

test("compile refuses the real release shapes with answers-prompt, in the words D101 gives", () => {
  // D116 item 5 reverses this for a feed into a login alone (FEEDS[0]): that step is dropped and becomes a
  // "Before you start" line (skills-login-feed.test.ts). A feed into a publish still refuses the run.
  const dropped = compileRun(sheet([call("npm run build", { kind: "step" }), call(FEEDS[0]!, { kind: "step" }), call("npm view acme-widget version")]), OPTS);
  assert.ok(dropped.ok && !dropped.skill.steps.some((x) => /login/.test(x.cmd)), dropped.ok ? "" : `${dropped.reason}: ${dropped.detail}`);
  for (const login of [FEEDS[1]!, FEEDS[2]!]) {
    const r = compileRun(sheet([call("npm run build", { kind: "step" }), call(login, { kind: "step" }), call("npm view acme-widget version")]), OPTS);
    assert.equal(r.ok, false, login);
    if (r.ok) continue;
    assert.equal(r.reason, "answers-prompt", r.detail);
    assert.match(refusalWords(r.reason, r.detail), /^a step answers a login or confirmation prompt for the person: `/);
  }
  // A plain login step stays a gated step, as before (D93).
  const plain = compileRun(sheet([call("npm run build", { kind: "step" }), call("npm login", { kind: "step" })]), OPTS);
  assert.ok(plain.ok, plain.ok ? "" : `${plain.reason}: ${plain.detail}`);
});

test("linear on a 2 MB command", () => {
  for (const big of [
    `${"printf 'a' | ".repeat(150_000)}cat`,
    `(${"sleep 1; ".repeat(200_000)}) | script -q /dev/null npm login`,
    `echo ${"(".repeat(100_000)}`,
    `${"x".repeat(2 * 1024 * 1024)} | npm login`,
  ]) {
    // Best of 3, as the other 2 MB tests take it: a shared machine under load slows one run, not all three.
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      answersPrompt(big);
      best = Math.min(best, performance.now() - t);
    }
    assert.ok(best < timeBar(1500, 4500), `took ${Math.round(best)} ms on ${big.length} chars`);
  }
});
