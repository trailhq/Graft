/**
 * The App answering while a review runs.
 *
 * This is the regression that mattered most in production, so it is asserted with
 * numbers rather than shape. A review is synchronous end to end — `spawnSync` git,
 * a tree-sitter parse loop over the whole repository, a blocking graph write — and
 * running it on the server's own event loop meant one in-flight review made the
 * whole HTTP surface disappear for its entire duration: 92s to 274s per review in
 * the logs, `GET /p/<id>` timing out from outside for minutes at a stretch, and the
 * container's own 5s HEALTHCHECK failing until the queue emptied.
 *
 * So the property under test is not "the code runs". It is: with the queue full of
 * reviews that have deliberately wedged their own event loops, this server still
 * answers /healthz and still serves a page it already produced, comfortably inside
 * the healthcheck's budget. The second test is the control — the same blocking work
 * back on the server's loop, failing the same assertion — so a future change that
 * quietly moves reviews back in-process is caught here rather than in an incident.
 *
 * The reviews are `app-review-process-probe.ts`, forked through the real
 * `childReviewer`: the IPC protocol, the token hand-off, the publish round trip and
 * the process teardown are all the production ones. Only the graph build is faked,
 * because cloning a repository is not what is being measured.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PageStore } from "../src/app/pages.js";
import { childReviewer, reviewWorkerEntry } from "../src/app/review-process.js";
import { createApp, type AppSeams } from "../src/app/server.js";
import type { ReviewJob } from "../src/app/events.js";
import type { ReviewDeps, ReviewResult } from "../src/app/review.js";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "app-review-process-probe.ts");

/** The container HEALTHCHECK's own timeout — the budget everything here beats. */
const HEALTHCHECK_BUDGET_MS = 5000;
/**
 * What the assertions actually demand: a fifth of the budget, so a CI box can be
 * five times slower than a laptop and the test still means what it says.
 */
const BUDGET_MS = 1000;

/** Production's default `GRAFT_CONCURRENCY` — and one was already too many. */
const CONCURRENCY = 2;
const BURN_MS = 2000;

const secret = "webhook-secret";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** `baseRef` carries the probe's mode; see `app-review-process-probe.ts`. */
const job = (number: number, mode: string): ReviewJob => ({
  installationId: 5,
  owner: "NanoNets",
  repo: "Graft",
  number,
  baseRef: mode,
  headSha: `sha${number}`,
  fromFork: false,
});

const noNetwork: ReviewDeps["fetch"] = async () => ({
  ok: false,
  status: 500,
  text: async () => "no network in tests",
});

const deps = (): ReviewDeps => ({ token: async () => "t0ken", fetch: noNetwork });

/** What `PageStore` will have signed a given page's link with. */
const linkFor = (url: string, number: number): string => {
  const id = PageStore.idFor("NanoNets", "Graft", number);
  return `${url}/p/${id}?t=${createHmac("sha256", secret).update(id).digest("hex").slice(0, 32)}`;
};

interface Harness {
  url: string;
  app: ReturnType<typeof createApp>;
  logs: string[];
  results: ReviewResult[];
  close: () => Promise<void>;
}

/** The real App, on a real socket, with the reviewer under test behind the queue. */
function start(review: AppSeams["review"], concurrency = CONCURRENCY): Harness {
  const logs: string[] = [];
  const results: ReviewResult[] = [];
  const app = createApp(
    {
      appId: "1",
      privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      webhookSecret: secret,
      publicUrl: "http://localhost",
      concurrency,
      log: (msg) => logs.push(msg),
    },
    {
      fetch: noNetwork,
      // The token is stubbed rather than minted: `InstallationTokens` wants the
      // network and has its own tests. Everything else the queue hands a reviewer —
      // the publish callback, the log — is the App's own.
      review: async (j, d) => {
        const res = await review!(j, { ...d, token: async () => "t0ken" });
        results.push(res);
        return res;
      },
    },
  );
  app.server.listen(0);
  const port = (app.server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    app,
    logs,
    results,
    close: () => new Promise((r) => app.server.close(() => r())),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, or fail — never hang the suite on a fork that didn't. */
async function until(what: string, pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** One request, on the same 5s budget the container's healthcheck gives itself. */
async function timed(url: string): Promise<{ ms: number; status: number | "timeout" }> {
  const t0 = Date.now();
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), HEALTHCHECK_BUDGET_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    await res.text();
    return { ms: Date.now() - t0, status: res.status };
  } catch {
    return { ms: Date.now() - t0, status: "timeout" };
  } finally {
    clearTimeout(kill);
  }
}

const completed = (logs: string[]): string[] => logs.filter((l) => / changed → /.test(l));

test("reviews: every worker wedged and the server still answers /healthz and /p/<id> in milliseconds", async () => {
  const app = start(childReviewer({ entry: PROBE }));
  const loop = monitorEventLoopDelay({ resolution: 20 });
  try {
    // One review per worker — the exact shape production was running when a single
    // one of them was enough to take the published pages offline — and both halves
    // of what a review does to whatever thread it is on: `burn` pegs a core the way
    // the parse loop does, `block` holds the loop while using none, the way the
    // `spawnSync` git fetch does.
    app.app.queue.push("NanoNets/Graft#1", job(1, `burn:${BURN_MS}`));
    app.app.queue.push("NanoNets/Graft#2", job(2, `block:${BURN_MS}`));

    // Each probe publishes its page and only then wedges itself, so a page in the
    // store is the signal that the process which produced it has stopped
    // answering — and that this one had better not have.
    await until("both reviews to publish and go unresponsive", () => app.app.pages.size === CONCURRENCY);

    loop.enable();
    const seen: Array<{ ms: number; status: number | "timeout" }> = [];
    const stop = Date.now() + 1200;
    while (Date.now() < stop) {
      seen.push(await timed(`${app.url}/healthz`));
      // The symptom users actually reported: a page the App had already produced,
      // unreachable. Serve it from under the same load.
      seen.push(await timed(linkFor(app.url, 1)));
    }
    loop.disable();

    assert.ok(seen.length >= 10, `expected a steady stream of requests, got ${seen.length}`);
    assert.equal(
      seen.filter((r) => r.status === "timeout").length,
      0,
      `no request may exceed the container's ${HEALTHCHECK_BUDGET_MS}ms budget`,
    );
    assert.deepEqual([...new Set(seen.map((r) => r.status))].sort(), [200], "and every one of them is an answer");

    const worst = Math.max(...seen.map((r) => r.ms));
    assert.ok(
      worst < BUDGET_MS,
      `worst response ${worst}ms — must stay under ${BUDGET_MS}ms (the container allows ${HEALTHCHECK_BUDGET_MS}ms)`,
    );

    // The direct measurement of the bug: the longest the server's loop was ever
    // held. In-process that was the whole review; it must now be a hiccup.
    const held = loop.max / 1e6;
    assert.ok(held < BUDGET_MS, `event loop was held for ${held.toFixed(0)}ms — a review is still running on it`);

    // Responsiveness bought by dropping work would not be a fix: the reviews that
    // were accepted still finish, and still publish.
    await app.app.queue.drain();
    assert.equal(completed(app.logs).length, CONCURRENCY);
    assert.equal(app.results.filter((r) => r.viewerUrl !== null).length, CONCURRENCY);
  } finally {
    loop.disable();
    await app.close();
    await app.app.queue.drain();
  }
});

test("reviews: the same blocking work on the server's own loop is what took the pages offline", async () => {
  // The control. Deliberately the old shape — a reviewer called in-process — so the
  // numbers in the test above are a measured difference and not a hope.
  const app = start(async () => {
    const stop = Date.now() + BURN_MS;
    while (Date.now() < stop) {
      /* exactly what the parse loop does to whichever thread it is on */
    }
    return { commentUrl: null, areas: 1, affected: 2, viewerUrl: null };
  }, 1);
  const loop = monitorEventLoopDelay({ resolution: 20 });
  try {
    // The meter has to be armed by a turn of the loop before the loop stops
    // turning, or it measures a block that started before it was watching — and
    // reports a serene zero.
    loop.enable();
    await sleep(50);

    // Scheduled before the block starts and measured against when it was DUE: an
    // outside healthcheck's clock keeps running while this process's does not, and
    // that gap is what Docker saw.
    const due = Date.now() + 100;
    const probe = new Promise<number>((resolve) => {
      setTimeout(() => void timed(`${app.url}/healthz`).then(() => resolve(Date.now() - due)), 100);
    });
    app.app.queue.push("NanoNets/Graft#1", job(1, "in-process"));
    const late = await probe;
    loop.disable();

    const held = loop.max / 1e6;
    assert.ok(
      held > BURN_MS * 0.75,
      `expected the review to hold the loop for ~${BURN_MS}ms, saw ${held.toFixed(0)}ms — the control is not reproducing the bug`,
    );
    assert.ok(late > BUDGET_MS, `expected /healthz to answer ${BUDGET_MS}ms+ after it was due, saw ${late}ms`);
  } finally {
    loop.disable();
    await app.close();
    await app.app.queue.drain();
  }
});

test("reviews: a page published from the review process is served by the server that holds the store", async () => {
  const app = start(childReviewer({ entry: PROBE }));
  try {
    app.app.queue.push("NanoNets/Graft#9", job(9, "ok"));
    await app.app.queue.drain();

    assert.equal(completed(app.logs).length, 1, `expected a completed review, got ${JSON.stringify(app.logs)}`);
    // The child has no page store and no webhook secret to sign a URL with, so the
    // link in its result can only have come back across the IPC channel.
    assert.equal(app.results[0].viewerUrl, linkFor("http://localhost", 9));

    const res = await fetch(linkFor(app.url, 9));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<h1>ok</h1>");
  } finally {
    await app.close();
  }
});

test("reviews: a review process that dies without reporting is one failed review, not a dead App", async () => {
  // Before the split this was an outage: an OOM kill, or a segfault in a grammar on
  // a stranger's source, took the HTTP server down with the review. Now it is a
  // rejected promise the queue turns into a log line.
  const reviewer = childReviewer({ entry: PROBE });
  await assert.rejects(() => reviewer(job(1, "crash"), deps()), /exited with code 3 before reporting a result/);

  // A review that fails honestly still says why, in the parent's log.
  await assert.rejects(() => reviewer(job(2, "fail:no diff against main"), deps()), /no diff against main/);

  // And the process is still able to run a review afterwards.
  assert.equal((await reviewer(job(3, "ok"), deps())).areas, 1);
});

test("reviews: a wedged review is killed rather than holding a worker forever", async () => {
  const t0 = Date.now();
  const reviewer = childReviewer({ entry: PROBE, timeoutMs: 400 });
  await assert.rejects(() => reviewer(job(1, "hang"), deps()), /exceeded 400ms and was killed/);
  // The ceiling exists so the queue slot comes back: the next delivery, from some
  // other installation, must not queue behind a review that never ends.
  assert.ok(Date.now() - t0 < 20_000, "the timeout has to actually settle the promise");
});

test("reviews: the real review worker loads the whole graph stack in a forked process", async () => {
  // Everything above forks a probe, which proves the protocol and proves nothing
  // about the module a deployed App actually forks. Two things can only break here:
  // the entry path (`dist/app/review-worker.js`, or the source next door when the
  // App runs from a checkout), and loading the review stack in a child — nine
  // tree-sitter native addons imported at `graph/extract.ts`'s module scope, which
  // also constructs a `Parser` there, plus the WASM grammars behind it. Getting this
  // far is the assertion; no review runs, because a review wants a clone.
  const entry = reviewWorkerEntry();
  assert.ok(existsSync(entry), `${entry} must exist — it is what a deployed App forks`);

  const child = fork(entry, ["load-probe"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (c) => {
    stderr += String(c);
  });
  const ended = new Promise<string>((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ? `signal ${signal}` : `code ${code}`));
  });
  try {
    // A grammar that cannot load in a forked child dies during import, in well under
    // this. Still waiting for work at the end of it means the stack came up.
    const outcome = await Promise.race([ended, sleep(2500).then(() => "still waiting for work")]);
    assert.equal(outcome, "still waiting for work", `the review worker did not come up: ${stderr}`);
    assert.equal(stderr, "", "loading the review stack must be silent");
  } finally {
    child.kill("SIGKILL");
  }
});

test("reviews: repeat pushes for one pull request still collapse across the process boundary", async () => {
  // Superseding is why the queue exists and moving the work out of process must not
  // cost it: five pushes to one PR in a minute is normal, and four of those reviews
  // would only be overwritten. One running plus the newest, never five.
  const app = start(childReviewer({ entry: PROBE }), 1);
  try {
    for (let n = 0; n < 5; n++) app.app.queue.push("NanoNets/Graft#4", job(4, "ok"));
    await app.app.queue.drain();
    assert.equal(
      completed(app.logs).length,
      2,
      `expected the running review plus the newest, got ${JSON.stringify(app.logs)}`,
    );
  } finally {
    await app.close();
  }
});
