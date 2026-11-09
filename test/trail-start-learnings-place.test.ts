/**
 * The session start names each learning where it lives: the repo's in
 * `.trail/learnings/`, the person's own in the Trail home. A preference kept
 * just for the person is never counted as the repo's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteCount, noteCounts, shownPath } from "../src/notes/home.js";
import { writeNote } from "../src/notes/notes.js";
import { teamNotesDirective } from "../src/claude/format.js";
import { tmpRepo } from "./helpers.js";

process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "start-place-home-"));

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function repo(tag: string): string {
  const d = tmpRepo(tag);
  writeFileSync(join(d, "main.py"), `print("${tag}")\n`); // its own root commit: repos sharing one are one repo
  git(d, "init", "-q");
  git(d, "config", "user.name", "Sam Lee");
  git(d, "config", "user.email", "sam@example.com");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  git(d, "remote", "add", "origin", `git@github.com:acme/${tag}.git`);
  return d;
}

const PREF = { title: "run the generator, never hand-edit the generated file", body: "run the generator, never hand-edit the generated file", author: "", date: "2026-10-07", standing: true };

test("a personal preference alone is counted as the person's own, in the Trail home, not the repo's", () => {
  const d = repo("place-personal");
  writeNote(d, PREF, "personal");
  assert.deepEqual(noteCounts(d), { repo: 0, personal: 1 });
  assert.equal(noteCount(d), 1, "the statusline total is unchanged");
  const said = teamNotesDirective(noteCounts(d), true);
  assert.match(said, new RegExp(`^You have 1 learning of your own for this repo from past sessions \\(in ${shownPath(process.env.TRAIL_HOME!).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, just for you, never committed\\)\\.`));
  assert.doesNotMatch(said, /This repo has|\.trail\/learnings\/\)/, "never the repo's, never in the repo's folder");
});

test("repo and personal learnings are counted apart and each named where it lives", () => {
  const d = repo("place-both");
  writeNote(d, { title: "Retry budget is per call", body: "## Decided\nPer call.", author: "Sam", date: "2026-10-06" }, "repo");
  writeNote(d, { title: "Backoff caps at 30s", body: "## Decided\n30s.", author: "Sam", date: "2026-10-08" }, "repo");
  writeNote(d, PREF, "personal");
  assert.deepEqual(noteCounts(d), { repo: 2, personal: 1 });
  const said = teamNotesDirective(noteCounts(d), true);
  assert.match(said, /^This repo has 2 learnings from past sessions, yours and your teammates', on what was decided, tried and ruled out \(in \.trail\/learnings\/\), and 1 of your own \(in .+, just for you, never committed\)\./);
});

test("a bare count is still the repo's, as before", () => {
  assert.match(teamNotesDirective(3, true), /^This repo has 3 learnings from past sessions, yours and your teammates'.*\(in \.trail\/learnings\/\)\. /);
  assert.equal(teamNotesDirective({ repo: 0, personal: 0 }, false), "");
});
