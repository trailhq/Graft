/**
 * The regexes hooks run on agent-written commands stay linear (CodeQL js/redos, js/polynomial-redos):
 * a slow regex in a hook is a fail-open bypass, so each pump CodeQL found must finish at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandKind } from "../src/trace/shell.js";
import { pushes } from "../src/skills/risk.js";
import { loginFeed } from "../src/skills/answers-prompt.js";
import { statementsOf } from "../src/skills/compile-split.js";
import { withoutTimeout } from "../src/claude/walls-hook.js";
import { keyFromRemote } from "../src/notes/home.js";

const CTX = { repoRoot: "/home/dev/src/acme", home: "/home/dev", job: null };

/** Runs `fn` and fails when it takes longer than `ms` (the old regexes took seconds at these sizes). */
function fast<T>(label: string, fn: () => T, ms = 250): T {
  const t = performance.now();
  const out = fn();
  const took = performance.now() - t;
  assert.ok(took < ms, `${label} took ${took.toFixed(0)}ms`);
  return out;
}

test("shell INFO: npx flags and redirect tails stay linear", () => {
  fast("redirects", () => commandKind("+ -v >" + "&! >".repeat(40) + "\n"));
  fast("npx flags", () => commandKind("npx -" + "-- -".repeat(40) + "\n"));
  assert.equal(commandKind("npx -y tsc --version 2>&1"), "look");
  assert.equal(commandKind("node --version >/dev/null 2>&1"), "look");
});

test("risk GIT_PUSH: git options read one way", () => {
  fast("dashes", () => pushes("git -" + "-- -".repeat(40) + "-;"));
  fast("-C=", () => pushes("git" + " -C=!".repeat(40) + "x"));
  fast("-C -C", () => pushes("git" + " -C -C".repeat(40) + " x"));
  assert.equal(pushes("git -C repo -c core.x=y --no-pager push origin main").length, 1);
  assert.equal(pushes("git --git-dir=.git push --force origin main")[0]?.force, true);
});

test("answers-prompt KEYSTROKES: echo and printf words read one way", () => {
  fast("echo", () => loginFeed("(echo " + '"" '.repeat(40) + "|) | npm login"));
  fast("printf", () => loginFeed("(printf !" + ";yes;printf !".repeat(40) + " |) | npm login"));
  assert.equal(loginFeed("(sleep 15; printf '\\n'; sleep 300) | npm login")?.login, "npm login");
  assert.equal(loginFeed('echo "y" | npm login')?.login, "npm login");
});

test("compile-split group redirects stay linear", () => {
  fast("redirects", () => statementsOf("{ echo a; } " + ">1".repeat(40) + " >", null, CTX));
  fast("ampersands", () => statementsOf("{ echo a; } " + ">&".repeat(2000) + " >", null, CTX));
  assert.equal(statementsOf("{ echo a; echo b; } 2>&1 > out.log", null, CTX).length, 2);
});

test("walls timeout prefix stays linear", () => {
  fast("--!", () => withoutTimeout("timeout " + "--! ".repeat(40)));
  assert.equal(withoutTimeout("timeout -s KILL -k 5 --foreground 60 npm test"), "npm test");
  assert.equal(withoutTimeout("/usr/bin/timeout 5m make"), "make");
});

test("home segment trims long dash runs in linear time", () => {
  const dashes = "-".repeat(100_000);
  assert.equal(fast("dashes", () => keyFromRemote(`https://github.com/acme/a${dashes}b`)), `github.com/acme/a${dashes}b`);
  assert.equal(keyFromRemote("https://github.com/--Acme--/repo-.git"), "github.com/acme/repo");
});
