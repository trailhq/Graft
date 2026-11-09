/**
 * `trail init`'s learnings from Claude Code's memory of the repo: which notes
 * are this repo's (its own folder, its worktrees, and other clones of the same
 * remote), how a note reads as a learning, which are offered for the team, and
 * that each is offered once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameRepoRoots, sessionFiles } from "../src/notes/cold-start.js";
import { remoteKey } from "../src/notes/home.js";
import { finishMemoryRead, memoryBody, memoryCandidates, memoryDirs, memoryTitle, offeredBefore, readMemoryNote, readsAsLearning } from "../src/notes/memory-notes.js";
import { claudeProjectDir } from "../src/notes/session-cost.js";
import { alreadySaid, codeAnchors, knownText } from "../src/notes/team-check.js";
import { tmpRepo } from "./helpers.js";

function gitRepo(tag: string, remote: string, extra: string[][] = []): string {
  const repo = tmpRepo(tag);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  for (const args of extra) spawnSync("git", args, { cwd: repo });
  return repo;
}

function note(dir: string, file: string, front: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\n${front}\n---\n\n${body}\n`);
}

/** A home where Claude Code ran in `checkout` (one transcript) and keeps these memory notes for it. */
function homeWithMemory(checkout: string, notes: [string, string, string][]): string {
  const home = mkdtempSync(join(tmpdir(), "memory-home-"));
  const project = claudeProjectDir(checkout, home);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "s1.jsonl"), JSON.stringify({ type: "user", cwd: checkout, message: { content: "hi" } }) + "\n");
  for (const [file, front, body] of notes) note(join(project, "memory"), file, front, body);
  note(join(project, "memory"), "MEMORY.md", "name: index", "- [x](x.md)");
  return home;
}

async function withTrailHome(run: () => Promise<void> | void): Promise<void> {
  const env = { TRAIL_HOME: process.env.TRAIL_HOME, DO_NOT_TRACK: process.env.DO_NOT_TRACK };
  process.env.TRAIL_HOME = join(mkdtempSync(join(tmpdir(), "memory-trail-")), ".trail");
  process.env.DO_NOT_TRACK = "1";
  try {
    await run();
  } finally {
    process.env.TRAIL_HOME = env.TRAIL_HOME;
    process.env.DO_NOT_TRACK = env.DO_NOT_TRACK;
  }
}

test("a memory note reads with its type at the top or under metadata, and the MEMORY.md index is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-read-"));
  note(dir, "a.md", "name: deploy-steps\ndescription: \"How the API ships: tag, then promote\"\nmetadata:\n  node_type: memory\n  type: project\n  modified: 2026-10-13T10:54:06.496Z", "Tag first.");
  note(dir, "b.md", "name: Short replies\ndescription: keep it short\ntype: feedback", "Short.");
  note(dir, "MEMORY.md", "name: index", "- a");
  const a = readMemoryNote(join(dir, "a.md"))!;
  assert.equal(a.type, "project");
  assert.equal(a.description, "How the API ships: tag, then promote");
  assert.equal(a.updated, "2026-10-13");
  assert.equal(readMemoryNote(join(dir, "b.md"))!.type, "feedback");
  assert.equal(readMemoryNote(join(dir, "MEMORY.md")), null);
});

test("a memory note's title is its name when that's words, else its description's first clause", () => {
  assert.equal(memoryTitle({ name: "AGENTS-1178 PDF Split Timeout Fix", description: "Status of the fix." }), "AGENTS-1178 PDF Split Timeout Fix");
  assert.equal(memoryTitle({ name: "graft-fingerprint-cache-bug", description: "deleting fingerprint.*.json triggers a full re-parse (46s); prune extract.*.json only" }), "Deleting fingerprint.*.json triggers a full re-parse (46s)");
  assert.equal(memoryTitle({ name: "demo-kit", description: "" }), "Demo kit");
});

test("a memory note's body becomes Decided, with its Why, and Watch out from its How to apply", () => {
  const body = memoryBody({ body: "## Status\nRetries stay at 4 in `client.go`. See [[retry-budget]].\n\n**Why:** the gateway times out at 30 s.\n\n**How to apply:** raise the per-call timeout instead." });
  assert.match(body, /^## Decided\n\*\*Status\*\*\nRetries stay at 4 in `client\.go`\. See retry-budget\./);
  assert.match(body, /\*\*Why:\*\* the gateway times out at 30 s\./);
  assert.match(body, /\n## Watch out\nraise the per-call timeout instead\.$/);
});

test("a fresh clone finds the memory and past sessions of another checkout of the same remote", () => {
  const main = gitRepo("memory-main", "git@github.com:Acme/API.git");
  const clone = gitRepo("memory-clone", "https://github.com/acme/api", [["config", "url./tmp/elsewhere.git.insteadOf", "https://github.com/acme/api"]]);
  const other = gitRepo("memory-other", "git@github.com:acme/web.git");
  assert.equal(remoteKey(clone)?.key, "github.com/acme/api", "the key comes from the config as written, before insteadOf");
  const home = homeWithMemory(main, []);
  mkdirSync(claudeProjectDir(other, home), { recursive: true });
  writeFileSync(join(claudeProjectDir(other, home), "o.jsonl"), JSON.stringify({ type: "user", cwd: other }) + "\n");
  assert.ok(sameRepoRoots(clone, home).includes(main));
  assert.ok(!sameRepoRoots(clone, home).includes(other), "another repo's checkout isn't this one's");
  assert.deepEqual(memoryDirs(clone, home).filter((d) => d.includes("memory-main")), [join(claudeProjectDir(main, home), "memory")]);
  assert.equal(sessionFiles(sameRepoRoots(clone, home), home).filter((f) => f.endsWith("s1.jsonl")).length, 1);
});

test("only project and reference notes tied to code that exists are offered, for the team: Claude already reads the rest", () =>
  withTrailHome(() => {
    const repo = gitRepo("memory-offer", "git@github.com:acme/api.git");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "retry.ts"), "export const MAX = 4;\n");
    const home = homeWithMemory(repo, [
      ["retry.md", "name: retry-budget\ndescription: Retries stay at 4 because the gateway times out at 30 s\ntype: project", "Keep MAX at 4 in src/retry.ts.\n\n**Why:** 4 tries × 7 s fit under the gateway's 30 s."],
      ["deploy.md", "name: deploy-owner\ndescription: Deploys run from the ops laptop on Fridays\ntype: project", "Ask ops before a deploy."],
      ["style.md", "name: short-replies\ndescription: Keep replies short\ntype: feedback", "Short replies."],
      ["me.md", "name: role\ndescription: The user is a backend engineer\ntype: user", "Backend."],
    ]);
    const got = memoryCandidates(repo, { home });
    assert.deepEqual(
      got.map((c) => [c.title, c.forTeam]),
      [["Retries stay at 4 because the gateway times out at 30 s", true]],
    );
    assert.deepEqual(got[0]!.touches, ["src/retry.ts"]);
  }));

test("a memory note CLAUDE.md already says isn't offered", () =>
  withTrailHome(() => {
    const repo = gitRepo("memory-dedupe", "git@github.com:acme/api.git");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "retry.ts"), "export const MAX = 4;\n");
    writeFileSync(join(repo, "CLAUDE.md"), "# API\n\n- Retries stay at 4 in src/retry.ts: the gateway times out after 30 seconds.\n");
    const home = homeWithMemory(repo, [["retry.md", "name: retry-budget\ndescription: Retries stay at 4 because the gateway times out\ntype: project", "Retries stay at 4 in src/retry.ts; the gateway times out."]]);
    assert.deepEqual(memoryCandidates(repo, { home }), []);
    assert.equal(alreadySaid(knownText(repo), "Name migrations by date in db/migrations", "## Decided\n- Name each migration file by its date."), false);
  }));

test("without a terminal init keeps the team's memory notes, touching their code, and offers each note once", () =>
  withTrailHome(async () => {
    const repo = gitRepo("memory-save", "git@github.com:acme/api.git");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "retry.ts"), "export const MAX = 4;\n");
    const home = homeWithMemory(repo, [
      ["retry.md", "name: retry-budget\ndescription: Retries stay at 4 because the gateway times out at 30 s\ntype: project", "Keep MAX at 4 in src/retry.ts."],
      ["style.md", "name: short-replies\ndescription: Keep replies short\ntype: feedback", "Short replies."],
    ]);
    const candidates = memoryCandidates(repo, { home });
    const { saved, cancelled } = await finishMemoryRead(repo, candidates);
    assert.equal(cancelled, false);
    assert.deepEqual(saved.map((n) => [n.title, n.scope, n.touches]), [["Retries stay at 4 because the gateway times out at 30 s", "repo", ["src/retry.ts"]]]);
    assert.match(saved[0]!.body, /_From Claude Code's memory of this repo, last updated /);
    assert.equal(readdirSync(join(repo, ".trail", "learnings")).filter((f) => f.endsWith(".md")).length, 1);
    assert.deepEqual(memoryCandidates(repo, { home, offered: offeredBefore(repo) }), [], "each note is offered once, until it changes");
  }));

test("cancelling saves no memory note and marks none offered", () =>
  withTrailHome(async () => {
    const repo = gitRepo("memory-cancel", "git@github.com:acme/api.git");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "retry.ts"), "export const MAX = 4;\n");
    const home = homeWithMemory(repo, [["retry.md", "name: retry-budget\ndescription: Retries stay at 4 because the gateway times out\ntype: project", "Keep MAX at 4 in src/retry.ts."]]);
    const { saved, cancelled } = await finishMemoryRead(repo, memoryCandidates(repo, { home }), async () => null);
    assert.equal(cancelled, true);
    assert.equal(saved.length, 0);
    assert.equal(offeredBefore(repo).size, 0);
    assert.equal(existsSync(join(repo, ".trail", "learnings")) && readdirSync(join(repo, ".trail", "learnings")).length > 0, false);
  }));

test("code anchors are files that exist and named functions the graph knows; a missing file anchors nothing", () => {
  const repo = tmpRepo("anchors");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  assert.deepEqual(codeAnchors(repo, "See src/a.ts and src/gone.ts.", ["src/gone2.ts"]), ["src/a.ts"]);
  assert.deepEqual(codeAnchors(repo, "Comments must match the code."), []);
});

test("a status write-up or a long note with no why stays in Claude's memory", () => {
  assert.equal(readsAsLearning("Keep MAX at 4 in src/retry.ts.\n\n**Why:** the gateway times out at 30 s."), true);
  assert.equal(readsAsLearning("**Status (2026-04-20)**\n\nShipped on branch `feature/x` as commit c624."), false);
  assert.equal(readsAsLearning(Array(200).fill("word").join(" ")), false);
  assert.equal(readsAsLearning(Array(200).fill("word").join(" ") + "\n\n**Why:** because."), true);
});
