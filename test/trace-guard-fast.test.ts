/**
 * The sure-fail guardrail on the PreToolUse fast path (design 4.11, 2.5,
 * 2.9): with the person's no-timeout guardrail kept, a `timeout N ...`
 * command is denied only when no `timeout` exists on this machine, so it
 * would fail anyway. Everything else is allowed, and a bad or missing file
 * allows. Each test has its own TRAIL_HOME and HOME; PATH is a made-up one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { tmpRepo } from "./helpers.js";
import { FIXED_DIRS, SURE_FAIL_REASON, markDenied, sureFail, timeoutOnPath } from "../src/trace/guard-fast.js";
import { writeEveryRepo } from "../src/notes/every-repo.js";
import { guardrailLearning } from "../src/notes/guardrails.js";
import { sessionPath } from "../src/trace/gate-file.js";
import { timeBar } from "./machine-speed.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
/** A machine with a real `timeout` in a system folder of 4.11 can't show a deny: those tests say so and skip. */
const SYSTEM_TIMEOUT = FIXED_DIRS.filter((d) => !d.startsWith("$HOME")).some((d) => {
  try { return statSync(join(d, "timeout")).isFile(); } catch { return false; }
}) && "this machine has a timeout in a system folder";

function box(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpRepo("guard");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  return { dir, env: { HOME: join(dir, "home"), TRAIL_HOME: join(dir, "trail"), PATH: join(dir, "bin") } };
}
function keep(b: { env: NodeJS.ProcessEnv }): string {
  return writeEveryRepo(guardrailLearning("timeout-missing", "every repo", "on 6 days", new Date(2026, 9, 17)), "no-timeout.md", b.env);
}
/** An executable `timeout` in `dir`. */
function timeoutIn(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "timeout"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "timeout"), 0o755);
}

test("the deny reason: J16's words, the way to run it instead, and the way out, as plain information (D88)", () => {
  assert.match(SURE_FAIL_REASON, /^\[trail\] Trail, the tool this person installed, /);
  assert.match(SURE_FAIL_REASON, /this Mac has no timeout/i);
  assert.match(SURE_FAIL_REASON, /always-follow learning/);
  assert.match(SURE_FAIL_REASON, /background|Bash tool's own timeout/);
  assert.match(SURE_FAIL_REASON, /trail forget no-timeout/);
  assert.doesNotMatch(SURE_FAIL_REASON, /\b(?:say|tell|ask|you must|must|word for word|you)\b/i);
  assert.doesNotMatch(SURE_FAIL_REASON, /\u2014|\n|\b(?:notes?|rules?|memory|workflows?)\b/i);
});

test("sureFail: the 4.11 table", { skip: SYSTEM_TIMEOUT }, () => {
  const b = box();
  assert.equal(sureFail("timeout 60 npm test", b.env), null, "no file allows");
  keep(b);
  const deny = { deny: SURE_FAIL_REASON, check: "no-timeout" };
  const table: Array<[string, boolean]> = [
    ["timeout 60 npm test", true],
    ["timeout -s KILL 5m x", true],
    ["timeout --signal=TERM 1.5 make check", true],
    ["env FOO=1 timeout 5 x", true],
    ["FOO=1 timeout 5 x", true],
    ["cd /tmp/x && timeout 30 go test ./...", true],
    ["npm run build; timeout 9 npm test 2>&1 | tail -5", true],
    ["gtimeout 60 x", false],
    ['timeout() { gtimeout "$@"; }; timeout 5 x', false],
    ["function timeout { gtimeout \"$@\"; }; timeout 5 x", false],
    ["alias timeout=gtimeout; timeout 5 x", false],
    ["echo timeout 5", false],
    ["grep -rn 'timeout 5' scripts", false],
    ["timeout", false],
    ["timeout --help", false],
    ["npm test", false],
    ["git commit -m 'timeout 60 npm test'", false],
  ];
  for (const [cmd, denied] of table) assert.deepEqual(sureFail(cmd, b.env), denied ? deny : null, cmd);
});

test("sureFail: a retired, hand-emptied, half-filled or bad file allows", { skip: SYSTEM_TIMEOUT }, () => {
  const b = box();
  const path = keep(b);
  const text = readFileSync(path, "utf8");
  const cases = [
    text.replace("status: active", "status: retired"),
    text.replace("status: active", "status: held"),
    "",
    "This Mac has no timeout.\n",
    text.replace(/^enforce: .*\n/m, ""),
    text.replace(/^check: .*\n/m, ""),
    text.replace("check: no-timeout", "check: no-gtimeout"),
    text.replace("enforce: sure-fail", "enforce: deny"),
    "---\ncheck: no-timeout\nenforce: sure-fail\n", // no closing fence
    "\u0000\u0001garbage",
    `${text}${"x".repeat(8 * 1024)}`, // too big to be the template
  ];
  for (const c of cases) {
    writeFileSync(path, c);
    assert.equal(sureFail("timeout 60 npm test", b.env), null, JSON.stringify(c.slice(0, 80)));
  }
  writeFileSync(path, text.replace(/^check: .*$/m, 'check: "no-timeout"').replace(/^enforce: .*$/m, "enforce: 'sure-fail'"));
  assert.notEqual(sureFail("timeout 60 npm test", b.env), null, "quoted values still read");
});

test("sureFail: a timeout on the hook's PATH, or in any fixed folder, allows", { skip: SYSTEM_TIMEOUT }, () => {
  const b = box();
  keep(b);
  timeoutIn(join(b.dir, "bin"));
  assert.equal(sureFail("timeout 60 npm test", b.env), null);
  assert.equal(timeoutOnPath(b.env), true);

  const home = join(b.dir, "home");
  for (const fixed of FIXED_DIRS) {
    const c = box();
    keep(c);
    const where = fixed.replace(/^\$HOME/, join(c.dir, "home"));
    if (!where.startsWith(c.dir)) continue; // system folders: checked below without writing there
    timeoutIn(where);
    assert.equal(sureFail("timeout 60 npm test", c.env), null, fixed);
  }
  assert.ok(home);
  // Every fixed folder of 4.11 is on the list.
  assert.deepEqual([...FIXED_DIRS], [
    "/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/opt/coreutils/libexec/gnubin", "/usr/local/opt/coreutils/libexec/gnubin",
    "/opt/local/bin", "/opt/local/libexec/gnubin", "$HOME/.nix-profile/bin", "/run/current-system/sw/bin",
    "/nix/var/nix/profiles/default/bin", "$HOME/bin", "$HOME/.local/bin",
    // Review: nix-darwin's per-user profile.
    "/etc/profiles/per-user/$USER/bin",
  ]);
});

test("timeoutOnPath: a system fixed folder counts too (checked through a stand-in root)", () => {
  const b = box();
  // A file that is not executable, or a folder named timeout, is not a timeout.
  writeFileSync(join(b.dir, "bin", "timeout"), "x");
  chmodSync(join(b.dir, "bin", "timeout"), 0o644);
  const empty = { ...b.env, HOME: join(b.dir, "home") };
  const onSystem = timeoutOnPath({ ...empty, PATH: "" });
  // The machine this runs on may have one in a system folder; the answer must equal a direct look.
  const direct = FIXED_DIRS.filter((d) => !d.startsWith("$HOME")).map((d) => d.replace("$USER", userInfo().username)).some((d) => {
    try { return (statSync(join(d, "timeout")).mode & 0o111) !== 0 && statSync(join(d, "timeout")).isFile(); } catch { return false; }
  });
  assert.equal(onSystem, direct);
  // Windows has no exec bit: there any timeout file on PATH counts (Git Bash runs a script with no extension).
  if (process.platform !== "win32") assert.equal(timeoutOnPath(empty), direct, "a non-executable file on PATH is not a timeout");
});

test("markDenied: one JSON line per deny, the sha of the rest of the command, 0600, capped at 4 KB", () => {
  const b = box();
  const sid = "5f0c2a1e-1b2c-4d5e-8f90-123456789abc";
  markDenied(sid, "timeout 60 npm test", b.env, new Date("2026-10-17T09:00:00Z"));
  const path = sessionPath(sid, ".denied.jsonl", b.env);
  const first = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(first[0]), ["at", "restSha"]);
  assert.equal(first[0].at, "2026-10-17T09:00:00.000Z");
  assert.match(first[0].restSha, /^sha256:[0-9a-f]{64}$/);
  markDenied(sid, "timeout 5 npm  test", b.env);
  const two = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(two[1].restSha, first[0].restSha, "the rest of the command, normalized");
  assert.ok(!readFileSync(path, "utf8").includes("npm test"), "never the command");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  for (let i = 0; i < 200; i++) markDenied(sid, `timeout 5 make t${i}`, b.env);
  assert.ok(statSync(path).size <= 4096, `capped: ${statSync(path).size}`);
  assert.deepEqual(readdirSync(b.dir).sort(), ["bin", "home", "trail"], "nothing outside TRAIL_HOME");
});

test("guard-fast.ts is fast-path safe: no static node:fs, only node:path and node:os, and only fast-path files", () => {
  const seen = new Set<string>();
  const pkgs = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      else pkgs.add(spec);
    }
  };
  walk(join(SRC, "trace", "guard-fast.ts"));
  const names = [...seen].map((f) => relative(SRC, f).split("\\").join("/")).sort();
  assert.deepEqual([...pkgs].sort(), ["node:os", "node:path"].filter((p) => pkgs.has(p)));
  assert.ok(!pkgs.has("node:fs"));
  for (const n of names) assert.ok(["trace/guard-fast.ts", "trace/gate-file.ts", "trace/shell.ts", "trace/shell-words.ts", "trace/shell-scan.ts"].includes(n), n);
});

test("a guard call takes under 2 ms (best of 200, file kept, no timeout anywhere on PATH)", () => {
  const b = box();
  keep(b);
  for (let i = 0; i < 20; i++) sureFail("timeout 60 npm test", b.env);
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = process.hrtime.bigint();
    sureFail(i % 2 ? "timeout 60 npm test" : "npm run build && npm test", b.env);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, z) => a - z);
  // 2 ms where the bar was set, scaled, never under 8: a guard that read a big file or spawned a child takes tens.
  const bar = timeBar(2, 8);
  assert.ok(times[Math.floor(times.length / 2)]! < bar, `median ${times[100]} ms, over ${bar.toFixed(1)} ms`);
});
