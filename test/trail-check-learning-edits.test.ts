/**
 * `trail check` reads the learnings a branch changed as they were before it,
 * and calls out an edit to a teammate's learning. In the demo, Kumar's Claude
 * rewrote Maya's "keep 4" learning to say "reversed: now 10" and the check
 * then had nothing to hold the change against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchDiff } from "../src/cloud/diff.js";
import { checkLocally } from "../src/check/local-check.js";
import { learningsAtBase, teammateEdits, withBaseLearnings } from "../src/check/learning-edits.js";
import { learningId } from "../src/notes/learning-fields.js";
import { listNotes } from "../src/notes/notes.js";
import { tmpRepo } from "./helpers.js";

const LEARNING = ".trail/learnings/2026-10-13-default-retrymax-maya.md";
const learning = (decided: string) =>
  `---\ntitle: "Default RetryMax stays at 4"\nauthor: Maya\ndate: 2026-10-13\ntouches:\n  - client.go\n---\n\n## Decided\n${decided}\n`;
const client = (n: number) => `package retryablehttp\n\nvar (\n\tdefaultRetryWaitMax = 30\n\tdefaultRetryMax = ${n}\n)\n`;

function git(repo: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

/** Maya's learning and code on main; a branch that changes both. */
function repoWithEditedLearning(edit: "teammate" | "own"): string {
  const repo = tmpRepo("check-learning-edits");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", edit === "own" ? "Maya" : "Kumar");
  git(repo, "config", "user.email", "x@acme.test");
  mkdirSync(join(repo, ".trail", "learnings"), { recursive: true });
  writeFileSync(join(repo, LEARNING), learning("- Keep defaultRetryMax = 4 in client.go. A user asked for 10; declined."));
  writeFileSync(join(repo, "client.go"), client(4));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "keep 4");
  git(repo, "checkout", "-q", "-b", "raise");
  writeFileSync(join(repo, "client.go"), client(10));
  writeFileSync(join(repo, LEARNING), learning("- Reversed: defaultRetryMax is now 10, at a customer's request."));
  return repo;
}

function check(repo: string, me: string) {
  const d = branchDiff(repo, "main")!;
  const atBase = learningsAtBase(repo, d.from, d.files);
  const r = checkLocally({ diff: d.diff, files: d.files.filter((f) => !f.startsWith(".trail/")), notes: withBaseLearnings(listNotes(repo), atBase), skills: [], asker: me });
  return { r, edits: teammateEdits(repo, atBase, me), atBase };
}

test("a rewritten teammate's learning still holds the change to what it said before", () => {
  const repo = repoWithEditedLearning("teammate");
  const { r, atBase } = check(repo, "Kumar");
  assert.equal(atBase.length, 1);
  assert.match(atBase[0]!.body, /Keep defaultRetryMax = 4/);
  const onCode = r.findings.find((f) => f.file === "client.go");
  assert.equal(onCode?.verdict, "conflict");
  assert.equal(onCode?.summary, "changes defaultRetryMax from 4 to 10");
});

test("editing a teammate's learning is a conflict of its own", () => {
  const repo = repoWithEditedLearning("teammate");
  const { edits } = check(repo, "Kumar");
  assert.deepEqual(
    edits.map((f) => [f.file, f.verdict, f.summary]),
    [[LEARNING, "conflict", `edits Maya's learning · leave it as it was. To record what changed, ask the person first, and only on their yes save it as a new learning with trail note --replaces ${learningId("2026-10-13-default-retrymax-maya.md")}`]],
  );
  rmSync(join(repo, LEARNING));
  assert.match(check(repo, "Kumar").edits[0]!.summary, /^removes Maya's learning/);
});

test("editing your own learning is fine, and a new learning is never compared with a base", () => {
  const repo = repoWithEditedLearning("own");
  assert.deepEqual(check(repo, "Maya").edits, []);
  const fresh = ".trail/learnings/2026-10-13-raised-to-10-kumar.md";
  writeFileSync(join(repo, fresh), learning("- Raised to 10."));
  assert.equal(learningsAtBase(repo, branchDiff(repo, "main")!.from, [fresh]).length, 0);
});

test("a learning the branch deleted still holds the change to what it said, even your own", () => {
  const repo = repoWithEditedLearning("own");
  git(repo, "rm", "-qf", LEARNING);
  const { r, edits } = check(repo, "Maya");
  assert.deepEqual(edits, [], "your own: no finding for the removal itself");
  const onCode = r.findings.find((f) => f.file === "client.go");
  assert.equal(onCode?.verdict, "conflict");
  assert.equal(onCode?.source.title, "Default RetryMax stays at 4");
});

test("a teammate's learning renamed on the branch is a removal, and still holds the change", () => {
  const repo = repoWithEditedLearning("teammate");
  git(repo, "checkout", "-q", LEARNING);
  const renamed = ".trail/learnings/2026-10-14-retry-notes-kumar.md";
  git(repo, "mv", LEARNING, renamed);
  // git reports a rename by its new name only: the old one still has to be read from the base.
  assert.ok(!branchDiff(repo, "main")!.files.includes(LEARNING));
  const { r, edits } = check(repo, "Kumar");
  assert.deepEqual(edits.map((f) => [f.file, f.summary.split(" · ")[0]]), [[LEARNING, "removes Maya's learning"]]);
  const onCode = r.findings.filter((f) => f.file === "client.go").map((f) => [f.verdict, f.source.path?.endsWith(LEARNING.split("/").pop()!)]);
  assert.deepEqual(onCode[0], ["conflict", true]);
});
