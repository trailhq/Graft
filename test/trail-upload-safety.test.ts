/**
 * Nothing private leaves the machine when it's connected to a Trail workspace.
 *
 * What a person types never goes into the activity outbox or up to Trail: a
 * use of the learnings is counts and the names of the learnings shown. Only
 * learnings committed at HEAD go up, never an uncommitted edit or an untracked
 * file. The files queued for upload are readable by their owner only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { headLearnings } from "../src/cloud/head-learnings.js";
import { flushActivity, learningsPayload, maybeSyncInBackground, recordActivity, syncIsDue, syncRepo } from "../src/cloud/workspace-sync.js";
import { connectUrl } from "../src/cloud/nudge.js";
import { clearCloud, isError, trailUrl, writeCloud, type Cloud } from "../src/cloud/workspace.js";
import { drain, enqueue, queuePath, requeue } from "../src/telemetry/queue.js";
import { cacheDir } from "../src/util/state.js";
import { tmpRepo } from "./helpers.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_NO_FETCH = "1";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "upload-safety-home-"));

/** What a person might type: words that must never be queued or sent. */
const TYPED = "fix the bbox rotated pdf bug for customer Globexsynthetic, token sk-test-SYNTHETIC0001";
const TYPED_MARKERS = ["Globexsynthetic", "sk-test-SYNTHETIC0001", "fix the bbox"];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A connection, and a fake Trail that records what it's sent. */
function cloudFor(repos: string[]): { cloud: Cloud; sent: Array<{ path: string; raw: string; body: any }>; fetchImpl: typeof fetch } {
  const sent: Array<{ path: string; raw: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const raw = init.body ? String(init.body) : "";
    const body = raw ? JSON.parse(raw) : undefined;
    sent.push({ path, raw, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (path === "/api/cli/learnings") return json(200, { repo: body.repo.key, learnings: body.learnings.length, added: 0 });
    if (path === "/api/cli/activity") return json(200, { stored: body.events.length });
    return json(404, { error: "no route" });
  }) as typeof fetch;
  const cloud: Cloud = {
    url: "http://trail.test",
    token: "trl_x",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/x" },
    repos,
    linkedAt: Date.now() - 60_000,
  };
  return { cloud, sent, fetchImpl };
}

const outbox = (home = process.env.TRAIL_HOME!) => join(home, "outbox.jsonl");

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The fields a queued or sent use may carry, and nothing else. */
const ACTIVITY_FIELDS = ["asker", "at", "file_count", "kind", "repo", "session", "shown_authors", "shown_paths"];

// --- what a use of the learnings carries ---

test("a search that showed a learning queues counts and the learning's name, never what was typed or the files", () => {
  const home = mkdtempSync(join(tmpdir(), "upload-safety-e2e-"));
  const trailHome = join(home, ".trail");
  const d = tmpRepo("upload-safety-ask");
  mkdirSync(join(d, "internal", "ocr"), { recursive: true });
  writeFileSync(join(d, "internal", "ocr", "bbox.go"), "package ocr\n\nfunc NormalizeBox(x float64, rotate int) float64 {\n\treturn x\n}\n");
  mkdirSync(join(d, ".trail", "learnings"), { recursive: true });
  const name = "2026-10-07-bbox-rotated-pdf-priya.md";
  writeFileSync(
    join(d, ".trail", "learnings", name),
    "---\ntitle: Bbox coordinates are off on rotated PDFs\nauthor: Priya\ndate: 2026-10-07\ntouches:\n  - internal/ocr/bbox.go\n---\n## Decided\nRotate each box by its page's /Rotate before scaling.\n",
  );
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "Priya Raman");
  git(d, "config", "user.email", "priya@acme.test");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  git(d, "remote", "add", "origin", "https://github.com/acme/extract.git");

  const env = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: trailHome, DO_NOT_TRACK: "1", TRAIL_NO_FETCH: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, CLAUDE_CODE_SESSION_ID: "s-upload-1" };
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], { encoding: "utf8", env, timeout: 120_000 });
  const built = cli(["build", d]);
  assert.equal(built.status, 0, built.stderr);
  writeCloud(cloudFor(["github.com/acme/extract"]).cloud, { ...process.env, TRAIL_HOME: trailHome });

  // The prompt hook runs exactly this: the person's prompt as the query.
  const ask = cli(["ask", TYPED, d, "--json", "-n", "3"]);
  assert.equal(ask.status, 0, ask.stderr);
  assert.ok(JSON.parse(ask.stdout).notes?.length >= 1, "the learning was shown, so a use is recorded");

  const lines = readFileSync(outbox(trailHome), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]!);
  assert.deepEqual(Object.keys(e).sort(), ACTIVITY_FIELDS);
  assert.deepEqual(e.shown_paths, [name]);
  assert.equal(e.kind, "search");
  assert.equal(typeof e.file_count, "number");
  for (const f of filesUnder(home)) {
    const text = readFileSync(f, "utf8");
    for (const m of TYPED_MARKERS) assert.ok(!text.includes(m), `${f} holds what was typed (${m})`);
  }
});

test("a use handed over with a query and file paths is queued without them", () => {
  const { cloud } = cloudFor(["github.com/acme/retry"]);
  recordActivity(
    {
      repo: "github.com/acme/retry",
      kind: "search",
      asker: "Kumar",
      session: "s1",
      query: TYPED,
      files: ["internal/billing/globexsynthetic.go"],
      shown_paths: ["a.md"],
      shown_authors: ["Maya"],
      at: new Date().toISOString(),
    } as never,
    cloud,
  );
  const text = readFileSync(outbox(), "utf8");
  for (const m of [...TYPED_MARKERS, "globexsynthetic.go"]) assert.ok(!text.includes(m), m);
  const e = JSON.parse(text.trim());
  assert.deepEqual(Object.keys(e).sort(), ACTIVITY_FIELDS);
  assert.equal(e.file_count, 1);
  assert.deepEqual(e.shown_paths, ["a.md"]);
  clearCloud();
  writeFileSync(outbox(), "");
});

test("what an older trail queued goes up without what was typed or the files, and is kept that way when the send fails", async () => {
  const { cloud, sent, fetchImpl } = cloudFor(["github.com/acme/retry"]);
  const old = { repo: "github.com/acme/retry", kind: "search", asker: "Kumar", session: "s1", query: TYPED, files: ["internal/billing/globexsynthetic.go"], shown_paths: ["a.md"], shown_authors: ["Maya"], at: new Date().toISOString() };
  const down = (async () => {
    throw new Error("offline");
  }) as typeof fetch;

  writeFileSync(outbox(), `${JSON.stringify(old)}\n`);
  assert.equal(await flushActivity(cloud, down), 0);
  const kept = readFileSync(outbox(), "utf8");
  for (const m of [...TYPED_MARKERS, "globexsynthetic.go"]) assert.ok(!kept.includes(m), `put back with ${m}`);

  writeFileSync(outbox(), `${JSON.stringify(old)}\n`);
  assert.equal(await flushActivity(cloud, fetchImpl), 1);
  const req = sent.find((s) => s.path === "/api/cli/activity")!;
  for (const m of [...TYPED_MARKERS, "globexsynthetic.go"]) assert.ok(!req.raw.includes(m), `sent ${m}`);
  assert.deepEqual(Object.keys(req.body.events[0]).sort(), ACTIVITY_FIELDS);
  assert.equal(req.body.events[0].file_count, 1);
  // No upload from here carried a.md, so the workspace never got it: its name stays too.
  assert.deepEqual(req.body.events[0].shown_paths, []);
  assert.deepEqual(req.body.events[0].shown_authors, []);
});

test("not connected, an outbox an older trail left is deleted: nothing in it could ever be sent", () => {
  clearCloud();
  const d = tmpRepo("upload-safety-off");
  git(d, "init", "-q");
  writeFileSync(outbox(), `${JSON.stringify({ repo: "github.com/acme/retry", kind: "search", query: TYPED, at: new Date().toISOString() })}\n`);
  assert.equal(maybeSyncInBackground(d), false);
  assert.equal(existsSync(outbox()), false);
});

// --- which learnings go up ---

const learning = (title: string, body: string) => `---\ntitle: ${title}\nauthor: Priya\ndate: 2026-10-07\ntouches: []\n---\n${body}\n`;

test("only learnings committed at HEAD go up: never an uncommitted edit, a staged or untracked file, or a link out of the repo", async () => {
  const d = tmpRepo("upload-safety-head");
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "Priya Raman");
  git(d, "config", "user.email", "priya@acme.test");
  git(d, "remote", "add", "origin", "https://github.com/acme/billing.git");
  const dir = join(d, ".trail", "learnings");
  mkdirSync(dir, { recursive: true });
  // A personal learning outside the repo, and a committed link pointing at it.
  const outside = mkdtempSync(join(tmpdir(), "upload-safety-outside-"));
  writeFileSync(join(outside, "mine.md"), learning("My own setup", "## Watch out\nPersonal only, synthetic."));
  symlinkSync(join(outside, "mine.md"), join(dir, "2026-10-07-linked-priya.md"));
  writeFileSync(join(dir, "2026-10-07-retries-priya.md"), learning("Retries trip the rate limit", "## Decided\nThree retries."));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "learnings");

  // After the commit: an edit, a staged new file, an untracked one.
  writeFileSync(join(dir, "2026-10-07-retries-priya.md"), learning("Retries trip the rate limit", "## Decided\nThree retries. Draft: ask Globexsynthetic first."));
  writeFileSync(join(dir, "2026-10-08-staged-priya.md"), learning("Staged, not committed", "## Decided\nStaged draft."));
  git(d, "add", join(".trail", "learnings", "2026-10-08-staged-priya.md"));
  writeFileSync(join(dir, "2026-10-08-untracked-priya.md"), learning("Never added", "## Decided\nUntracked draft."));

  const payload = learningsPayload(d)!;
  assert.deepEqual(payload.map((l) => l.path), [".trail/learnings/2026-10-07-retries-priya.md"]);
  assert.equal(payload[0]!.ref, "");
  assert.equal(payload[0]!.body.trim(), "## Decided\nThree retries.", "the committed text, not the edit");

  const { cloud, sent, fetchImpl } = cloudFor(["github.com/acme/billing"]);
  const res = await syncRepo(d, cloud, { fetch: false, fetchImpl });
  assert.ok(!("error" in res));
  const up = sent.find((s) => s.path === "/api/cli/learnings")!;
  assert.equal(up.body.learnings.length, 1);
  for (const m of ["Globexsynthetic", "Staged draft", "Untracked draft", "Personal only"]) assert.ok(!up.raw.includes(m), m);
});

/** A GitHub-backed repo with `learnings` committed, as `.trail/learnings/<name>`. */
function committedRepo(tag: string, key: string, learnings: Record<string, string>): string {
  const d = tmpRepo(tag);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.name", "Priya Raman");
  git(d, "config", "user.email", "priya@acme.test");
  git(d, "remote", "add", "origin", `https://${key}.git`);
  writeFileSync(join(d, "README.md"), "synthetic\n");
  mkdirSync(join(d, ".trail", "learnings"), { recursive: true });
  for (const [name, text] of Object.entries(learnings)) writeFileSync(join(d, ".trail", "learnings", name), text);
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  return d;
}

test("a repo with no commits has no HEAD to read: nothing goes up, not even an empty set", () => {
  const d = tmpRepo("upload-safety-unborn");
  git(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, ".trail", "learnings"), { recursive: true });
  writeFileSync(join(d, ".trail", "learnings", "2026-10-07-x-priya.md"), learning("x", "## Decided\ny"));
  assert.equal(headLearnings(d), null);
  assert.equal(learningsPayload(d), null);
});

test("a commit with no learnings at HEAD answers with none, an untracked one in the tree included", () => {
  const d = committedRepo("upload-safety-none", "github.com/acme/none", {});
  writeFileSync(join(d, ".trail", "learnings", "2026-10-07-x-priya.md"), learning("x", "## Decided\ny"));
  assert.deepEqual(headLearnings(d), []);
  assert.deepEqual(learningsPayload(d), []);
});

test("when git can't read HEAD, nothing goes up and the sync counts as failed, never as 'no learnings'", async () => {
  const key = "github.com/acme/ledger";
  const d = committedRepo("upload-safety-broken", key, { "2026-10-07-retries-priya.md": learning("Retries trip the rate limit", "## Decided\nThree retries.") });
  const { cloud, sent, fetchImpl } = cloudFor([key]);
  assert.ok(!isError(await syncRepo(d, cloud, { fetch: false, fetchImpl })));

  // A second learning, then the commit's tree goes missing, as after a disk error or a clone cut short.
  writeFileSync(join(d, ".trail", "learnings", "2026-10-08-jitter-priya.md"), learning("Jitter the retries", "## Decided\nAdd jitter."));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "more");
  const tree = git(d, "rev-parse", "HEAD^{tree}").trim();
  rmSync(join(d, ".git", "objects", tree.slice(0, 2), tree.slice(2)), { force: true });

  assert.equal(headLearnings(d), null);
  assert.equal(learningsPayload(d), null);
  const res = await syncRepo(d, cloud, { fetch: false, fetchImpl });
  assert.ok(isError(res), "a failure, not a sync of nothing");
  assert.equal(sent.filter((s) => s.path === "/api/cli/learnings").length, 1, "no second upload");
  const state = JSON.parse(readFileSync(join(cacheDir(d), "trail-workspace-sync.json"), "utf8"));
  assert.equal(typeof state.failedAt, "number", "recorded as failed");
  assert.equal(state.learnings, 1, "what the workspace has stays as the last good sync left it");
  assert.equal(syncIsDue(d, Date.now() + 60 * 60 * 1000), false, "and no sync is due while git can't answer");
});

test("without git on the PATH, HEAD can't be read: null, not none", () => {
  const d = committedRepo("upload-safety-nogit", "github.com/acme/nogit", { "2026-10-07-retries-priya.md": learning("Retries", "## Decided\nThree.") });
  const saved = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "upload-safety-empty-path-"));
  try {
    assert.equal(headLearnings(d), null);
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(headLearnings(d)!.length, 1, "and with git back, the learning");
});

// --- who can read what waits to go up ---

const modeOf = (p: string) => statSync(p).mode & 0o777;
const OWNER_ONLY = { skip: process.platform === "win32" ? "Windows has no owner-only mode bits; the profile folder's ACL guards it" : false };

test("the activity outbox is readable by its owner only, and so is its folder, even where an older trail left them open", OWNER_ONLY, async () => {
  const saved = process.env.TRAIL_HOME;
  const home = join(mkdtempSync(join(tmpdir(), "upload-safety-modes-")), ".trail");
  process.env.TRAIL_HOME = home;
  try {
    const { cloud } = cloudFor(["github.com/acme/retry"]);
    writeCloud(cloud);
    assert.equal(modeOf(join(home, "cloud.json")), 0o600);
    assert.equal(modeOf(home), 0o700, "the folder connecting made");
    const use = { repo: "github.com/acme/retry", kind: "search" as const, asker: "Kumar", session: "s1", file_count: 1, shown_paths: ["a.md"], shown_authors: ["Maya"], at: new Date().toISOString() };
    recordActivity(use, cloud);
    assert.equal(modeOf(outbox(home)), 0o600, "a new outbox");

    // What an older trail made: world-readable.
    chmodSync(home, 0o755);
    chmodSync(outbox(home), 0o644);
    recordActivity(use, cloud);
    assert.equal(modeOf(outbox(home)), 0o600, "an older outbox");
    assert.equal(modeOf(home), 0o700, "an older folder");

    // Put back after a failed send: a fresh file, still owner-only.
    const down = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    assert.equal(await flushActivity(cloud, down), 0);
    assert.equal(modeOf(outbox(home)), 0o600, "put back");
  } finally {
    clearCloud();
    process.env.TRAIL_HOME = saved;
  }
});

test("the usage-stats queue in ~/.graft is readable by its owner only, and so is its folder", OWNER_ONLY, () => {
  const home = mkdtempSync(join(tmpdir(), "upload-safety-graft-"));
  enqueue({ event: "query", n: 1 }, home);
  assert.equal(modeOf(queuePath(home)), 0o600);
  assert.equal(modeOf(join(home, ".graft")), 0o700);

  chmodSync(join(home, ".graft"), 0o755);
  chmodSync(queuePath(home), 0o644);
  enqueue({ event: "query", n: 2 }, home);
  assert.equal(modeOf(queuePath(home)), 0o600, "an older queue");
  assert.equal(modeOf(join(home, ".graft")), 0o700, "an older folder");

  drain(home);
  requeue([{ event: "query", n: 3 }], home);
  assert.equal(modeOf(queuePath(home)), 0o600, "put back after a failed send");
});

// --- where it goes ---

test("no address in the shell moves where sign-in and learnings go: not an old GRAFT_BRAIN_URL, not TRAIL_URL", () => {
  const shell = { GRAFT_BRAIN_URL: "https://old-brain.example.test/", TRAIL_URL: "https://elsewhere.example.com/" };
  assert.equal(trailUrl(shell), "https://team.trailhq.com");
  assert.match(connectUrl("s".repeat(32), trailUrl(shell)), /^https:\/\/team\.trailhq\.com\/connect\?state=/);
});

test("the test-only TRAIL_TEST_SERVER reaches a stand-in on this machine or a .test host, nowhere else", () => {
  assert.equal(trailUrl({ TRAIL_TEST_SERVER: "http://localhost:8080/" }), "http://localhost:8080");
  assert.equal(trailUrl({ TRAIL_TEST_SERVER: "http://127.0.0.1:9" }), "http://127.0.0.1:9");
  assert.equal(trailUrl({ TRAIL_TEST_SERVER: "http://[::1]:9" }), "http://[::1]:9");
  assert.equal(trailUrl({ TRAIL_TEST_SERVER: "http://trail.test" }), "http://trail.test");
  for (const elsewhere of ["https://trail.acme.example.com", "https://localhost.example.com", "http://test.example.com", "file:///tmp/x", "not a url"]) {
    assert.equal(trailUrl({ TRAIL_TEST_SERVER: elsewhere }), "https://team.trailhq.com", elsewhere);
  }
});
