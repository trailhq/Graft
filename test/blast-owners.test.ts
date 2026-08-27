/**
 * Who the comment tells you to tag.
 *
 * Every case here is a way this feature can do real damage rather than merely be
 * unhelpful: naming a bot, naming the author back to themselves, or — worst —
 * inventing an `@mention` for someone whose commit email carries no handle, which
 * pings a stranger who has nothing to do with the change.
 *
 * The fixture is a real repository with planted history, because the whole
 * feature is a `git log` and a stub of git would only assert the parser against
 * itself. Commit dates are set explicitly so the recency weighting is testable at
 * all: `now` is passed in, and the fixture's commits sit at known distances from it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attachOwners, diffAuthors, githubHandle, localIdentity, ownersFor, sinceLabel } from "../src/blast/owners.js";
import type { BlastReport, ChangedArea, ImpactedModule } from "../src/blast/blast.js";

const DAY = 24 * 60 * 60 * 1000;
/** The fixture's "today". Fixed so a commit planted 10 days back stays 10 days
 * back whenever the suite runs. */
const NOW = Date.parse("2026-08-27T12:00:00Z");

interface Author {
  name: string;
  email: string;
}

const SHRISH: Author = { name: "Shrish Dwivedi", email: "shrish@nanonets.com" };
const FRANKIE: Author = { name: "Frankie-Xu", email: "92643488+Frankie-Xu@users.noreply.github.com" };
const DRIVE_BY: Author = { name: "Passing Stranger", email: "stranger@example.com" };
const BOT: Author = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };
const AUTHOR: Author = { name: "anirudhkumar-nanonets", email: "anirudhkumar@nanonets.com" };

function git(root: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
  });
}

/** Commit `file` as `who`, `daysAgo` before {@link NOW}. */
function commit(root: string, who: Author, file: string, daysAgo: number, body: string): void {
  const full = join(root, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  const when = new Date(NOW - daysAgo * DAY).toISOString();
  git(root, ["add", file]);
  git(root, ["commit", "-m", `touch ${file}`], {
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.email,
    GIT_COMMITTER_DATE: when,
  });
}

/**
 * A repository where ownership of two files is unambiguous and different.
 *
 * `src/a.ts` — Shrish recently and often, Frankie once, a stranger once long ago.
 * `src/b.ts` — Frankie only, plus a bot.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "graft-owners-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@example.com"]);

  commit(root, DRIVE_BY, "src/a.ts", 700, "// typo fix\n");
  commit(root, SHRISH, "src/a.ts", 40, "// a1\n");
  commit(root, SHRISH, "src/a.ts", 20, "// a2\n");
  commit(root, SHRISH, "src/a.ts", 9, "// a3\n");
  commit(root, FRANKIE, "src/a.ts", 3, "// a4\n");
  commit(root, AUTHOR, "src/a.ts", 1, "// a5\n");

  commit(root, FRANKIE, "src/b.ts", 12, "// b1\n");
  commit(root, BOT, "src/b.ts", 2, "// bumped\n");
  return root;
}

test("ranks recent, frequent contributors above old drive-by commits", () => {
  const owners = ownersFor(fixture(), ["src/a.ts"], { now: NOW });
  const names = owners.map((o) => o.name);

  assert.equal(names[0], SHRISH.name, "three recent commits should outrank one from three days ago");
  assert.ok(!names.includes(DRIVE_BY.name), "a single commit from two years back is below the share floor");
  const shrish = owners[0];
  assert.equal(shrish.commits, 3);
  assert.equal(shrish.last, NOW - 9 * DAY);
});

test("never invents a handle, and always finds a real one", () => {
  // The author is excluded, as every real call does: with them in, they take the
  // second of the two per-area slots and Frankie never reaches the assertion.
  const owners = ownersFor(fixture(), ["src/a.ts"], { now: NOW, exclude: [AUTHOR.name] });
  const shrish = owners.find((o) => o.name === SHRISH.name);
  const frankie = owners.find((o) => o.name === FRANKIE.name);

  // The whole safety property of this feature: a work address yields NO handle,
  // so the comment prints a bare name that the author has to tag by hand.
  assert.equal(shrish?.handle, undefined);
  assert.equal(frankie?.handle, "Frankie-Xu");
});

test("drops bots and the PR author", () => {
  const root = fixture();

  const b = ownersFor(root, ["src/b.ts"], { now: NOW });
  assert.deepEqual(b.map((o) => o.name), [FRANKIE.name], "dependabot is not a reviewer");

  // Excluded by GitHub login, by git name and by commit email in turn — CI knows
  // the login, a local run knows the email, and a squash-merge alias may differ
  // from both.
  for (const who of ["anirudhkumar-nanonets", "anirudhkumar@nanonets.com", AUTHOR.name]) {
    const a = ownersFor(root, ["src/a.ts"], { now: NOW, exclude: [who] });
    assert.ok(!a.some((o) => o.name === AUTHOR.name), `"${who}" should exclude the author`);
  }
});

test("the share floor yields when there is nobody else", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-owners-solo-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@example.com"]);
  commit(root, DRIVE_BY, "src/only.ts", 600, "// one commit, long ago\n");

  // The same commit that loses to a real owner in the first test wins here: the
  // floor is a share of what remains, so "the only person who ever touched this"
  // is never filtered down to nobody.
  const owners = ownersFor(root, ["src/only.ts"], { now: NOW });
  assert.deepEqual(owners.map((o) => o.name), [DRIVE_BY.name]);
});

test("outside a git repository the whole layer stays silent", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "graft-owners-nogit-"));
  writeFileSync(join(notARepo, "a.ts"), "// x\n");
  assert.deepEqual(ownersFor(notARepo, ["a.ts"], { now: NOW }), []);
});

test("attachOwners fills both sides and ranks changed areas above affected ones", () => {
  const root = fixture();
  const area: ChangedArea = {
    label: "A", labelSource: "symbol", key: "src/", files: ["src/a.ts"], seeds: 1,
    tests: "none", testFiles: [], changedTestFiles: [], reached: 0, behavioural: 1,
    unreached: [], seedNames: ["doThing"],
  };
  const mod: ImpactedModule = {
    label: "B", labelSource: "symbol", key: "src/b", files: ["src/b.ts"], symbols: [], from: ["src/a.ts"],
  };
  const report = {
    basis: "t", depth: 2, changed: [], unindexed: [], deleted: [], seeds: [], impacted: [],
    modules: [mod], areas: [area], testModules: [],
  } as unknown as BlastReport;

  attachOwners(root, report, { now: NOW, exclude: [AUTHOR.name] });

  assert.ok((area.owners?.length ?? 0) > 0, "the changed area gets owners");
  assert.deepEqual(mod.owners?.map((o) => o.name), [FRANKIE.name], "so does the affected module");
  assert.equal(report.reviewers?.[0].name, SHRISH.name, "the changed area outweighs the affected one");
  // Frankie owns one of each, so their reason cites both labels.
  const frankie = report.reviewers?.find((r) => r.name === FRANKIE.name);
  assert.deepEqual(frankie?.areas.sort(), ["A", "B"]);
});

test("the two ways an author is kept out of their own suggestions", () => {
  const root = fixture();

  // CI: every author in the range. `HEAD~2...HEAD` is Frankie's b1 and the bot's
  // bump, so Frankie is the author of this "PR" and not a reviewer of it.
  const authors = diffAuthors(root, "HEAD~2");
  assert.ok(authors.includes(FRANKIE.email), `expected Frankie's email in ${JSON.stringify(authors)}`);
  const a = ownersFor(root, ["src/a.ts"], { now: NOW, exclude: authors });
  assert.ok(!a.some((o) => o.name === FRANKIE.name), "an author of the range is not a reviewer of it");

  // Local: no range exists, so the git identity stands in. Without this, `graft
  // blast` on a dirty tree tells you to tag yourself.
  git(root, ["config", "user.name", SHRISH.name]);
  git(root, ["config", "user.email", SHRISH.email]);
  const me = localIdentity(root);
  assert.deepEqual(me, [SHRISH.name, SHRISH.email]);
  const local = ownersFor(root, ["src/a.ts"], { now: NOW, exclude: me });
  assert.ok(!local.some((o) => o.name === SHRISH.name), "the local identity is not their own reviewer");
});

test("handle parsing accepts both noreply forms and nothing else", () => {
  assert.equal(githubHandle("92643488+Frankie-Xu@users.noreply.github.com"), "Frankie-Xu");
  assert.equal(githubHandle("qoole@users.noreply.github.com"), "qoole");
  assert.equal(githubHandle("shrish@nanonets.com"), null);
  // A lookalike domain must not become a mention.
  assert.equal(githubHandle("someone@users.noreply.github.com.evil.test"), null);
});

test("sinceLabel reads as a person would say it", () => {
  assert.equal(sinceLabel(NOW, NOW), "today");
  assert.equal(sinceLabel(NOW - DAY, NOW), "yesterday");
  assert.equal(sinceLabel(NOW - 9 * DAY, NOW), "9d ago");
  assert.equal(sinceLabel(NOW - 90 * DAY, NOW), "3mo ago");
  assert.equal(sinceLabel(NOW - 800 * DAY, NOW), "2y ago");
});
