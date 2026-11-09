/**
 * Where a live session's state lives: ~/.trail/sessions/<id>.json, in a folder
 * only its owner can open, under a name a hook payload can't steer elsewhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensurePrivateDir, sessionStatePath, writePrivateJson } from "../src/trace/state.js";
import { appendPrivateLine, writePrivate } from "../src/util/private-fs.js";
import { readNewEvents } from "../src/trace/claude.js";
import { jsonl, typed } from "./trace-fixtures.js";

function withTrailHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "trace-state-"));
  const before = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = home;
  try {
    return fn(home);
  } finally {
    if (before === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = before;
  }
}

test("a session's state file is ~/.trail/sessions/<id>.json", () => {
  withTrailHome((home) => {
    const id = "5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
    assert.equal(sessionStatePath(id), join(home, "sessions", `${id}.json`));
  });
});

test("the sessions folder is private, and tightened when it was looser", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  withTrailHome((home) => {
    const dir = join(home, "sessions");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const p = sessionStatePath("s1");
    assert.equal(statSync(dirname(p)).mode & 0o777, 0o700);
    writePrivateJson(p, { trace: { offset: 0 } });
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });
});

test("an id that isn't a plain name can't point outside the folder", () => {
  withTrailHome((home) => {
    const dir = join(home, "sessions");
    for (const id of ["../../etc/passwd", "..", ".hidden", "a/b", "a\\b", "", "x".repeat(300), "id with spaces"]) {
      const p = sessionStatePath(id);
      assert.equal(dirname(p), dir, id);
      assert.match(basename(p), /^h-[0-9a-f]{16}\.json$/, id);
    }
    assert.notEqual(sessionStatePath("../a"), sessionStatePath("../b"));
  });
});

test("the transcript cursor can live in the session's own state file", () => {
  withTrailHome((home) => {
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, jsonl([typed("hello")]));
    const state = sessionStatePath("s2");
    assert.equal(readNewEvents(transcript, state).length, 1);
    assert.equal(readNewEvents(transcript, state).length, 0);
  });
});

test("a cursor written into a folder Trail didn't make leaves that folder's mode alone", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const shared = mkdtempSync(join(tmpdir(), "trace-shared-"));
  chmodSync(shared, 0o755);
  const transcript = join(shared, "t.jsonl");
  writeFileSync(transcript, jsonl([typed("hello")]));
  const cursor = join(shared, "cursor.json");
  assert.equal(readNewEvents(transcript, cursor).length, 1);
  assert.equal(statSync(shared).mode & 0o777, 0o755, "the caller's folder is not tightened");
  assert.equal(statSync(cursor).mode & 0o777, 0o600, "the cursor itself is private");
  // A folder that had to be made is made private.
  const fresh = join(shared, "made", "here", "cursor.json");
  readNewEvents(transcript, fresh);
  assert.equal(statSync(dirname(fresh)).mode & 0o777, 0o700);
});

/** A folder outside Trail's home at 0755, and a link to it inside the home. */
function linkedFolder(t: { after(fn: () => void): void }): { home: string; target: string; link: string } {
  const home = mkdtempSync(join(tmpdir(), "trace-link-home-"));
  const target = mkdtempSync(join(tmpdir(), "trace-link-target-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  chmodSync(target, 0o755);
  const link = join(home, "sessions");
  symlinkSync(target, link);
  return { home, target, link };
}

test("a link given as a private folder is left alone: its target keeps its mode", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const { target, link } = linkedFolder(t);
  ensurePrivateDir(link);
  assert.equal(statSync(target).mode & 0o777, 0o755, "the folder the link points to is not tightened");
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
});

test("a real folder at 0755 is tightened to 0700", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const dir = mkdtempSync(join(tmpdir(), "trace-real-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o755);
  ensurePrivateDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("writing a private file or line into a linked folder does not tighten the link's target", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const { target, link } = linkedFolder(t);
  appendPrivateLine(join(link, "a.jsonl"), '{"n":1}');
  writePrivate(join(link, "b.json"), "{}");
  writePrivateJson(join(link, "c.json"), { n: 1 });
  assert.equal(statSync(target).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(target, "a.jsonl"), "utf8"), '{"n":1}\n');
});
