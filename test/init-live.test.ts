/**
 * Init's live feed: each learning a read checks is shown the moment it lands,
 * once, to whoever listens, however late they start listening.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveFeed, liveLine } from "../src/init/live.js";

const prs = (title: string, body = "## Decided\n- why") => ({ title, body, from: "prs" as const });
const sessions = (title: string, body = "## Decided\n- why") => ({ title, body, from: "sessions" as const });

test("a listener gets what landed before it started, then each new one as it lands", () => {
  const feed = new LiveFeed();
  feed.push(prs("Payments are stored in cents after a rounding bug"));
  const heard: string[] = [];
  feed.listen((l) => heard.push(l.title));
  feed.push(sessions("Sessions live in Postgres, not Redis"));
  assert.deepEqual(heard, ["Payments are stored in cents after a rounding bug", "Sessions live in Postgres, not Redis"]);
  assert.equal(feed.count, 2);
});

test("the same learning from the other read is shown once", () => {
  const feed = new LiveFeed();
  const heard: string[] = [];
  feed.listen((l) => heard.push(l.title));
  feed.push(prs("AI proxy rejects calls without user, trace and tags attribution"));
  feed.push(sessions("Company AI proxy refuses any call that doesn't name a user, trace and tags"));
  assert.deepEqual(heard, ["AI proxy rejects calls without user, trace and tags attribution"]);
});

test("a listener that throws doesn't stop the others", () => {
  const feed = new LiveFeed();
  const heard: string[] = [];
  feed.listen(() => {
    throw new Error("boom");
  });
  feed.listen((l) => heard.push(l.title));
  feed.push(prs("Breaking fixes wait for the next major release"));
  assert.deepEqual(heard, ["Breaking fixes wait for the next major release"]);
});

test("liveLine: one plain line naming the learning and where it came from, never an em dash", () => {
  assert.equal(liveLine(prs("Breaking fixes wait for the next major release")), '· found "Breaking fixes wait for the next major release" in pull requests');
  assert.equal(liveLine(sessions("Sign up comes first — before any other screen")), '· found "Sign up comes first, before any other screen" in your past sessions');
});
