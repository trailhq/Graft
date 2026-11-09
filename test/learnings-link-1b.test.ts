/**
 * A linked `<trail home>/learnings` (D114 (1)): a link into a dotfiles
 * folder stays allowed; a link whose real target is inside a git work tree
 * with a `.trail/` folder (a Trail checkout) is refused by every writer of
 * person-level learnings: the every-repo writer, init's keep and a wall
 * lesson's save. Made-up folders and repos only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeEveryRepo } from "../src/notes/every-repo.js";
import { guardrailLearning } from "../src/notes/guardrails.js";
import { keepItems } from "../src/init/keep.js";
import { writeLesson } from "../src/skills/lessons.js";
import { linkedIntoCheckout } from "../src/notes/linked-learnings.js";
import type { InitItem } from "../src/init/types.js";
import { guardrailCandidate } from "./init-screen-fixtures.js";
import { tmpRepo } from "./helpers.js";

const SHOP = "github.com/acme/shop";
const NOW = new Date("2026-10-17T10:00:00Z");

interface Place { root: string; env: NodeJS.ProcessEnv; dotfiles: string; checkout: string; plainRepo: string }
/** A Trail home, a dotfiles folder, a Trail checkout (`.git` + `.trail/`) and a repo without `.trail/`. */
function place(tag: string): Place {
  const root = tmpRepo(`b7-linked-${tag}`);
  const env: NodeJS.ProcessEnv = { HOME: join(root, "home"), TRAIL_HOME: join(root, "trail-home"), PATH: process.env.PATH };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  const dotfiles = join(root, "dotfiles", "trail-learnings");
  mkdirSync(dotfiles, { recursive: true });
  const checkout = join(root, "work", "shop");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, ".trail", "learnings"), { recursive: true });
  const plainRepo = join(root, "work", "dots");
  mkdirSync(join(plainRepo, ".git"), { recursive: true });
  mkdirSync(join(plainRepo, "trail"), { recursive: true });
  return { root, env, dotfiles, checkout, plainRepo };
}
const linkTo = (p: Place, target: string) => {
  rmSync(join(p.env.TRAIL_HOME!, "learnings"), { recursive: true, force: true });
  symlinkSync(target, join(p.env.TRAIL_HOME!, "learnings"));
};
const guard = () => guardrailLearning("timeout-missing", "every repo", "\"timeout: command not found\" on 6 days", NOW);

test("the every-repo writer: a dotfiles link or a repo without .trail/ is written through; a link into a Trail checkout is refused", () => {
  const p = place("every");
  try {
    linkTo(p, p.dotfiles);
    writeEveryRepo(guard(), "no-timeout.md", p.env);
    assert.deepEqual(readdirSync(p.dotfiles), ["no-timeout.md"]);
    linkTo(p, join(p.plainRepo, "trail"));
    writeEveryRepo(guard(), "no-timeout.md", p.env);
    assert.deepEqual(readdirSync(join(p.plainRepo, "trail")), ["no-timeout.md"]);
    linkTo(p, join(p.checkout, ".trail", "learnings"));
    assert.equal(linkedIntoCheckout(join(p.env.TRAIL_HOME!, "learnings"), p.env), p.checkout);
    assert.throws(() => writeEveryRepo(guard(), "no-timeout.md", p.env), /linked into the repo at .*\.trail folder/);
    assert.deepEqual(readdirSync(join(p.checkout, ".trail", "learnings")), [], "nothing in the checkout");
    // Deeper in the checkout, not under .trail/, is the same repo.
    mkdirSync(join(p.checkout, "docs"), { recursive: true });
    linkTo(p, join(p.checkout, "docs"));
    assert.throws(() => writeEveryRepo(guard(), "no-timeout.md", p.env), /linked into the repo/);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("init's keep: a guardrail is kept through a dotfiles link and refused through a link into a Trail checkout", () => {
  const p = place("keep");
  try {
    const item = { ...guardrailCandidate(), n: 1 } as InitItem;
    linkTo(p, join(p.checkout, ".trail", "learnings"));
    const r = keepItems([item], [item], "tty", p.env, NOW, { dir: p.root, repoKey: SHOP });
    assert.deepEqual(r.kept, []);
    assert.equal(r.refused.length, 1);
    assert.deepEqual(readdirSync(join(p.checkout, ".trail", "learnings")), []);
    linkTo(p, p.dotfiles);
    const ok = keepItems([item], [item], "tty", p.env, NOW, { dir: p.root, repoKey: SHOP });
    assert.equal(ok.kept.length, 1, JSON.stringify(ok.refused));
    assert.deepEqual(readdirSync(p.dotfiles), ["no-timeout.md"]);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a wall lesson's save: written through a dotfiles link, refused through a link into a Trail checkout", () => {
  const p = place("lesson");
  try {
    const lesson = { id: "", skill: null, at: "2026-10-17", text: "\"rootless Docker not found\": colima start", kind: "lesson" as const, src: "repair" as const, wall: "docker-rootless" as const };
    linkTo(p, p.dotfiles);
    writeLesson(lesson, SHOP, p.env);
    assert.equal(readdirSync(p.dotfiles).length, 1);
    linkTo(p, join(p.checkout, ".trail", "learnings"));
    assert.throws(() => writeLesson(lesson, SHOP, p.env), /linked into the repo/);
    assert.deepEqual(readdirSync(join(p.checkout, ".trail", "learnings")), []);
    writeFileSync(join(p.root, "marker"), "");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});
