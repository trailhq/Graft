/**
 * b7 review: discovery reads the repo keys (and the moved-repo aliases)
 * under the Trail home it is given, never process.env's. A test home, or the
 * lab's, must not reach the real `~/.trail/repos/index.json`. Made-up repos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSessions } from "../src/init/sessions.js";
import { discoverOffThread } from "../src/init/discover-worker.js";
import { repoPlace } from "../src/notes/home.js";
import { tmpRepo } from "./helpers.js";

process.env.TZ = "UTC";
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A repo moved from a path key to its remote, a clone of it, and the alias only in a Trail home of its own. */
function movedRepo(tag: string) {
  const root = tmpRepo(tag);
  const home = join(root, "home");
  const repo = join(root, "work", "shop");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  const clone = join(root, "elsewhere", "shop-copy");
  mkdirSync(clone, { recursive: true });
  git(clone, "init", "-q");
  git(clone, "remote", "add", "origin", "git@github.com:acme/shop.git");
  const trail = join(root, "trail-home");
  mkdirSync(join(trail, "repos"), { recursive: true });
  writeFileSync(join(trail, "repos", "index.json"), JSON.stringify({ aliases: { [repoPlace(repo, { TRAIL_HOME: trail }).key]: "github.com/acme/shop" }, roots: {} }));
  const dir = join(home, ".claude", "projects", clone.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "c-1.jsonl"), `${JSON.stringify({ type: "user", cwd: clone, timestamp: "2026-09-04T10:00:00Z", message: { role: "user", content: "run the tests" } })}\n`);
  return { root, home, repo, trail };
}

test("merge pass: discovery off the main thread reads the Trail home passed in too, never process.env's", async () => {
  const w = movedRepo("b1m-discover-thread");
  try {
    const d = await discoverOffThread(w.repo, w.home, { TRAIL_HOME: w.trail, HOME: w.home });
    assert.deepEqual(d.bySource, { own: 0, worktree: 0, clone: 1, ancestor: 0 });
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("a clone counts through an alias kept only in the Trail home passed in (a repo moved from a path key to its remote)", () => {
  const root = tmpRepo("b7r-discover-env");
  try {
    const home = join(root, "home");
    const repo = join(root, "work", "shop");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q");
    const clone = join(root, "elsewhere", "shop-copy");
    mkdirSync(clone, { recursive: true });
    git(clone, "init", "-q");
    git(clone, "remote", "add", "origin", "git@github.com:acme/shop.git");
    const trail = join(root, "trail-home");
    mkdirSync(join(trail, "repos"), { recursive: true });
    writeFileSync(join(trail, "repos", "index.json"), JSON.stringify({ aliases: { [repoPlace(repo, { TRAIL_HOME: trail }).key]: "github.com/acme/shop" }, roots: {} }));
    const dir = join(home, ".claude", "projects", clone.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "c-1.jsonl"), `${JSON.stringify({ type: "user", cwd: clone, timestamp: "2026-09-04T10:00:00Z", message: { role: "user", content: "run the tests" } })}\n`);
    const d = discoverSessions(repo, home, new Date("2026-09-20T10:00:00Z"), { TRAIL_HOME: trail, HOME: home });
    assert.deepEqual(d.bySource, { own: 0, worktree: 0, clone: 1, ancestor: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
