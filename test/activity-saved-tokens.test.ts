/**
 * Every lookup that saved tokens is reported to the workspace, even when no
 * learning was shown: the home's running "tokens saved" counts real lookups.
 * Uses are still counted from the learnings shown, never from the savings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "saved-tokens-home-"));

const { formatAsk, formatAskWithSaved, askSavedTokens } = await import("../src/ask/ask.js");
type AskResult = import("../src/ask/ask.js").AskResult;
const { recordLookup } = await import("../src/cloud/lookup-activity.js");
const { repoPlace } = await import("../src/notes/home.js");
type Cloud = import("../src/cloud/workspace.js").Cloud;

const outbox = () => join(process.env.TRAIL_HOME!, "outbox.jsonl");
const queued = (): any[] =>
  existsSync(outbox()) ? readFileSync(outbox(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function repoAndCloud(): { repo: string; cloud: Cloud } {
  const repo = mkdtempSync(join(tmpdir(), "saved-tokens-repo-"));
  const cloud: Cloud = {
    url: "http://trail.test",
    token: "trl_x",
    user: { name: "Anirudh", email: "a@acme.test" },
    workspace: { id: "w", name: "Acme", slug: "acme", url: "http://trail.test/w/acme", invite_url: "http://trail.test/join/x" },
    repos: [repoPlace(repo).key],
    linkedAt: 0,
  };
  return { repo, cloud };
}

/** A result whose pack saves exactly `tokens` tokens against reading the file whole. */
function resultSaving(tokens: number): AskResult {
  const r: AskResult = {
    query: "retry count",
    mode: "structural",
    hits: [{ id: "n1", title: "Do", kind: "function", pointer: "client.go:L1-L9", score: 1 } as AskResult["hits"][number]],
  };
  const pack = Math.round((formatAsk(r).length - 1) / 4);
  r.saved = { files: 1, baselineChars: 4 * (tokens + pack) };
  return r;
}

function reset(): void {
  rmSync(outbox(), { force: true });
  mkdirSync(process.env.TRAIL_HOME!, { recursive: true });
}

test("a lookup that saved tokens is queued with them, though no learning was shown", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(15392);
  assert.equal(askSavedTokens(r), 15392);
  assert.match(formatAsk(r), /tokens saved ≈ 15,392 /, "the number the ask output prints");
  recordLookup(r, repo, cloud);
  const events = queued();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "search");
  assert.equal(events[0].saved_tokens, 15392);
  assert.deepEqual(events[0].shown_paths, []);
  assert.equal("query" in events[0], false, "session text stays on this machine");
  assert.equal("files" in events[0], false);
  assert.equal(events[0].file_count, 0);
});

test("no estimate and no learning shown: nothing is queued", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(15392);
  delete r.saved;
  assert.equal(askSavedTokens(r), 0);
  recordLookup(r, repo, cloud);
  assert.equal(queued().length, 0);
});

test("a learning shown without an estimate is still a use, with no saved_tokens", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(1);
  delete r.saved;
  r.notes = [{ note: { path: "/x/.trail/learnings/2026-10-09-jitter-kumar.md", title: "Jitter", author: "Kumar", date: "2026-10-09", touches: [], body: "b" }, score: 1, shared: [] }];
  recordLookup(r, repo, cloud);
  const events = queued();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].shown_paths, ["2026-10-09-jitter-kumar.md"]);
  assert.equal("query" in events[0], false, "never the query: for the prompt hook it is the person's prompt");
  assert.equal("files" in events[0], false, "a count of the files, never their paths");
  assert.equal(events[0].file_count, 1);
  assert.equal("saved_tokens" in events[0], false);
});

test("an estimate with a learning shown carries both", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(900);
  r.notes = [{ note: { path: "/x/.trail/learnings/2026-10-09-jitter-kumar.md", title: "Jitter", author: "Kumar", date: "2026-10-09", touches: [], body: "b" }, score: 1, shared: [] }];
  recordLookup(r, repo, cloud);
  const [e] = queued();
  assert.equal(e.saved_tokens, askSavedTokens(r), "the learning is in the pack, so it counts against the saving");
  assert.ok(e.saved_tokens > 0);
  assert.deepEqual(e.shown_paths, ["2026-10-09-jitter-kumar.md"]);
});

/** A result whose `saved` is counted when read, to prove a refused lookup does no work. */
function countingReads(r: AskResult): { reads: () => number } {
  let n = 0;
  const saved = r.saved;
  Object.defineProperty(r, "saved", { get: () => (n++, saved), configurable: true });
  return { reads: () => n };
}

test("not connected: nothing is computed or queued", () => {
  reset();
  const { repo } = repoAndCloud();
  const r = resultSaving(15392);
  const c = countingReads(r);
  recordLookup(r, repo, null);
  assert.equal(c.reads(), 0);
  assert.equal(queued().length, 0);
});

test("a connection made by `connect` records nothing", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(15392);
  const c = countingReads(r);
  recordLookup(r, repo, { ...cloud, via: "connect" });
  assert.equal(c.reads(), 0);
  assert.equal(queued().length, 0);
});

test("a repo outside the workspace records nothing", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(15392);
  const c = countingReads(r);
  recordLookup(r, repo, { ...cloud, repos: ["github.com/acme/other"] });
  assert.equal(c.reads(), 0);
  assert.equal(queued().length, 0);
});

test("a lookup is rendered once: the saving comes from the pack already rendered", () => {
  reset();
  const { repo, cloud } = repoAndCloud();
  const r = resultSaving(15392);
  const expected = { text: formatAsk(r), saved: askSavedTokens(r) };
  const c = countingReads(r);
  const { text, savedTokens } = formatAskWithSaved(r);
  assert.equal(text, expected.text, "same text formatAsk gives");
  assert.equal(savedTokens, expected.saved);
  const renders = c.reads();
  assert.ok(renders > 0);
  recordLookup(r, repo, cloud, savedTokens);
  assert.equal(c.reads(), renders, "recording it renders nothing more");
  assert.equal(queued()[0].saved_tokens, 15392);
});
