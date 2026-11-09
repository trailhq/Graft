/**
 * D116 item 4, as D120 (2) narrowed it: a skill's `ready` clean-tree probe
 * ignores what `trail init` itself left in the checkout (`.trail/README.md`,
 * the hook shim under `.claude/helpers/`, its entries merged into
 * `.claude/settings.json`), by its install record. The lab saw every release
 * block open with "Uncommitted changes here" in a repo whose wiring wasn't
 * committed yet. Any other dirty file still blocks, a later change to
 * `.claude/settings.json` included. Real temp repos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { runProbes } from "../src/skills/probes.js";
import { mergeGraftSettings } from "../src/claude/settings-merge.js";
import { recordInstall, snapInstall } from "../src/init/install-record.js";
import { cand, shipSkill } from "./skills-recall-fixtures.js";

const NOW = new Date("2026-10-20T10:00:00.000Z");
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: GIT_ENV });
const commit = (repo: string) => {
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=dev@example.com", "-c", "user.name=dev", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
};
const PERSON_SETTINGS = { model: "sonnet", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] }, permissions: { allow: ["Bash(make:*)"] } };

function box(tag: string, tracked: Record<string, string> = {}) {
  const home = tmpRepo(`probes-trail-${tag}`);
  const repo = join(home, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "shop\n");
  for (const [rel, text] of Object.entries(tracked)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  commit(repo);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TRAIL_HOME: join(home, "trail-home") };
  return { home, repo, env };
}

const INIT_PATHS = [".trail/README.md", ".claude/helpers/trail-hooks.cjs", ".claude/helpers/trail-statusline.cjs", ".claude/helpers/graft-hooks.cjs",
  ".claude/helpers/graft-statusline.cjs", ".claude/settings.json"];

/** What `trail init` leaves: `.trail/`, the shims (graft's taken out), its entries merged into settings.json, and its record. */
function trailInit(b: { repo: string; env: NodeJS.ProcessEnv }, settings: Record<string, unknown> = {}) {
  const snap = snapInstall(b.repo, INIT_PATHS, b.env);
  const repo = b.repo;
  mkdirSync(join(repo, ".trail", "learnings"), { recursive: true });
  writeFileSync(join(repo, ".trail", "README.md"), "learnings live here\n");
  mkdirSync(join(repo, ".claude", "helpers"), { recursive: true });
  for (const kind of ["hooks", "statusline"]) {
    rmSync(join(repo, ".claude", "helpers", `graft-${kind}.cjs`), { force: true });
    writeFileSync(join(repo, ".claude", "helpers", `trail-${kind}.cjs`), "// shim\n");
  }
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify(mergeGraftSettings(settings, { name: "trail" }).merged, null, 2));
  recordInstall(snap, b.env);
}

const edit = (repo: string, settings: Record<string, unknown>) =>
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify(mergeGraftSettings(settings, { name: "trail" }).merged, null, 2));

let tick = 0;
/** One clean probe, past the 10-minute cache each time. */
function clean(b: { repo: string; env: NodeJS.ProcessEnv }) {
  const r = runProbes(cand(shipSkill({ ready: "git status --porcelain" })).skill, b.repo, new Date(NOW.getTime() + ++tick * 11 * 60_000), b.env);
  return r[0];
}

test("the lab case: right after trail init, with nothing of the person's dirty, the tree reads clean", () => {
  const b = box("init", { ".claude/settings.json": JSON.stringify(PERSON_SETTINGS, null, 2) });
  trailInit(b, PERSON_SETTINGS);
  assert.equal(clean(b)?.ok, true);
});

test("a repo with no .claude/ before trail init: the untracked folder holding only Trail's files reads clean", () => {
  const b = box("fresh");
  trailInit(b);
  assert.equal(clean(b)?.ok, true);
  writeFileSync(join(b.repo, ".claude", "todo.md"), "mine\n");
  assert.equal(clean(b)?.ok, false, "a file of the person's in the same new folder still blocks");
});

test("graft's shims replaced by Trail's (deleted and untracked) read clean too", () => {
  const b = box("rename", { ".claude/helpers/graft-hooks.cjs": "// old\n", ".claude/helpers/graft-statusline.cjs": "// old\n" });
  trailInit(b);
  assert.equal(clean(b)?.ok, true);
});

test("any other dirty file still blocks: a source file, a staged one, another change to settings.json", () => {
  const b = box("dirty", { ".claude/settings.json": JSON.stringify(PERSON_SETTINGS, null, 2), "src/app.ts": "export {};\n" });
  trailInit(b, PERSON_SETTINGS);
  writeFileSync(join(b.repo, "src", "app.ts"), "export const x = 1;\n");
  assert.deepEqual(clean(b), { probe: "git status --porcelain", ok: false, why: "Uncommitted changes here", fix: "Tell the person; don't commit or stash for them." });

  const c = box("settings", { ".claude/settings.json": JSON.stringify(PERSON_SETTINGS, null, 2) });
  trailInit(c, PERSON_SETTINGS);
  edit(c.repo, { ...PERSON_SETTINGS, model: "opus" });
  assert.equal(clean(c)?.ok, false, "the person's model change after init is theirs");

  const d = box("hook", { ".claude/settings.json": JSON.stringify(PERSON_SETTINGS, null, 2) });
  trailInit(d, PERSON_SETTINGS);
  edit(d.repo, { ...PERSON_SETTINGS, hooks: { ...PERSON_SETTINGS.hooks, PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint-guard" }] }] } });
  assert.equal(clean(d)?.ok, false, "a hook of the person's added next to Trail's still blocks");

  const e = box("trail-learning");
  trailInit(e);
  writeFileSync(join(e.repo, "Makefile"), "all:\n");
  git(e.repo, "add", "Makefile");
  assert.equal(clean(e)?.ok, false, "a staged file of the person's blocks");
});
