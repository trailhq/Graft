/**
 * b7 review of D114 (1), the linked learnings folder: the cases the build
 * left open. A home folder that is itself a git work tree (its `.trail` is
 * the Trail home, not a Trail checkout's), a Trail home that is itself a
 * link, a chain of links, a link whose target is made later, and `trail
 * forget` writing through a link. Made-up folders only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeEveryRepo } from "../src/notes/every-repo.js";
import { guardrailLearning } from "../src/notes/guardrails.js";
import { forgetLearning } from "../src/skills/cli-skills-1b.js";
import { tmpRepo } from "./helpers.js";

const NOW = new Date("2026-10-17T10:00:00Z");
const guard = () => guardrailLearning("timeout-missing", "every repo", "\"timeout: command not found\" on 6 days", NOW);

/** A Trail checkout (`.git` and `.trail/`) under `root/work/shop`. */
function checkout(root: string): string {
  const c = join(root, "work", "shop");
  mkdirSync(join(c, ".git"), { recursive: true });
  mkdirSync(join(c, ".trail", "learnings"), { recursive: true });
  return c;
}

test("a home folder that is a git work tree: a dotfiles link under it is written through (its .trail is the Trail home, not a checkout's)", () => {
  const root = tmpRepo("b7r-link-homegit");
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".git"), { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home, TRAIL_HOME: join(home, ".trail") };
    mkdirSync(env.TRAIL_HOME!, { recursive: true });
    const dots = join(home, "dotfiles", "trail-learnings");
    mkdirSync(dots, { recursive: true });
    symlinkSync(dots, join(env.TRAIL_HOME!, "learnings"));
    writeEveryRepo(guard(), "no-timeout.md", env);
    assert.deepEqual(readdirSync(dots), ["no-timeout.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Trail home that is itself a link into a Trail checkout: no learning is written through it", () => {
  const root = tmpRepo("b7r-link-home");
  try {
    const c = checkout(root);
    const target = join(c, "personal-trail");
    mkdirSync(target, { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });
    symlinkSync(target, join(root, "home", ".trail"));
    const env: NodeJS.ProcessEnv = { HOME: join(root, "home"), TRAIL_HOME: join(root, "home", ".trail") };
    assert.throws(() => writeEveryRepo(guard(), "no-timeout.md", env), /linked into the repo/);
    assert.deepEqual(readdirSync(target), [], "nothing in the checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a chain of links that ends in a Trail checkout is refused; a link made before its target is refused once the target is there", () => {
  const root = tmpRepo("b7r-link-chain");
  try {
    const c = checkout(root);
    const env: NodeJS.ProcessEnv = { HOME: join(root, "home"), TRAIL_HOME: join(root, "trail-home") };
    mkdirSync(env.TRAIL_HOME!, { recursive: true });
    symlinkSync(join(c, ".trail", "learnings"), join(root, "hop"));
    symlinkSync(join(root, "hop"), join(env.TRAIL_HOME!, "learnings"));
    assert.throws(() => writeEveryRepo(guard(), "no-timeout.md", env), /linked into the repo/);
    assert.deepEqual(readdirSync(join(c, ".trail", "learnings")), []);
    // A link to a folder the checkout doesn't have yet: nothing lands there now, nor once the folder is made.
    rmSync(join(env.TRAIL_HOME!, "learnings"));
    const later = join(c, ".trail", "mine");
    symlinkSync(later, join(env.TRAIL_HOME!, "learnings"));
    assert.throws(() => writeEveryRepo(guard(), "no-timeout.md", env), /linked into the repo/, "refused before the target exists, with the reason");
    mkdirSync(later);
    assert.throws(() => writeEveryRepo(guard(), "no-timeout.md", env), /linked into the repo/);
    assert.deepEqual(readdirSync(later), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trail forget does not write through a learnings link into a Trail checkout either (it would change the team's file)", () => {
  const root = tmpRepo("b7r-link-forget");
  try {
    const c = checkout(root);
    const env: NodeJS.ProcessEnv = { HOME: join(root, "home"), TRAIL_HOME: join(root, "trail-home") };
    mkdirSync(join(env.TRAIL_HOME!, "learnings"), { recursive: true });
    const path = writeEveryRepo(guard(), "no-timeout.md", env);
    const text = readFileSync(path, "utf8");
    // The person later links the folder into the checkout, the file with it.
    rmSync(join(env.TRAIL_HOME!, "learnings"), { recursive: true });
    mkdirSync(join(c, ".trail", "learnings"), { recursive: true });
    writeFileSync(join(c, ".trail", "learnings", "no-timeout.md"), text);
    symlinkSync(join(c, ".trail", "learnings"), join(env.TRAIL_HOME!, "learnings"));
    const r = forgetLearning("no-timeout", root, env);
    assert.equal(r?.code, 1, JSON.stringify(r));
    assert.match(r!.lines.join("\n"), /linked into the repo/);
    assert.equal(readFileSync(join(c, ".trail", "learnings", "no-timeout.md"), "utf8"), text, "the team's file is unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trail forget no-timeout works through a dotfiles link (the guardrail deny's way out, R29)", () => {
  const root = tmpRepo("b7r-link-forget-dots");
  try {
    const env: NodeJS.ProcessEnv = { HOME: join(root, "home"), TRAIL_HOME: join(root, "trail-home") };
    mkdirSync(env.TRAIL_HOME!, { recursive: true });
    const dots = join(root, "dotfiles", "trail-learnings");
    mkdirSync(dots, { recursive: true });
    symlinkSync(dots, join(env.TRAIL_HOME!, "learnings"));
    writeEveryRepo(guard(), "no-timeout.md", env);
    const r = forgetLearning("no-timeout", root, env);
    assert.equal(r?.code, 0, JSON.stringify(r));
    assert.match(readFileSync(join(dots, "no-timeout.md"), "utf8"), /status: "?retired"?/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
