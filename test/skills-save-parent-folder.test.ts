/**
 * D93 (1): a session that starts in a folder that is not a repo (/home/dev/work, with the shop checkout under it)
 * and cds into the repo. The hooks compile the skill with the run's checkout as its root; `trail skills add` runs in
 * the session's folder. Both halves of the save gate take the checkout and repo key from the run itself (its sheet,
 * or the receipt the PreToolUse half wrote), never from the CLI's own folder, so the steps are the same ones and an
 * asked save, or an offer's yes, saves. A checkout that is gone, not a checkout, or another repo is never used.
 * Real fold, real session lock, a made-up repo and transcript.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptSkills } from "../src/claude/prompt-skills.js";
import { runSheetPath, readRunSheet } from "../src/trace/runs.js";
import { skillsGate } from "../src/trace/skill-session.js";
import { runCheckout } from "../src/skills/run-checkout.js";
import { SHOP, add, append, bash, box, ctxAt, iso, kept, nextId, prompt, sayOffer, seedPool, state, stop, where, type Box } from "./skills-consent-fixtures.js";
import { said, toolResult, toolUse, typed } from "./trace-fixtures.js";

const addCmd = (name: string, runId: string) => `trail skills add ${name} --run ${runId}`;
/** The session's own folder: the box's `src`, which holds the shop checkout and is not one itself. */
const parentOf = (b: Box) => join(b.root, "src");

/**
 * A release that worked. `fromParent`: the session sits in the parent folder, and the first call cds into the
 * checkout and fetches; the calls after it run in the checkout, as the host records them.
 */
function release(b: Box, sec: number, fromParent: boolean): void {
  const first = { ...where(b, sec), ...(fromParent ? { cwd: parentOf(b) } : {}) };
  append(b, [typed("publish 1.4.3", first)]);
  const id = nextId(b);
  // The lab's shape: the fold can't follow this cd, so the call is put down to the parent folder (no repo, no folder).
  const fetch = fromParent ? `cd "${b.repo}" 2>/dev/null || { echo "repo not found"; exit 1; }\ngit fetch -q origin` : "git fetch -q origin";
  append(b, [toolUse(id, "Bash", { command: fetch, description: "run it" }, { ...first, timestamp: iso(sec + 5) }), toolResult(id, "", false, { ...first, timestamp: iso(sec + 6) })]);
  bash(b, sec + 10, "npm run build", "built in 2.1s");
  bash(b, sec + 20, "npm publish acme-cli-1.4.3.tgz --access public", "+ acme-cli@1.4.3");
  bash(b, sec + 30, "npm view acme-cli version", "1.4.3");
  append(b, [said("Published 1.4.3; npm shows it.", where(b, sec + 40))]);
}

/** The real prompt hook, its ctx in the checkout (the host's cwd after the cd): the run id it tells the agent to add. */
function realAsk(b: Box, sec: number, words: string): string {
  append(b, [typed(words, where(b, sec))]);
  const gate = (input: unknown, dir: string, env?: NodeJS.ProcessEnv) => {
    const g = skillsGate(input, dir, env);
    return g.ok ? { ok: true as const, ctx: { ...g.ctx, checkout: b.repo, repoKey: SHOP } } : g;
  };
  const out = promptSkills({ ...b.payload, hook_event_name: "UserPromptSubmit", prompt: words }, "/home/dev/shop", { ...b.env, TRAIL_TEST_NOW: iso(sec) }, { track: () => {}, gate });
  const m = /trail skills add ([a-z0-9-]+) --run (r-[\w-]+)/.exec(out.context ?? "");
  assert.ok(m, out.context);
  return m[2]!;
}

const stepsOf = (b: Box, name: string) => readFileSync(join(b.env.TRAIL_HOME!, "skills", name, "SKILL.md"), "utf8");

test("an asked save from a session that started in a parent folder saves, with the step the cd ran (prompt hook, PreToolUse, CLI)", () => {
  const b = box();
  release(b, 0, true);
  stop(b, 50);
  const runId = realAsk(b, 70, "save this as a skill");
  const name = state(b).saveRequest!.name!;
  const r = add(b, 80, addCmd(name, runId), { cliCwd: parentOf(b) });
  assert.equal(r.decision, null, JSON.stringify(r.decision));
  assert.deepEqual(r.cli?.lines.slice(0, 1).map((l) => l.startsWith(`✓ saved ${name}`)), [true], JSON.stringify(r.cli));
  assert.deepEqual(r.cli?.saved, { from: "asked", scope: "personal" });
  assert.deepEqual(kept(b), { skills: [name], held: [] });
  assert.match(stepsOf(b, name), /git fetch -q origin/);
  assert.equal(readRunSheet(runId, b.env)!.checkout, b.repo, "the run sheet keeps the checkout the run ran in");
});

test("the same asked save, started inside the repo, still saves", () => {
  const b = box();
  release(b, 0, false);
  stop(b, 50);
  const runId = realAsk(b, 70, "save this as a skill");
  const name = state(b).saveRequest!.name!;
  const r = add(b, 80, addCmd(name, runId));
  assert.deepEqual(r.cli?.saved, { from: "asked", scope: "personal" }, JSON.stringify(r));
  assert.match(stepsOf(b, name), /git fetch -q origin/);
});

test("an offer's yes (moment 2) from a session that started in a parent folder saves", () => {
  const b = box();
  seedPool(b);
  release(b, 0, true);
  const s = stop(b, 50);
  assert.ok(s.offer, s.why);
  sayOffer(b, 52, s.offer);
  prompt(b, 70, "yes");
  const r = add(b, 80, addCmd(s.offer.name, s.offer.runId), { cliCwd: parentOf(b) });
  assert.equal(r.decision, null, JSON.stringify(r.decision));
  assert.deepEqual(r.cli?.saved, { from: "repeated", scope: "personal" }, JSON.stringify(r.cli));
  assert.deepEqual(kept(b).skills, [s.offer.name]);
  assert.match(stepsOf(b, s.offer.name), /git fetch -q origin/);
});

test("a run sheet whose checkout names another repo is not used: with no checkout of the run's to fall back on, the save is refused", () => {
  const b = box();
  release(b, 0, true);
  stop(b, 50);
  const runId = realAsk(b, 70, "save this as a skill");
  const name = state(b).saveRequest!.name!;
  // Another checkout beside it (acme/other), named in the sheet out of sight.
  const other = join(parentOf(b), "other");
  mkdirSync(join(other, ".git"), { recursive: true });
  writeFileSync(join(other, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/other.git\n');
  const path = runSheetPath(runId, b.env);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), checkout: other }));
  // PreToolUse's payload is the parent folder too, so neither half has a checkout of the run's repo.
  const ctx = { ...ctxAt(b, 80), checkout: "", repoKey: "local/home-dev-work" };
  const r = add(b, 80, addCmd(name, runId), { ctx, cliCwd: parentOf(b) });
  assert.equal(r.decision?.permissionDecision, "deny", JSON.stringify(r));
  assert.deepEqual(kept(b), { skills: [], held: [] });
  // With the PreToolUse half in the checkout, its receipt names the real one: the forged sheet's is still passed over.
  const again = add(b, 90, addCmd(name, runId), { cliCwd: parentOf(b) });
  assert.deepEqual(again.cli?.saved, { from: "asked", scope: "personal" }, JSON.stringify(again));
  assert.match(stepsOf(b, name), /git fetch -q origin/);
});

test("runCheckout: the run's own checkout when it exists, is a git checkout's top and has the run's key; '' otherwise", () => {
  const b = box();
  const env = b.env;
  const sheet = { repoKey: SHOP, checkout: b.repo };
  assert.equal(runCheckout(sheet, env), b.repo);
  // A hint is used only when the sheet has no checkout of its own that holds.
  assert.equal(runCheckout({ repoKey: SHOP }, env, "", b.repo), b.repo);
  assert.equal(runCheckout({ repoKey: SHOP, checkout: join(b.root, "gone") }, env, b.repo), b.repo);
  for (const bad of [join(b.root, "gone"), parentOf(b), join(b.repo, "src"), "src/shop", b.root]) {
    if (bad === join(b.repo, "src")) mkdirSync(bad, { recursive: true });
    assert.equal(runCheckout({ repoKey: SHOP, checkout: bad }, env), "", bad);
    assert.equal(runCheckout({ repoKey: SHOP }, env, bad), "", bad);
  }
  assert.equal(runCheckout({ repoKey: "github.com/acme/other", checkout: b.repo }, env), "");
  // A real git checkout (git init) works the same.
  const real = join(parentOf(b), "web");
  mkdirSync(real, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: real });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/web.git"], { cwd: real });
  assert.equal(runCheckout({ repoKey: "github.com/acme/web", checkout: real }, env), real);
  rmSync(real, { recursive: true, force: true });
  assert.equal(runCheckout({ repoKey: "github.com/acme/web", checkout: real }, env), "");
});
