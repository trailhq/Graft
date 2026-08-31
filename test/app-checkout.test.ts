/**
 * Getting a pull request onto disk.
 *
 * The ref names are the fiddly part and the easiest to get silently wrong:
 * `refs/pull/N/merge` is GitHub's own merge of the PR into its base — what will
 * actually land — and reviewing the head branch instead would report a radius
 * for code that was never going to exist. A local bare repository stands in for
 * GitHub here, so this exercises the real git commands with no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutPullRequest, redact } from "../src/app/checkout.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });

/**
 * A stand-in for GitHub: a mirror holding `main` and the merge ref.
 *
 * `--mirror`, not `--bare`: a bare clone copies branches and tags, and the ref
 * that matters here lives under `refs/pull/`.
 */
function fakeGitHub(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "graft-origin-"));
  const work = join(root, "work");
  execFileSync("git", ["init", "--quiet", "-b", "main", work]);
  git(work, "config", "user.email", "t@e");
  git(work, "config", "user.name", "t");
  writeFileSync(join(work, "base.txt"), "base\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "base");

  git(work, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(work, "feature.txt"), "feature\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "feature");

  // GitHub publishes the merge commit under refs/pull/N/merge; reproduce it.
  git(work, "checkout", "--quiet", "main");
  git(work, "merge", "--quiet", "--no-ff", "-m", "merge", "feature");
  git(work, "update-ref", "refs/pull/7/merge", "HEAD");
  git(work, "checkout", "--quiet", "main");
  git(work, "reset", "--hard", "--quiet", "HEAD~1");

  execFileSync("git", ["clone", "--quiet", "--mirror", work, join(root, "demo.git")]);
  return { root, repo: "demo" };
}

test("checkout: lands on the merge ref, with the base fetched to diff against", () => {
  const origin = fakeGitHub();
  // The remote is built as `${api}/${owner}/${repo}.git`, so `api` points at the
  // directory holding the mirror and `owner` is a no-op path segment.
  const checkout = checkoutPullRequest({
    owner: ".",
    repo: origin.repo,
    number: 7,
    baseRef: "main",
    token: "ghs_secret_token",
    api: `file://${origin.root}`,
  });

  try {
    // The merge ref carries BOTH sides; the base branch alone carries neither.
    assert.equal(readFileSync(join(checkout.dir, "feature.txt"), "utf8"), "feature\n");
    assert.equal(readFileSync(join(checkout.dir, "base.txt"), "utf8"), "base\n");

    const diff = execFileSync("git", ["diff", "--name-only", checkout.base, "HEAD"], { cwd: checkout.dir, encoding: "utf8" });
    assert.equal(diff.trim(), "feature.txt", "the base ref is present and diffs to the PR's change");

    // The token must not be recoverable from the checkout it produced.
    const config = readFileSync(join(checkout.dir, ".git", "config"), "utf8");
    assert.ok(!config.includes("ghs_secret_token"), "no token in .git/config");
    assert.ok(!config.includes(Buffer.from("x-access-token:ghs_secret_token").toString("base64")), "nor encoded");
  } finally {
    checkout.cleanup();
  }
  rmSync(origin.root, { recursive: true, force: true });
});

test("checkout: a failure names the step and never leaks the token", () => {
  const parent = mkdtempSync(join(tmpdir(), "graft-empty-"));
  try {
    checkoutPullRequest({
      owner: ".",
      repo: "does-not-exist",
      number: 1,
      baseRef: "main",
      token: "ghs_secret_token",
      api: `file://${parent}`,
    });
    assert.fail("expected the fetch to fail");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /failed at fetch/, "says which step, so a missing merge ref is not read as a permissions problem");
    assert.ok(!msg.includes("ghs_secret_token"), "git's error text is redacted before it is thrown");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("redact: removes the token in both the shapes it appears in", () => {
  const encoded = Buffer.from("x-access-token:ghs_abc").toString("base64");
  const text = `fatal: auth failed for ghs_abc using Basic ${encoded}`;

  const clean = redact(text, "ghs_abc");
  assert.ok(!clean.includes("ghs_abc"));
  assert.ok(!clean.includes(encoded));
  assert.match(clean, /fatal: auth failed for \[token\] using Basic \[token\]/);
});
