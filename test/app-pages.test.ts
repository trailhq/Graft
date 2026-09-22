/**
 * Pages that outlive the process holding them.
 *
 * The link in a pull request comment carries a token derived from the page id, so
 * it verifies forever and a restart turns it into a silent 404 — which is how 29
 * comments on one repository ended up pointing at nothing. What is asserted here
 * is therefore the restart itself: a second `PageStore` over the same directory
 * has to answer the links the first one handed out, on the same terms (token,
 * TTL, cap), and none of the ways a filesystem can misbehave may reach the
 * caller as an exception.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageStore } from "../src/app/pages.js";

const secret = "webhook-secret";

/** Each test gets its own directory, and the store's is a level below it. */
function scratch(): { root: string; dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "graft-pages-"));
  // Nested and absent: the App's volume is mounted empty, so the store has to
  // make its own directory rather than expect one.
  return { root, dir: join(root, "pages"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("pages: a restart serves the links the previous process handed out", () => {
  const { dir, cleanup } = scratch();
  try {
    const first = new PageStore({ secret, dir });
    const { id, token } = first.put("NanoNets", "assign", 42, "<h1>radius</h1>");

    const restarted = new PageStore({ secret, dir });
    assert.equal(restarted.size, 1, "the page was on disk, not only in the process that made it");
    assert.equal(restarted.get(id, token), "<h1>radius</h1>", "the comment's link still works");
    // The token is the only credential and it is derived, so the restart must not
    // have widened access either.
    assert.equal(restarted.get(id, "nope"), null);
    assert.equal(restarted.get(id, undefined), null);
    assert.equal(restarted.get("NanoNets__assign__43", token), null);
  } finally {
    cleanup();
  }
});

test("pages: TTL is still counted from when the page was stored", () => {
  const { dir, cleanup } = scratch();
  try {
    let now = 1_000;
    const first = new PageStore({ secret, dir, ttlMs: 100, now: () => now });
    const { id, token } = first.put("o", "r", 1, "<html>");

    now += 50;
    assert.equal(new PageStore({ secret, dir, ttlMs: 100, now: () => now }).get(id, token), "<html>");

    now += 51;
    const late = new PageStore({ secret, dir, ttlMs: 100, now: () => now });
    assert.equal(late.get(id, token), null, "expired while the process was down, not on a fresh clock");
    assert.equal(late.size, 0);
    assert.deepEqual(readdirSync(dir), [], "and a restart is when an expired page finally leaves the disk");
  } finally {
    cleanup();
  }
});

test("pages: expiry during a run takes the file with it", () => {
  const { dir, cleanup } = scratch();
  try {
    let now = 1_000;
    const store = new PageStore({ secret, dir, ttlMs: 100, now: () => now });
    const { id, token } = store.put("o", "r", 1, "<html>");
    now += 101;

    assert.equal(store.get(id, token), null);
    assert.equal(store.size, 0);
    assert.deepEqual(readdirSync(dir), [], "otherwise the next restart would resurrect it");
  } finally {
    cleanup();
  }
});

test("pages: maxPages bounds the directory too, oldest out first", () => {
  const { dir, cleanup } = scratch();
  try {
    let now = 1_000;
    const store = new PageStore({ secret, dir, maxPages: 2, now: () => now++ });
    const first = store.put("o", "r", 1, "<one>");
    store.put("o", "r", 2, "<two>");
    store.put("o", "r", 3, "<three>");

    assert.equal(store.size, 2);
    assert.deepEqual(readdirSync(dir).sort(), ["o__r__2.json", "o__r__3.json"]);
    assert.equal(store.get(first.id, first.token), null);

    const restarted = new PageStore({ secret, dir, maxPages: 2, now: () => now });
    assert.equal(restarted.size, 2, "a restart cannot re-import what eviction already dropped");
  } finally {
    cleanup();
  }
});

test("pages: a re-review replaces the page rather than accumulating files", () => {
  const { dir, cleanup } = scratch();
  try {
    let now = 1_000;
    const store = new PageStore({ secret, dir, now: () => now });
    store.put("o", "r", 7, "<first pass>");
    now += 5_000;
    const { id, token } = store.put("o", "r", 7, "<second pass>");

    assert.deepEqual(readdirSync(dir), ["o__r__7.json"], "one file per PR, and no temp files left over");
    const restarted = new PageStore({ secret, dir, now: () => now });
    assert.equal(restarted.get(id, token), "<second pass>");
  } finally {
    cleanup();
  }
});

test("pages: an unreadable file is a missing page, not a thrown request", () => {
  const { dir, cleanup } = scratch();
  try {
    // Made by the store so the directory exists, then vandalised the three ways
    // a real one goes wrong: truncated JSON, valid JSON of the wrong shape, and
    // bytes that are not JSON at all.
    const store = new PageStore({ secret, dir });
    const { id, token } = store.put("o", "r", 1, "<html>");
    writeFileSync(join(dir, "o__r__1.json"), '{"html":"<htm');
    writeFileSync(join(dir, "o__r__2.json"), '{"html":42}');
    writeFileSync(join(dir, "o__r__3.json"), "not json");
    writeFileSync(join(dir, "o__r__4.json.tmp"), JSON.stringify({ html: "<half>", storedMs: 1 }));

    const restarted = new PageStore({ secret, dir });
    assert.equal(restarted.size, 0, "nothing there was a page, including the interrupted write");
    assert.equal(restarted.get(id, token), null, "the caller sees a 404's worth of nothing");
  } finally {
    cleanup();
  }
});

test("pages: a directory it cannot use degrades to memory instead of failing reviews", () => {
  const { root, cleanup } = scratch();
  // A file where the directory should be — a bad mount, in one line.
  const wrong = join(root, "not-a-directory");
  writeFileSync(wrong, "");
  const warned: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    const store = new PageStore({ secret, dir: wrong });
    const { id, token } = store.put("o", "r", 9, "<served anyway>");

    assert.equal(store.get(id, token), "<served anyway>", "the review still published a working link");
    assert.equal(store.size, 1);
    // Loud enough to find in the logs, because the operator has lost durability
    // and nothing else in the system will say so.
    assert.match(warned.join("\n"), /will not survive a restart/);
    assert.match(warned.join("\n"), /could not write o__r__9/);
  } finally {
    console.warn = real;
    cleanup();
  }
});

test("pages: a file deleted underneath the process does not break the live page", () => {
  const { dir, cleanup } = scratch();
  try {
    const store = new PageStore({ secret, dir });
    const { id, token } = store.put("o", "r", 1, "<html>");
    unlinkSync(join(dir, "o__r__1.json"));

    assert.equal(store.get(id, token), "<html>", "the page is in memory; the disk is a mirror of it");
    // Storing it again has to put the file back, and dropping it again has to
    // survive the file being gone a second time.
    store.put("o", "r", 1, "<html>");
    assert.equal(JSON.parse(readFileSync(join(dir, "o__r__1.json"), "utf8")).html, "<html>");
    unlinkSync(join(dir, "o__r__1.json"));
    assert.equal(new PageStore({ secret, dir }).size, 0);
  } finally {
    cleanup();
  }
});

test("pages: no directory means the old in-memory behaviour, untouched", () => {
  const { dir, cleanup } = scratch();
  try {
    const store = new PageStore({ secret });
    const { id, token } = store.put("o", "r", 1, "<html>");

    assert.equal(store.get(id, token), "<html>");
    assert.equal(store.size, 1);
    assert.equal(new PageStore({ secret }).get(id, token), null, "a restart loses them, as it always did");
    // Nothing was created anywhere: the directory in this test was never given
    // to a store, and the store must not have invented one.
    assert.throws(() => readdirSync(dir));
  } finally {
    cleanup();
  }
});
