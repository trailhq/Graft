/**
 * What the App agrees to work on.
 *
 * Every accepted delivery costs a clone and a parse, and a bot that comments on
 * every push to a draft is the fastest way to be uninstalled — so the narrowing
 * is behaviour, not plumbing, and is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobKey, reviewJobFor } from "../src/app/events.js";
import { WorkQueue } from "../src/app/queue.js";

const delivery = (over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}): unknown => ({
  action: "opened",
  installation: { id: 99 },
  repository: { name: "Graft", owner: { login: "NanoNets" }, full_name: "NanoNets/Graft" },
  pull_request: {
    number: 180,
    draft: false,
    state: "open",
    base: { ref: "main", repo: { full_name: "NanoNets/Graft" } },
    head: { sha: "abc123", repo: { full_name: "NanoNets/Graft" } },
    ...pr,
  },
  ...over,
});

test("events: a pull request that changed its diff becomes a job", () => {
  const got = reviewJobFor("pull_request", delivery());
  assert.ok("job" in got);
  assert.deepEqual(got.job, {
    installationId: 99,
    owner: "NanoNets",
    repo: "Graft",
    number: 180,
    baseRef: "main",
    headSha: "abc123",
    fromFork: false,
  });

  // The whole point of the App: a fork PR is an ordinary job. A workflow would
  // have a read-only token here and could not comment at all.
  const fork = reviewJobFor("pull_request", delivery({}, { head: { sha: "def456", repo: { full_name: "someone/Graft" } } }));
  assert.ok("job" in fork);
  assert.equal(fork.job.fromFork, true);
  assert.equal(fork.job.owner, "NanoNets", "the comment belongs on the BASE repo, not the contributor's copy");
});

test("events: noise is skipped with a reason", () => {
  const skipped = [
    reviewJobFor("pull_request", delivery({ action: "labeled" })),
    reviewJobFor("pull_request", delivery({ action: "edited" })),
    reviewJobFor("pull_request", delivery({}, { draft: true })),
    reviewJobFor("pull_request", delivery({}, { state: "closed" })),
    reviewJobFor("issue_comment", delivery()),
    reviewJobFor("ping", {}),
    reviewJobFor("pull_request", delivery({ installation: undefined })),
  ];
  for (const s of skipped) assert.ok("skip" in s, `expected a skip, got ${JSON.stringify(s)}`);

  // …but a draft asking for eyes is exactly when the comment should appear.
  const ready = reviewJobFor("pull_request", delivery({ action: "ready_for_review" }, { draft: true }));
  assert.ok("job" in ready);
});

test("queue: a newer push replaces the queued review for the same pull request", async () => {
  const ran: string[] = [];
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((r) => (release = r));

  const q = new WorkQueue<string>(
    async (item) => {
      ran.push(item);
      if (item === "first") await blocked;
    },
    { concurrency: 1 },
  );

  q.push("pr#1", "first");
  q.push("pr#1", "second");
  q.push("pr#1", "third");
  q.push("pr#2", "other");
  release?.();
  await q.drain();

  // "second" never runs: its comment would have been overwritten by "third"
  // moments later, and the clone behind it is the expensive part.
  assert.deepEqual(ran, ["first", "third", "other"]);
});

test("queue: one bad job does not stop the queue or the process", async () => {
  const seen: unknown[] = [];
  const ran: string[] = [];
  const q = new WorkQueue<string>(
    async (item) => {
      ran.push(item);
      if (item === "boom") throw new Error("clone failed");
    },
    { concurrency: 1, onError: (err) => seen.push(err) },
  );

  q.push("a", "boom");
  q.push("b", "fine");
  await q.drain();

  assert.deepEqual(ran, ["boom", "fine"]);
  assert.equal(seen.length, 1, "the failure is reported, not swallowed");
});

test("events: the queue key is the pull request", () => {
  const got = reviewJobFor("pull_request", delivery());
  assert.ok("job" in got);
  assert.equal(jobKey(got.job), "NanoNets/Graft#180");
});
