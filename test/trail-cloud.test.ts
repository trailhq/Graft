/**
 * What `trail login` turns on: the repo's notes and skills uploaded to Trail,
 * ranked note search in `ask`, `trail team` and `trail check`. Against a local
 * stand-in for Trail that speaks the same contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLink } from "../src/brain/link.js";
import { writeNote } from "../src/notes/notes.js";
import { learn } from "../src/skills/skills.js";
import { indexFingerprint, indexPayload } from "../src/cloud/trail-api.js";
import { uploaderId } from "../src/notes/home.js";
import { homeEnv, tmpRepo } from "./helpers.js";

// Notes written here and read by the spawned CLI share one scratch ~/.trail.
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "cloud-trail-home-"));

interface Seen {
  method: string;
  path: string;
  auth: string;
  body: any;
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

/** A Trail that answers the four notes endpoints with canned replies. */
async function fakeTrail(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? "").replace(/^\/api\/public\/brains\/b-1\/trail\//, "");
    seen.push({ method: req.method ?? "", path, auth: String(req.headers.authorization ?? ""), body });
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== "Bearer tok") return reply(401, { error: "Invalid token" });
    if (req.method === "PUT" && path === "index") return reply(200, { workspace: "acme", repo: "acme/extract", notes: body.notes.length, skills: body.skills.length });
    if (req.method === "POST" && path === "search")
      return reply(200, {
        total: 412,
        notes: [
          {
            path: "notes/2026-10-03-webhook-retries-lena.md",
            title: "Webhook retries trip the OCR rate limit",
            author: "Lena",
            date: "2026-10-03",
            minutes: 20,
            tokens: 14000,
            touches: ["internal/hooks/retry.go"],
            body: "## Decided\nThree retries with jitter.\n\n## Watch out\nThe OCR service locks you out for 60s on the fourth call in a second.",
            score: 0.9,
          },
        ],
      });
    if (req.method === "GET" && path.startsWith("team"))
      return reply(200, {
        repo: "acme/extract",
        days: 7,
        people: 2,
        sessions: 5,
        new_notes: 3,
        members: [
          { name: "Priya", topics: ["bbox rotation"], notes: 2, reused: 4 },
          { name: "Mei", topics: ["csv export"], notes: 1, reused: 0 },
        ],
        overlaps: [{ kind: "parallel", text: "Arun and Mei both explored currency rounding (Tue, Thu) and neither left a decision. talk before one of you builds it" }],
        url: "https://app.trailhq.com/brains/b-1",
      });
    if (req.method === "POST" && path === "check")
      return reply(200, {
        files: body.files.length,
        notes: 412,
        skills: 3,
        findings: [
          {
            file: "internal/ocr/client.go",
            line: 3,
            verdict: "conflict",
            summary: "retries the OCR call 5 times",
            source: { kind: "note", author: "Lena", date: "2026-10-03", quote: "the OCR service locks you out for 60s on the 4th call in a second" },
          },
        ],
      });
    reply(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

/** Async on purpose: the stand-in Trail runs on this process's event loop. */
async function run(args: string[], home: string): Promise<{ status: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, GRAFT_BRAIN_URL: undefined },
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
  const status = await new Promise<number | null>((r) => child.on("close", r));
  return { status, out, err };
}

function git(d: string, args: string[]) {
  spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: d });
}

function teamRepo(): string {
  const d = tmpRepo("cloud");
  mkdirSync(join(d, "internal", "ocr"), { recursive: true });
  writeFileSync(join(d, "internal", "ocr", "client.go"), "package ocr\n\nconst retries = 3\n");
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["config", "user.name", "Sam Ortiz"]);
  git(d, ["config", "user.email", "s@example.com"]);
  writeNote(d, {
    title: "Bbox coordinates are off on rotated PDFs",
    body: "## Decided\nRotate per page.",
    author: "Priya",
    date: "2026-10-07",
    touches: ["internal/ocr/bbox.go"],
  });
  learn(d, { skill: "pdf-coords", text: "Use page.Rotation().", author: "Sam", date: "2026-10-07" });
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  return d;
}

test("login shares this machine's notes and skills with the linked Trail, as this uploader, and says what it turned on", async () => {
  const trail = await fakeTrail();
  try {
    const home = mkdtempSync(join(tmpdir(), "cloud-home-"));
    const d = teamRepo();
    writeLink(d, { brainId: "b-1", token: "tok", baseUrl: trail.url });
    const r = await run(["login", d], home);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /✓ signed in · team acme/);
    assert.match(r.err, /✓ shared 1 note and 1 skill with your team for acme\/extract/);
    const put = trail.seen.find((s) => s.method === "PUT" && s.path === "index")!;
    assert.equal(put.auth, "Bearer tok");
    assert.equal(put.body.complete, true);
    assert.equal(put.body.uploader, uploaderId(), "this machine's id, so the upload replaces only its own notes");
    assert.equal(put.body.author, "Sam");
    assert.equal(put.body.notes[0].title, "Bbox coordinates are off on rotated PDFs");
    assert.equal(put.body.notes[0].path, "notes/2026-10-07-bbox-coordinates-are-off-on-rotated-priya.md", "no path on this machine is sent");
    assert.deepEqual(put.body.notes[0].touches, ["internal/ocr/bbox.go"]);
    assert.match(put.body.notes[0].hash, /^[0-9a-f]{64}$/);
    assert.equal(put.body.skills[0].name, "pdf-coords");
    assert.equal(put.body.skills[0].where, "home");
    assert.equal(put.body.skills[0].takeaways[0].taught_by, "Sam");
    assert.match(put.body.skills[0].takeaways[0].path, /^skills\/pdf-coords\/takeaways\/2026-10-07-sam-1\.md$/);
    assert.doesNotMatch(JSON.stringify(put.body), new RegExp(process.env.TRAIL_HOME!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const status = await run(["status", d], home);
    assert.match(status.out, /^cloud {7}linked to team acme · 127\.0\.0\.1:\d+ · /m);
  } finally {
    await trail.close();
  }
});

test("a linked ask puts Trail's ranked notes first", async () => {
  const trail = await fakeTrail();
  try {
    const home = mkdtempSync(join(tmpdir(), "cloud-home-"));
    const d = teamRepo();
    writeLink(d, { brainId: "b-1", token: "tok", baseUrl: trail.url });
    await run(["build", d], home);
    const r = await run(["ask", "webhook retry backoff", d], home);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /from Lena's note · Oct 3 · Webhook retries trip the OCR rate limit/);
    assert.match(r.out, /took 20 min and ~14k tokens to work out/);
    const search = trail.seen.find((s) => s.path === "search")!;
    assert.equal(search.body.query, "webhook retry backoff");
    assert.equal(search.body.asker, "Sam");
  } finally {
    await trail.close();
  }
});

test("an unreachable Trail leaves ask with its local notes", async () => {
  const home = mkdtempSync(join(tmpdir(), "cloud-home-"));
  const d = teamRepo();
  writeLink(d, { brainId: "b-1", token: "tok", baseUrl: "http://127.0.0.1:9" });
  await run(["build", d], home);
  const r = await run(["ask", "bbox coordinates rotated", d], home);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /from Priya's note · Oct 7 · Bbox coordinates are off on rotated PDFs/);
});

test("trail team prints the week, and asks to sign in when the repo isn't linked", async () => {
  const trail = await fakeTrail();
  try {
    const home = mkdtempSync(join(tmpdir(), "cloud-home-"));
    const d = teamRepo();
    const unlinked = await run(["team", d], home);
    assert.match(unlinked.out, /sign in to turn it on: trail login/);
    writeLink(d, { brainId: "b-1", token: "tok", baseUrl: trail.url });
    const r = await run(["team", d], home);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^this week in acme\/extract$/m);
    assert.match(r.out, /^2 people · 5 sessions · 3 new notes$/m);
    assert.match(r.out, /^ {2}Priya {3}bbox rotation {3}2 notes {2}reused 4×$/m);
    assert.match(r.out, /^ {2}● Arun and Mei both explored currency rounding/m);
    assert.match(r.out, /full view: https:\/\/app\.trailhq\.com\/brains\/b-1/);
  } finally {
    await trail.close();
  }
});

test("trail check sends the branch's diff and fails on a conflict", async () => {
  const trail = await fakeTrail();
  try {
    const home = mkdtempSync(join(tmpdir(), "cloud-home-"));
    const d = teamRepo();
    git(d, ["checkout", "-qb", "fix/retries"]);
    writeFileSync(join(d, "internal", "ocr", "client.go"), "package ocr\n\nconst retries = 5\n");

    const unlinked = await run(["check", d, "--base", "main"], home);
    assert.equal(unlinked.status, 0);
    assert.match(unlinked.out, /this change touches internal\/ocr\//);

    writeLink(d, { brainId: "b-1", token: "tok", baseUrl: trail.url });
    const r = await run(["check", d, "--base", "main"], home);
    assert.equal(r.status, 1, "a conflict fails the check");
    assert.match(r.out, /^✗ internal\/ocr\/client\.go:3$/m);
    assert.match(r.out, /retries the OCR call 5 times/);
    assert.match(r.out, /Lena · Oct 3: the OCR service locks you out/);
    assert.match(r.out, /1 conflict · fix it, or say why in the PR description/);
    const sent = trail.seen.find((s) => s.path === "check")!;
    assert.deepEqual(sent.body.files, ["internal/ocr/client.go"]);
    assert.match(sent.body.diff, /-const retries = 3\n\+const retries = 5/);
  } finally {
    await trail.close();
  }
});

test("the uploader id is made once and kept", () => {
  const id = uploaderId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(uploaderId(), id);
});

test("the index fingerprint changes when a note or a takeaway does", () => {
  const d = teamRepo();
  const before = indexFingerprint(indexPayload(d));
  writeNote(d, { title: "Another", body: "## Decided\nx", author: "Mei", date: "2026-10-08" });
  const afterNote = indexFingerprint(indexPayload(d));
  assert.notEqual(before, afterNote);
  learn(d, { skill: "pdf-coords", text: "Another takeaway.", author: "Mei", date: "2026-10-08" });
  assert.notEqual(afterNote, indexFingerprint(indexPayload(d)));
});
