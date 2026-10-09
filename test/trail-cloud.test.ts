/**
 * Learnings travel by git, and the workspace sees them too.
 *
 * Two clones of one repo share a remote. What one person commits on a pushed
 * branch reaches the other's `ask` before it merges, and the files that
 * branch changes show as overlap. A connected machine uploads every learning
 * in a workspace repo's `.trail/`, branches included, and sends the uses it
 * recorded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { formatOverlap, overlapsWith, refreshBranches } from "../src/notes/branches.js";
import { listNotes, writeNote } from "../src/notes/notes.js";
import { flushActivity, learningsPayload, recordActivity, syncRepo } from "../src/cloud/workspace-sync.js";
import type { Cloud } from "../src/cloud/workspace.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "cloud-trail-home-"));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const BODY = "## Decided\n- Keep defaultRetryMax = 4: ten retries can hold one Do() call for over an hour.\n";

/**
 * A bare "GitHub" repo and two clones of it, one per person. Both clones'
 * origin reads as github.com/acme/retry (so they share a key), while fetch
 * and push go to the bare repo on disk.
 */
function team(): { anirudh: string; vedu: string } {
  const root = mkdtempSync(join(tmpdir(), "cloud-team-"));
  const bare = join(root, "retry.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "client.go"), "package retry\n\nconst defaultRetryMax = 4\n");
  writeFileSync(join(seed, "backoff.go"), "package retry\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=Seed", "-c", "user.email=s@x", "commit", "-qm", "init");
  git(seed, "push", "-q", bare, "main");
  const clone = (who: string, name: string) => {
    const d = join(root, who);
    git(root, "clone", "-q", bare, d);
    git(d, "remote", "set-url", "origin", "https://github.com/acme/retry.git");
    git(d, "config", `url.${bare}.insteadOf`, "https://github.com/acme/retry.git");
    git(d, "config", "user.name", name);
    git(d, "config", "user.email", `${who}@acme.test`);
    git(d, "remote", "set-head", "origin", "main");
    return d;
  };
  return { anirudh: clone("anirudh", "Anirudh Kumar"), vedu: clone("vedu", "Vedu S") };
}

test("a learning on a teammate's pushed branch reaches the other clone before it merges, and its files show as overlap", () => {
  const { anirudh, vedu } = team();
  git(vedu, "checkout", "-q", "-b", "vedu/jitter");
  writeFileSync(join(vedu, "client.go"), "package retry\n\nconst defaultRetryMax = 4\n\nfunc NewJitterClient() {}\n");
  writeNote(vedu, { title: "Jitter client helper", body: BODY, author: "Vedu", date: "2026-10-09", touches: ["client.go"] });
  git(vedu, "add", "-A");
  git(vedu, "commit", "-qm", "jitter client");
  git(vedu, "push", "-q", "origin", "vedu/jitter");

  assert.equal(listNotes(anirudh).length, 0, "nothing until the branches are read");
  const cache = refreshBranches(anirudh);
  assert.equal(cache.base, "origin/main");
  const b = cache.branches.find((x) => x.ref === "origin/vedu/jitter")!;
  assert.equal(b.author, "Vedu");
  assert.deepEqual(b.files.sort(), [".trail/README.md", ".trail/learnings/2026-10-09-jitter-client-helper-vedu.md", "client.go"]);
  assert.equal(b.learnings.length, 1);

  const notes = listNotes(anirudh);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.ref, "origin/vedu/jitter");
  assert.equal(notes[0]!.author, "Vedu");
  assert.equal(notes[0]!.path, "origin/vedu/jitter:.trail/learnings/2026-10-09-jitter-client-helper-vedu.md");

  const overlaps = overlapsWith(anirudh, ["client.go", "backoff.go"], "Anirudh");
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0]!.shared, ["client.go"]);
  assert.match(formatOverlap(overlaps[0]!), /^● overlap · Vedu's branch vedu\/jitter also changes client\.go \(pushed /);
  assert.deepEqual(overlapsWith(vedu, ["client.go"], "Vedu", cache), [], "your own branch isn't overlap");

  // Once it merges and Anirudh pulls, it's the working tree's copy, listed once.
  git(vedu, "checkout", "-q", "main");
  git(vedu, "merge", "-q", "vedu/jitter");
  git(vedu, "push", "-q", "origin", "main");
  git(anirudh, "pull", "-q", "origin", "main");
  refreshBranches(anirudh);
  const after = listNotes(anirudh);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.ref, undefined);
  assert.equal(after[0]!.scope, "repo");
});

test("the workspace gets every learning in the repo's .trail/, branches included, never personal ones", () => {
  const { anirudh, vedu } = team();
  writeNote(anirudh, { title: "Keep the default retry count at 4", body: BODY, author: "Anirudh", date: "2026-10-09", touches: ["client.go"] });
  writeNote(anirudh, { title: "My shell aliases", body: "## Watch out\nzsh needs interactivecomments.", author: "Anirudh", date: "2026-10-09" }, "personal");
  git(vedu, "checkout", "-q", "-b", "vedu/backoff");
  writeNote(vedu, { title: "Backoff caps", body: BODY, author: "Vedu", date: "2026-10-09", touches: ["backoff.go"] });
  git(vedu, "add", "-A");
  git(vedu, "commit", "-qm", "backoff");
  git(vedu, "push", "-q", "origin", "vedu/backoff");
  refreshBranches(anirudh);

  const payload = learningsPayload(anirudh);
  assert.deepEqual(
    payload.map((l) => [l.path, l.ref, l.author]).sort(),
    [
      [".trail/learnings/2026-10-09-backoff-caps-vedu.md", "origin/vedu/backoff", "Vedu"],
      [".trail/learnings/2026-10-09-keep-the-default-retry-count-at-anirudh.md", "", "Anirudh"],
    ],
  );
  assert.ok(payload.every((l) => /^[0-9a-f]{64}$/.test(l.hash)));
});

/** A connection, and a fake Trail that records what it's sent. */
function cloudFor(repos: string[]): { cloud: Cloud; sent: Array<{ path: string; body: any }>; fetchImpl: typeof fetch } {
  const sent: Array<{ path: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ path, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (path === "/api/cli/learnings") return json(200, { repo: body.repo.key, learnings: body.learnings.length, added: 1 });
    if (path === "/api/cli/activity") return json(200, { stored: body.events.length });
    return json(404, { error: "no route" });
  }) as typeof fetch;
  const cloud: Cloud = {
    url: "http://trail.test",
    token: "trl_x",
    user: { name: "Anirudh", email: "a@acme.test" },
    workspace: { id: "w", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/x" },
    repos,
    linkedAt: 0,
  };
  return { cloud, sent, fetchImpl };
}

test("a repo outside the workspace is never uploaded", async () => {
  const { anirudh } = team();
  writeNote(anirudh, { title: "x", body: BODY, author: "Anirudh", date: "2026-10-09" });
  const { cloud, sent, fetchImpl } = cloudFor(["github.com/acme/other"]);
  const res = await syncRepo(anirudh, cloud, { fetch: false, fetchImpl });
  assert.ok("error" in res);
  assert.equal(sent.length, 0);
});

test("uses are kept until the machine is connected, then sent once", async () => {
  const at = new Date().toISOString();
  recordActivity({ repo: "github.com/acme/retry", kind: "search", asker: "Vedu", session: "s1", query: "retry count", files: ["client.go"], shown_paths: ["a.md"], shown_authors: ["Anirudh"], at });
  recordActivity({ repo: "github.com/acme/retry", kind: "check", asker: "Vedu", session: "s1", query: "", files: ["client.go"], shown_paths: ["a.md"], shown_authors: ["Anirudh"], at });
  const outbox = join(process.env.TRAIL_HOME!, "outbox.jsonl");
  assert.equal(readFileSync(outbox, "utf8").trim().split("\n").length, 2);
  const { cloud, sent, fetchImpl } = cloudFor(["github.com/acme/retry"]);
  assert.equal(await flushActivity(cloud, fetchImpl), 2);
  assert.equal(sent[0]!.path, "/api/cli/activity");
  assert.deepEqual(sent[0]!.body.events.map((e: any) => e.kind), ["search", "check"]);
  assert.equal(existsSync(outbox), false, "sent, so gone");
  assert.equal(await flushActivity(cloud, fetchImpl), 0, "nothing twice");
});

test("a failed send keeps the uses for next time", async () => {
  recordActivity({ repo: "github.com/acme/retry", kind: "search", asker: "Vedu", session: "s2", query: "q", files: [], shown_paths: ["a.md"], shown_authors: ["Anirudh"], at: new Date().toISOString() });
  const { cloud } = cloudFor([]);
  const down = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal(await flushActivity(cloud, down), 0);
  const outbox = join(process.env.TRAIL_HOME!, "outbox.jsonl");
  assert.equal(readFileSync(outbox, "utf8").trim().split("\n").length, 1);
  mkdirSync(process.env.TRAIL_HOME!, { recursive: true });
});
