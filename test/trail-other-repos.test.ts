/**
 * One install, every repo: after the first repo connects, the laptop's other
 * repos (the ones Claude Code ran in) go to the onboarding page by name, and
 * the ones the person picks are set up and added to the workspace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { writeNote } from "../src/notes/notes.js";
import { finishPair } from "../src/cloud/pair.js";
import { machinePayload, otherRepos } from "../src/cloud/other-repos.js";
import { readCloud } from "../src/cloud/workspace.js";
import { tmpRepo } from "./helpers.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_TEST_SERVER = "http://trail.test";
process.env.TRAIL_NO_FETCH = "1";

function git(d: string, args: string[]) {
  spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: d });
}

/** A repo with a GitHub remote and one committed learning. */
function repo(name: string): string {
  const dir = tmpRepo(name);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Priya Raman"]);
  git(dir, ["config", "user.email", "priya@acme.test"]);
  git(dir, ["remote", "add", "origin", `https://github.com/acme/${name}.git`]);
  writeNote(dir, { title: `A learning of ${name}`, body: "## Decided\nYes.", author: "Sam", date: "2026-10-07", touches: [] });
  git(dir, ["add", "-A", "-f"]);
  git(dir, ["commit", "-q", "-m", "learning"]);
  return dir;
}

/** A Claude Code project folder with `n` sessions that started in `cwd`, last touched `at`. */
function sessions(home: string, folder: string, cwd: string, n: number, at: Date): void {
  const dir = join(home, ".claude", "projects", folder);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const f = join(dir, `s${i}.jsonl`);
    writeFileSync(f, JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }) + "\n");
    utimesSync(f, at, at);
  }
}

test("other repos come from Claude Code's sessions, by remote, newest first, never this one", () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "other-trail-home-"));
  const home = mkdtempSync(join(tmpdir(), "other-home-"));
  const billing = repo("billing");
  const web = repo("web");
  const docs = repo("docs");
  const plain = tmpRepo("plain");
  mkdirSync(join(web, "src"));
  // Writing the learnings made them known to Trail just now: start from a Trail that knows none.
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "other-trail-home-"));
  sessions(home, "billing", billing, 3, new Date("2026-10-20"));
  sessions(home, "web", web, 2, new Date("2026-10-01"));
  sessions(home, "web-sub", join(web, "src"), 4, new Date("2026-10-22"));
  sessions(home, "docs", docs, 1, new Date("2026-09-01"));
  sessions(home, "plain", plain, 5, new Date("2026-10-22"));
  sessions(home, "gone", join(home, "deleted"), 5, new Date("2026-10-22"));
  // A linked folder can carry someone else's sessions: left out.
  const elsewhere = mkdtempSync(join(tmpdir(), "other-elsewhere-"));
  sessions(elsewhere, "x", docs, 9, new Date("2026-10-23"));
  symlinkSync(join(elsewhere, ".claude", "projects", "x"), join(home, ".claude", "projects", "linked"));

  const got = otherRepos("github.com/acme/billing", home);
  assert.deepEqual(got.map((r) => [r.key, r.sessions]), [["github.com/acme/web", 6], ["github.com/acme/docs", 1]]);
  assert.equal(got[0]!.checkout, web);
  assert.equal(got[0]!.name, "acme/web");
  // The page gets names and counts, never a path.
  const sent = machinePayload(got);
  assert.equal(JSON.stringify(sent).includes(tmpdir()), false);
  assert.deepEqual(Object.keys(sent[0]!).sort(), ["key", "last_used", "name", "sessions"]);
});

type Call = { method: string; path: string; body: Record<string, unknown> };

test("the picked repos are set up, added and synced, and the page hears how each went", async () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "other-trail-home-"));
  const billing = repo("billing");
  const web = repo("web");
  const docs = repo("docs");
  const others = [
    { key: "github.com/acme/web", name: "acme/web", checkout: web, lastUsed: Date.parse("2026-10-22"), sessions: 6 },
    { key: "github.com/acme/docs", name: "acme/docs", checkout: docs, lastUsed: 0, sessions: 1 },
  ];
  const ws = { slug: "acme", name: "Acme", url: "http://trail.test/w/acme" };
  const user = { name: "Priya", email: "p@acme.test" };
  let added = ["github.com/acme/billing"];
  let picksAsked = 0;
  let reviewed = false;
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c = { method: init?.method ?? "GET", path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(c);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    switch (c.path) {
      case "/api/cli/handoffs/claim":
        return json(200, { token: "trl_test", user, workspace: ws, repos: [] });
      case "/api/cli/handoffs/repos":
      case "/api/cli/handoffs/repos/status":
        return json(200, {});
      case "/api/cli/handoffs/picks":
        // Not picked yet the first time.
        return json(200, { picks: ++picksAsked < 2 ? null : ["github.com/acme/web"] });
      case "/api/cli/handoffs/progress": {
        const was = reviewed;
        reviewed = picksAsked >= 2;
        return was ? json(409, { error: "reviewed" }) : json(202, {});
      }
      case "/api/cli/repos":
        added = [...added, c.body.key as string];
        return json(200, { repos: added.map((key) => ({ key, name: key, learnings: 0, added_by: "Priya" })) });
      case "/api/cli/me":
        return json(200, { user, workspace: ws, repos: added.map((key) => ({ key, name: key, learnings: 0, added_by: "Priya" })) });
      case "/api/cli/learnings":
        return json(200, { learnings: 1, added: 1 });
    }
    return json(404, { error: "not found" });
  }) as typeof fetch;

  const inited: string[] = [];
  const outcome = await finishPair("s".repeat(32), billing, {
    fetchImpl: f,
    sleep: async () => {},
    otherRepos: () => others,
    initRepo: async (dir) => (inited.push(dir), true),
  });
  assert.equal(outcome, "uploaded");

  const sent = calls.find((c) => c.path === "/api/cli/handoffs/repos")!;
  assert.deepEqual((sent.body.repos as { key: string }[]).map((r) => r.key), ["github.com/acme/web", "github.com/acme/docs"]);
  assert.deepEqual(inited, [web], "only the picked repo is set up");
  const statuses = calls.filter((c) => c.path === "/api/cli/handoffs/repos/status").map((c) => [c.body.key, c.body.status, c.body.learnings]);
  assert.deepEqual(statuses, [["github.com/acme/web", "setting_up", 0], ["github.com/acme/web", "done", 1]]);
  const uploads = calls.filter((c) => c.path === "/api/cli/learnings").map((c) => (c.body.repo as { key: string }).key);
  assert.deepEqual(uploads.sort(), ["github.com/acme/billing", "github.com/acme/web"]);
  assert.deepEqual(readCloud()?.repos.sort(), ["github.com/acme/billing", "github.com/acme/web"]);
});

test("a repo that fails to set up says so and isn't added", async () => {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "other-trail-home-"));
  const billing = repo("billing");
  const web = repo("web");
  const calls: Call[] = [];
  let progress = 0;
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c = { method: init?.method ?? "GET", path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(c);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (c.path === "/api/cli/handoffs/claim") return json(200, { token: "t", user: { name: "P", email: "p@a.test" }, workspace: { slug: "a", name: "A", url: "x" }, repos: [] });
    if (c.path === "/api/cli/handoffs/picks") return json(200, { picks: ["github.com/acme/web"] });
    if (c.path === "/api/cli/handoffs/progress") return ++progress > 1 ? json(409, {}) : json(202, {});
    if (c.path === "/api/cli/me") return json(200, { user: { name: "P", email: "p@a.test" }, workspace: { slug: "a", name: "A", url: "x" }, repos: [{ key: "github.com/acme/billing", name: "b", learnings: 0, added_by: "P" }] });
    if (c.path === "/api/cli/learnings") return json(200, { learnings: 1, added: 0 });
    return json(200, {});
  }) as typeof fetch;
  await finishPair("s".repeat(32), billing, {
    fetchImpl: f,
    sleep: async () => {},
    otherRepos: () => [{ key: "github.com/acme/web", name: "acme/web", checkout: web, lastUsed: 0, sessions: 1 }],
    initRepo: async () => false,
  });
  const statuses = calls.filter((c) => c.path === "/api/cli/handoffs/repos/status").map((c) => c.body.status);
  assert.deepEqual(statuses, ["setting_up", "failed"]);
  assert.equal(calls.some((c) => c.path === "/api/cli/repos"), false);
});
