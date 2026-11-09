/**
 * b5 review: typed preferences (design 4.4, D102). Style lines are a
 * preference shape that applies in every repo; a common program never makes
 * a line "this repo"; only the person's own lines count, never a quoted
 * block or a pasted one. Made-up lines only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPreferenceShape, minePreferences, preferenceApplies, repoWordsOf } from "../src/init/prefs.js";
import type { TypedRef } from "../src/init/types.js";
import { done, world } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";

const STYLE = [
  "explain it simply",
  "explain it simply, one example first",
  "explain things simply please",
  "keep it short",
  "keep answers short",
  "keep replies brief",
  "use plain words",
  "use simple words",
  "plain english please",
  "no jargon",
  "no jargon please",
  "less jargon",
  "be brief",
  "be concise",
  "shorter answers please",
];

test("D102: style lines are a preference shape", () => {
  for (const t of STYLE) assert.equal(isPreferenceShape(t), true, t);
  // Still not a question, a job or a long line.
  assert.equal(isPreferenceShape("can you explain it simply?"), false);
  assert.equal(isPreferenceShape("explain how the cart total is computed"), false);
});

test("D102: style lines apply in every repo, whatever the repo's own words", () => {
  const words = new Set(["short", "simple", "plain", "words", "jargon", "brief", "explain", "answers"]);
  for (const t of STYLE) assert.equal(preferenceApplies(t, words), "every repo", t);
});

test("D102: a common program never makes a line this repo; a script, path, branch, package or file name does", () => {
  const w = world("d102");
  try {
    mkdirSync(join(w.repo, "docker"), { recursive: true });
    mkdirSync(join(w.repo, "scripts"), { recursive: true });
    writeFileSync(join(w.repo, "scripts", "seed.sh"), "#!/bin/sh\n");
    writeFileSync(join(w.repo, "Dockerfile"), "FROM scratch\n");
    const words = repoWordsOf(w.repo, ["git", "npm", "pnpm", "docker", "node", "python", "go", "make", "gh", "yarn", "acmectl", "seed.sh"]);
    // Not one of the repo's own names: a common program (even as a folder name) or any program the sessions ran.
    for (const p of ["git", "npm", "pnpm", "docker", "node", "make", "acmectl"]) assert.equal(words.has(p), false, p);
    assert.ok(words.has("seed.sh") && words.has("dockerfile") && words.has("scripts"));
    // And whatever a caller passes, a common program never makes a line this repo.
    const given = new Set(["git", "npm", "docker", "node"]);
    for (const t of ["always use git rebase", "never use npm", "run docker compose down", "use node 22"]) assert.equal(preferenceApplies(t, given), "every repo", t);
    for (const t of [
      "always use git rebase, not merge",
      "never use npm, use pnpm",
      "always run docker compose down after",
      "use node 22",
      "prefer python over shell",
      "always run go vet first",
      "never use yarn",
      "use gh to open the PR",
    ]) assert.equal(preferenceApplies(t, words), "every repo", t);
    for (const t of [
      "run the lint script before you push",
      "put new helpers in scripts/",
      "run seed.sh before the tests",
      "never edit the Dockerfile by hand",
      "always bump acme-shop's version",
      "use pnpm here",
      "in this repo, use pnpm",
    ]) assert.equal(preferenceApplies(t, words), "this repo", t);
  } finally {
    done(w);
  }
});

let o = 0;
const ref = (): TypedRef => ({ t: "/home/dev/.claude/projects/-home-dev-shop/s.jsonl", o: (o += 100), s: "a".repeat(64) });
const line = (text: string, at: string) => ({ ref: ref(), day: at.slice(0, 10), at, text });

test("a quoted teammate message or a pasted block is never a preference's words", () => {
  const quoted = [
    line("> never deploy on fridays\nkeep that in mind", "2026-09-01T10:00:00Z"),
    line("> never deploy on fridays\nkeep that in mind please", "2026-09-03T10:00:00Z"),
  ];
  for (const c of minePreferences(quoted)) {
    assert.doesNotMatch(c.shortest, /fridays/, "the quoted words are not the title");
  }
  // The quoted lines alone are the same preference on 2 days: still nothing, they are not the person's.
  const onlyQuote = [
    line("> always squash merge\nok", "2026-09-01T10:00:00Z"),
    line("> always squash merge\nok", "2026-09-04T10:00:00Z"),
  ];
  assert.deepEqual(minePreferences(onlyQuote), []);
  const code = [
    line("always format it like this:\n```\nconst secretSauce = mixTheRedBlueGreen(1, 2, 3);\n```", "2026-09-01T10:00:00Z"),
    line("always format it like this:\n```\nconst secretSauce = mixTheRedBlueGreen(4, 5, 6);\n```", "2026-09-05T10:00:00Z"),
  ];
  for (const c of minePreferences(code)) assert.doesNotMatch(c.shortest, /secretSauce|```/, "a pasted code block is not the title");
  const pasted = [
    line("always keep this layout [pasted text]", "2026-09-01T10:00:00Z"),
    line("always keep this layout [pasted text]", "2026-09-05T10:00:00Z"),
  ];
  for (const c of minePreferences(pasted)) assert.doesNotMatch(c.shortest, /pasted text/);
});
