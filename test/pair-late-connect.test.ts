/**
 * A paired setup whose person connects late: the page closed and reopened, or
 * a join approved after the hour `_trail-pair` waits. Trail keeps the connect
 * link for a day, so the next trail command picks the wait up again, and once
 * the laptop connects the command after says so, once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { writeNote } from "../src/notes/notes.js";
import { finishPair } from "../src/cloud/pair.js";
import { cloudLines, LINK_TTL_MS, pendingPair, rememberPair, resumePair } from "../src/cloud/nudge.js";
import { tmpRepo } from "./helpers.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_TEST_SERVER = "http://trail.test";
process.env.TRAIL_NO_FETCH = "1";

const STATE = "s".repeat(32);

function freshHome(): void {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "pair-late-home-"));
}

function repo(): string {
  const dir = tmpRepo("pair-late");
  const git = (args: string[]) => spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Priya Raman"]);
  git(["config", "user.email", "priya@acme.test"]);
  git(["remote", "add", "origin", "https://github.com/acme/billing.git"]);
  writeNote(dir, { title: "Keep payment retries at 4", body: "## Decided\nFour retries.", author: "Sam", date: "2026-10-07", touches: [] });
  git(["add", "-A", "-f"]);
  git(["commit", "-q", "-m", "learning"]);
  return dir;
}

type Call = { path: string };

/** A Trail where nobody connects: the claim stays pending. */
const nobodyYet = (calls: Call[]) =>
  (async (url: string | URL) => {
    calls.push({ path: new URL(String(url)).pathname });
    return new Response(JSON.stringify({ pending: true }), { status: 202 });
  }) as typeof fetch;

/** A Trail where the person has connected and the review is in (the automatic keep). */
const connected = (calls: Call[]) =>
  (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path });
    const ws = { slug: "acme", name: "Acme", url: "http://trail.test/w/acme" };
    if (path === "/api/cli/handoffs/claim") return new Response(JSON.stringify({ token: "trl_test", user: { name: "Priya", email: "p@acme.test" }, workspace: ws, repos: [] }), { status: 200 });
    if (path === "/api/cli/handoffs/progress") return new Response(JSON.stringify({ error: "the learnings were already reviewed" }), { status: 409 });
    if (path === "/api/cli/me") return new Response(JSON.stringify({ user: { name: "Priya", email: "p@acme.test" }, workspace: ws, repos: [{ key: "github.com/acme/billing", name: "acme/billing", learnings: 1, added_by: "Priya" }] }), { status: 200 });
    if (path === "/api/cli/learnings") return new Response(JSON.stringify({ learnings: 1, added: 0 }), { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;

/** A clock the waits move on: each sleep is a minute. */
function clock(start: number) {
  let t = start;
  return { now: () => t, sleep: async () => void (t += 60_000) };
}

test("a paired wait that runs out keeps the connect, and the next trail command waits again", async () => {
  freshHome();
  const dir = repo();
  const t0 = Date.UTC(2026, 9, 26, 9);
  rememberPair(STATE, dir, "http://trail.test", undefined, t0);
  const c = clock(t0);
  const calls: Call[] = [];
  const outcome = await finishPair(STATE, dir, { fetchImpl: nobodyYet(calls), sleep: c.sleep, now: c.now, waitMs: 5 * 60_000, otherRepos: () => [] });
  assert.equal(outcome, "timed_out");
  assert.equal(pendingPair()?.state, STATE, "still waiting to be connected");

  // Two hours later the person opens the link; their agent runs a trail command.
  const started: string[][] = [];
  resumePair(undefined, t0 + 2 * 3600_000, (args) => void started.push(args));
  assert.deepEqual(started, [[STATE, dir, "http://trail.test"]]);
  // A second command while that wait runs starts no other.
  resumePair(undefined, t0 + 2 * 3600_000 + 60_000, (args) => void started.push(args));
  assert.equal(started.length, 1);
});

test("the wait the first run started isn't doubled by commands during its hour", () => {
  freshHome();
  const t0 = Date.UTC(2026, 9, 26, 9);
  rememberPair(STATE, repo(), "http://trail.test", undefined, t0);
  const started: string[][] = [];
  resumePair(undefined, t0 + 30 * 60_000, (args) => void started.push(args));
  assert.deepEqual(started, []);
});

test("a wait that died early (the laptop restarted) is picked up by the next command, within the hour", () => {
  freshHome();
  const dir = repo();
  const t0 = Date.UTC(2026, 9, 26, 9);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
  rememberPair(STATE, dir, "http://trail.test", undefined, t0, gone);
  const started: string[][] = [];
  resumePair(undefined, t0 + 10 * 60_000, (args) => (started.push(args), process.pid));
  assert.deepEqual(started, [[STATE, dir, "http://trail.test"]]);
  // The new wait is alive (this process stands in for it): no second one.
  resumePair(undefined, t0 + 11 * 60_000, (args) => (started.push(args), process.pid));
  assert.equal(started.length, 1);
});

test("a late connect uploads the repo, and the next command says once that the laptop is connected", async () => {
  freshHome();
  const dir = repo();
  const t0 = Date.UTC(2026, 9, 26, 9);
  rememberPair(STATE, dir, "http://trail.test", undefined, t0);
  const calls: Call[] = [];
  const c = clock(t0 + 2 * 3600_000);
  const outcome = await finishPair(STATE, dir, { fetchImpl: connected(calls), sleep: c.sleep, now: c.now, otherRepos: () => [], resumed: true });
  assert.equal(outcome, "uploaded");
  assert.ok(calls.some((x) => x.path === "/api/cli/learnings"), "the repo's learnings went up");
  assert.equal(pendingPair(), null, "nothing left to wait for");

  const said = cloudLines(dir, { command: "note", agent: true }).join("\n");
  assert.match(said, /connected to workspace Acme/);
  assert.doesNotMatch(cloudLines(dir, { command: "note", agent: true }).join("\n"), /connected to workspace/, "once");
});

test("a run connected while setup was still on screen says nothing later: the page showed it", async () => {
  freshHome();
  const dir = repo();
  rememberPair(STATE, dir, "http://trail.test");
  const outcome = await finishPair(STATE, dir, { fetchImpl: connected([]), sleep: async () => {}, otherRepos: () => [] });
  assert.equal(outcome, "uploaded");
  assert.doesNotMatch(cloudLines(dir, { command: "note", agent: true }).join("\n"), /connected to workspace/);
});

test("a link Trail no longer takes, or one past a day, is forgotten", async () => {
  freshHome();
  const dir = repo();
  rememberPair(STATE, dir, "http://trail.test");
  const gone = (async () => new Response(JSON.stringify({ error: "gone" }), { status: 410 })) as unknown as typeof fetch;
  assert.equal(await finishPair(STATE, dir, { fetchImpl: gone, sleep: async () => {}, otherRepos: () => [] }), "expired");
  assert.equal(pendingPair(), null);

  const t0 = Date.UTC(2026, 9, 26, 9);
  rememberPair(STATE, dir, "http://trail.test", undefined, t0);
  const started: string[][] = [];
  resumePair(undefined, t0 + LINK_TTL_MS + 1, (args) => void started.push(args));
  assert.deepEqual(started, []);
  assert.equal(pendingPair(), null);
});
