/**
 * D136 (3): the job matcher learns real phrasings. "ship/deploy it to <branch>" is the ship job for any branch the
 * repo has (not only beta, prod and staging), and test-runner words (bats, pytest, go test, jest, vitest, rspec,
 * "<name> tests") are the tests job. 1a's near-miss filters hold: status and history questions, how/what questions,
 * writing or setting up tests, and the 25-word cap. The fold reads the repo's branches from its git folder.
 * Synthetic asks and repos only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchJob } from "../src/trace/jobs.js";
import { repoBranches } from "../src/skills/anchors-git.js";
import { ask, session } from "./trace-run-fixtures.js";

const BRANCHES = new Set(["main", "dev", "qa-2", "release/next"]);
const has = (b: string) => BRANCHES.has(b);
const job = (t: string, opts: Parameters<typeof matchJob>[1] = { hasBranch: has }) => matchJob(t, opts)?.job ?? null;

test("ship or deploy to a branch the repo has is the ship job", () => {
  for (const t of ["ship it to dev", "ok ship it to dev", "can you ship it to dev", "deploy to dev", "deploy it to qa-2", "please deploy this to release/next", "ship to dev now"]) {
    assert.equal(job(t), "ship", t);
  }
  for (const t of ["deploy to dev", "can you ship it to dev"]) assert.equal(job(t, {}), null, `${t}: no branch list, no guess`);
  for (const t of ["deploy it to friday", "can you deploy this to the customer", "ship the docs to someone"]) assert.equal(job(t), null, `${t}: not a branch here`);
});

test("test-runner words are the tests job", () => {
  for (const t of ["sql-output bats please", "run sql-output bats", "run bats", "bats", "pytest -k slow", "go test ./...", "jest", "vitest run", "rspec spec/models",
    "run the jest suite", "sql-output tests please", "api tests", "run sql-output tests"]) {
    assert.equal(job(t), "tests", t);
  }
});

test("near misses stay out: status and history, how and what, writing or setting up tests, and the cap", () => {
  for (const t of ["how did we ship it to dev", "how did we ship X", "did you deploy to dev?", "is it live on dev", "what does bats do", "which jest config do we use",
    "did the bats pass?", "is jest installed?", "write bats tests for sql-output", "add vitest to the project", "install rspec", "set up pytest here",
    "the api tests are failing?", "why does deploy to dev fail"]) {
    assert.equal(job(t), null, t);
  }
  const long = `run sql-output bats ${"and then tell me what you think about the output ".repeat(3)}`;
  assert.ok(long.split(/\s+/).length > 25);
  assert.equal(job(long), null, "over 25 words");
});

test("repoBranches: local and remote branch names from a checkout's git folder, loose and packed", () => {
  const dir = mkdtempSync(join(tmpdir(), "trail-jobs-branches-"));
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=T", "-c", "user.email=t@x.test", "commit", "-q", "--allow-empty", "-m", "one");
    git("branch", "dev");
    git("branch", "release/next");
    git("pack-refs", "--all");
    git("branch", "qa-2");
    git("update-ref", "refs/remotes/origin/staging-eu", "HEAD");
    const b = repoBranches(dir);
    for (const n of ["main", "dev", "release/next", "qa-2", "staging-eu"]) assert.ok(b.has(n), n);
    assert.equal(b.has("HEAD"), false);
    const bare = mkdtempSync(join(tmpdir(), "trail-jobs-nogit-"));
    try {
      assert.equal(repoBranches(bare).size, 0, "outside git");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fold reads the checkout's branches: \"deploy it to dev\" opens a ship run, \"run sql-output bats\" a tests run", () => {
  const dir = mkdtempSync(join(tmpdir(), "trail-jobs-fold-"));
  const s = session("jobs-phrasings");
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=T", "-c", "user.email=t@x.test", "commit", "-q", "--allow-empty", "-m", "one");
    git("branch", "dev");
    const ctx = { checkout: dir, repoKeyOf: () => "github.com/acme/shop", rootOf: () => dir, repoKey: "github.com/acme/shop" };
    s.fold([ask("deploy it to dev", 0)], ctx);
    s.fold([ask("run sql-output bats", 60 * 60)], ctx);
    s.fold([ask("deploy it to friday", 2 * 60 * 60)], ctx);
    assert.deepEqual(s.st.runs.map((r) => r.job), ["ship", "tests", null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(s.path, ".."), { recursive: true, force: true });
  }
});
