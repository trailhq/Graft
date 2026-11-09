/**
 * D116 item 5: a step that only feeds keystrokes into a `script` login
 * (`(sleep 15; printf '\n'; sleep 300) | script -q /dev/null npm login`) is
 * dropped from the skill instead of refusing the whole run. The login
 * becomes a "Before you start" line ("the person is logged in to npm; they
 * run npm login themselves"), what was fed into it is never stored on disk
 * (not in the session, the run sheet or the skill), and the run still needs
 * its checked success. Any other keystroke feed (into a publish, through
 * expect, a login inside a longer call) still refuses with answers-prompt.
 * Made-up repo, package and keystrokes; a temp Trail home.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loginFeed } from "../src/skills/answers-prompt.js";
import { compileRun, type CompileOpts } from "../src/skills/compile.js";
import { renderSkillMd, parseSkillMd } from "../src/skills/skillmd.js";
import { savePersonal } from "../src/skills/store.js";
import { checkedSuccess, writeRunSheet } from "../src/trace/runs.js";
import { runBlock } from "../src/skills/runblock.js";
import { tmpRepo } from "./helpers.js";
import { ask, bash, reply, session } from "./trace-run-fixtures.js";

const FEED = "(sleep 15; printf 'dev-person\\nNotAPass-77\\n'; sleep 300) | script -q /dev/null npm login";
const OPTS = (home: string): CompileOpts => ({ repoRoot: "/home/dev/shop", home: "/home/dev", platform: "linux", moment: "asked", applies: "github.com/acme/shop", taken: () => false });
const BEFORE = "the person is logged in to npm; they run npm login themselves";

test("loginFeed: keystrokes fed into a login alone; a publish, expect, or a login inside more work is not one", () => {
  assert.deepEqual(loginFeed(FEED), { service: "npm", login: "npm login" });
  assert.deepEqual(loginFeed("(sleep 15; printf '\\n'; sleep 300) | script -q /dev/null npm login"), { service: "npm", login: "npm login" });
  assert.deepEqual(loginFeed("{ sleep 2; echo; } | script -q /dev/null npm login"), { service: "npm", login: "npm login" });
  assert.deepEqual(loginFeed("printf '\\n' | script -q /dev/null gh auth login"), { service: "GitHub", login: "gh auth login" });
  assert.deepEqual(loginFeed("yes | npx vercel login"), { service: "Vercel", login: "vercel login" });
  for (const other of [
    "(sleep 15; printf '\\n'; sleep 300) | script -q /dev/null npm publish", "printf 'y\\n' | npm publish --access public",
    "expect -c 'spawn npm login; expect Username; send dev\\r'", "npm run build && printf 'y\\n' | npm login",
    "npm login", "script -q /dev/null npm login",
  ]) assert.equal(loginFeed(other), null, other);
});

/** The release, folded from a transcript, with the login fed in the middle. */
function releaseRun(tag: string) {
  const s = session(tag);
  s.fold([
    ask("publish 1.4.3 to npm", 0),
    ...bash("npm run build", "built", { sec: 5 }),
    ...bash(FEED, "Logged in on https://registry.npmjs.org/.", { sec: 10 }),
    ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 20 }),
    ...bash("npm view acme-cli version", "1.4.3\n", { sec: 30 }),
    reply("Published acme-cli 1.4.3; npm shows 1.4.3.", 40),
  ]);
  return s;
}

test("the lab case: the login feed is dropped, the rest is kept, and the login is a Before you start line", () => {
  const home = tmpRepo("login-feed-compile");
  const env = { HOME: home, TRAIL_HOME: join(home, ".trail") };
  const s = releaseRun("login-compile");
  const run = s.st.runs[0]!;
  const v = checkedSuccess(run, "Published acme-cli 1.4.3; npm shows 1.4.3.");
  assert.equal(v.checked, true, "the run still checks out on its own check");
  const sheet = writeRunSheet(run, v, { host: "claude", tier: "A", sessionHash: "e76b4ca7f1a0", helpers: [] }, env);
  const r = compileRun(sheet, OPTS(home));
  assert.ok(r.ok, r.ok ? "" : `${r.reason}: ${r.detail}`);
  if (!r.ok) return;
  assert.deepEqual(r.skill.steps.map((x) => x.cmd), ["npm run build", "npm publish --access public"]);
  assert.equal(r.skill.meta["before-you-start"], BEFORE);
  const md = renderSkillMd(r.skill);
  assert.ok(md.includes(`## Before you start\n- ${BEFORE}`), md);
  const parsed = parseSkillMd(md, r.skill.name)!;
  assert.equal(parsed.meta["before-you-start"], BEFORE);
  const block = runBlock({ ref: { id: "s-1", name: r.skill.name, scope: "personal", applies: null, dir: "/x", file: "/x/SKILL.md" }, skill: parsed, state: null },
    { values: { version: "1.4.3" }, notes: [], probes: [], canAsk: true, header: "job", lastFail: null });
  assert.ok(block.includes(`  before you start: ${BEFORE}.`), block);

  // Never on disk: not in the session state, the run sheet, or the saved skill.
  savePersonal(r.skill, { from: "asked", runId: run.id, consent: "asked", stepsVerified: r.skill.steps.length, env });
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(env.TRAIL_HOME);
  assert.ok(files.length >= 2, files.join(", "));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes("NotAPass-77") && !text.includes("dev-person") && !text.includes("printf"), `${f} holds what was fed`);
  }
  const state = JSON.stringify(s.st);
  assert.ok(!state.includes("NotAPass-77") && !state.includes("printf"), "nor the session's runs");
});

test("any other keystroke feed still refuses the run with answers-prompt; a run with only the login has no steps left", () => {
  const home = tmpRepo("login-feed-refuse");
  const env = { HOME: home, TRAIL_HOME: join(home, ".trail") };
  const s = session("publish-feed");
  s.fold([ask("publish 1.4.3 to npm", 0), ...bash("npm run build", "built", { sec: 5 }),
    ...bash("printf 'y\\n' | npm publish --access public", "+ acme-cli@1.4.3", { sec: 20 }), ...bash("npm view acme-cli version", "1.4.3\n", { sec: 30 })]);
  const run = s.st.runs[0]!;
  const sheet = writeRunSheet(run, checkedSuccess(run, "Published 1.4.3."), { host: "claude", tier: "A", sessionHash: "e76b4ca7f1a0", helpers: [] }, env);
  const r = compileRun(sheet, OPTS(home));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "answers-prompt");

  const only = session("login-only");
  only.fold([ask("publish 1.4.3 to npm", 0), ...bash(FEED, "Logged in.", { sec: 10 }), ...bash("npm view acme-cli version", "1.4.3\n", { sec: 30 })]);
  const o = only.st.runs[0]!;
  const r2 = compileRun(writeRunSheet(o, checkedSuccess(o, "Done."), { host: "claude", tier: "A", sessionHash: "e76b4ca7f1a0", helpers: [] }, env), OPTS(home));
  assert.equal(r2.ok, false, "the login alone is no skill");
});
