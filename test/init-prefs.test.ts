/**
 * Typed preferences found without a model (design 4.4, b5): the shape of a
 * standing or corrective line, clusters of the same words across days, one
 * 8 h sitting refused, and where a preference applies. Made-up lines only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentWords, isPreferenceShape, minePreferences, preferenceApplies, repoWordsOf } from "../src/init/prefs.js";
import type { TypedRef } from "../src/init/types.js";
import { done, world } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";

test("preference shapes: standing and corrective lines", () => {
  for (const t of [
    "always run the linter first",
    "never push to main directly",
    "don't use npm here, use pnpm",
    "do not touch the generated files",
    "please never force push",
    "stop adding comments to every line",
    "use pnpm here",
    "keep the PR small",
    "write commit messages in the present tense",
    "prefer small commits",
    "call it the cart service",
    "run make lint rather than eslint directly",
    "no, use the staging database",
    "actually, put the helpers in src/util",
  ]) assert.equal(isPreferenceShape(t), true, t);
});

test("near misses are not preferences: jobs, questions, long lines, secrets, plain answers", () => {
  for (const t of [
    "publish 1.4.3",
    "run the test suite",
    "push it to beta",
    "did you push?",
    "is it live",
    "should we always run the linter first?",
    "ok",
    "thanks",
    "yes",
    "no",
    "explain how the cart total is computed",
    "always " + "run the linter and then the formatter and then the type checker and then the tests and then the build and then open the PR please",
    "always use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "the build is broken again",
    "no idea what that means",
  ]) assert.equal(isPreferenceShape(t), false, t);
});

test("stemming meets published and publish, pushes and push", () => {
  assert.deepEqual(contentWords("never published from a branch"), contentWords("never publish from a branch"));
  assert.deepEqual(contentWords("it pushes"), contentWords("push"));
});

let o = 0;
const ref = (): TypedRef => ({ t: "/home/dev/.claude/projects/-home-dev-shop/s.jsonl", o: (o += 100), s: "a".repeat(64) });
const line = (text: string, at: string) => ({ ref: ref(), day: at.slice(0, 10), at, text });

test("a cluster on 2+ days is kept, with the shortest line and up to 3 pointers, shortest first", () => {
  const typed = [
    line("always run the linter first", "2026-09-01T10:00:00Z"),
    line("always run the linter first, please", "2026-09-03T10:00:00Z"),
    line("please always run the linter first before pushing", "2026-09-05T10:00:00Z"),
    line("always run linter first", "2026-09-07T10:00:00Z"),
    line("keep the PR small", "2026-09-07T11:00:00Z"),
  ];
  const found = minePreferences(typed, new Date("2026-09-10T00:00:00Z"));
  assert.equal(found.length, 1);
  const c = found[0]!;
  assert.equal(c.shortest, "always run linter first");
  assert.deepEqual(c.days, ["2026-09-01", "2026-09-03", "2026-09-05", "2026-09-07"]);
  assert.equal(c.refs.length, 3);
  assert.equal(c.refs[0], typed[3]!.ref, "the shortest line's pointer first");
  assert.deepEqual(c.refs.slice(1), [typed[2]!.ref, typed[1]!.ref], "then the newest");
  assert.match(c.sha, /^[0-9a-f]{16}$/);
  // The cluster's sha holds when the person says it again later.
  const again = minePreferences([...typed, line("always run the linter first!", "2026-09-09T10:00:00Z")], new Date("2026-09-10T00:00:00Z"));
  assert.equal(again[0]!.sha, c.sha);
});

test("one 8 h sitting across midnight is one sitting, not two days; one day is not enough", () => {
  const sitting = [line("never force push to main", "2026-09-01T23:00:00Z"), line("never force push to main", "2026-09-02T01:00:00Z")];
  assert.deepEqual(minePreferences(sitting), []);
  const oneDay = [line("use pnpm here", "2026-09-01T09:00:00Z"), line("use pnpm here", "2026-09-01T18:00:00Z")];
  assert.deepEqual(minePreferences(oneDay), []);
  const twoDays = [line("use pnpm here", "2026-09-01T09:00:00Z"), line("use pnpm here please", "2026-09-04T09:00:00Z")];
  assert.equal(minePreferences(twoDays).length, 1);
});

test("a preference naming the repo applies to this repo; one naming nothing of it, to every repo", () => {
  const w = world("applies");
  try {
    mkdirSync(join(w.repo, "scripts"), { recursive: true });
    writeFileSync(join(w.repo, "scripts", "seed.sh"), "#!/bin/sh\n");
    const words = repoWordsOf(w.repo, ["pnpm", "make"]);
    for (const w2 of ["lint", "build", "release", "acme-shop", "scripts", "makefile", "main"]) assert.ok(words.has(w2), w2);
    // D102: a common program the sessions ran is not one of the repo's own names.
    for (const w2 of ["pnpm", "make"]) assert.equal(words.has(w2), false, w2);
    assert.equal(preferenceApplies("run the lint script before you push", words), "this repo");
    assert.equal(preferenceApplies("use pnpm here", words), "this repo");
    assert.equal(preferenceApplies("put new helpers in scripts/", words), "this repo");
    assert.equal(preferenceApplies("explain it simply, one example first", words), "every repo");
    assert.equal(preferenceApplies("never use em dashes", words), "every repo");
  } finally {
    done(w);
  }
});
