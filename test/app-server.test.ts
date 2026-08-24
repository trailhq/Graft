/**
 * The HTTP surface, over real sockets.
 *
 * The endpoint is public and everything behind it — cloning a repository, posting
 * as the App — happens on its say-so, so the contract asserted here is: an
 * unsigned delivery does nothing, a valid one is acknowledged fast and worked on
 * afterwards, and a page is only readable with its token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app/server.js";
import { PageStore } from "../src/app/pages.js";
import type { ReviewJob } from "../src/app/events.js";

const secret = "webhook-secret";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const delivery = JSON.stringify({
  action: "opened",
  installation: { id: 5 },
  repository: { name: "Graft", owner: { login: "NanoNets" } },
  pull_request: {
    number: 7,
    draft: false,
    state: "open",
    base: { ref: "main", repo: { full_name: "NanoNets/Graft" } },
    head: { sha: "abc", repo: { full_name: "fork/Graft" } },
  },
});

const sign = (body: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function start(): {
  url: string;
  close: () => Promise<void>;
  queued: () => number;
  pages: PageStore;
  reviewed: ReviewJob[];
  linked: string[];
  drain: () => Promise<void>;
} {
  // No default reaches the network: the reviewer is replaced, so a queued job
  // records what it was handed instead of cloning a repository.
  const reviewed: ReviewJob[] = [];
  const linked: string[] = [];
  const app = createApp(
    {
      appId: "1",
      privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      webhookSecret: secret,
      publicUrl: "http://localhost",
      log: () => {},
    },
    {
      fetch: async () => ({ ok: false, status: 500, text: async () => "no network in tests" }),
      review: async (job, deps) => {
        reviewed.push(job);
        const url = (await deps.publish?.(job, "<h1>radius</h1>")) ?? null;
        if (url) linked.push(url);
        return { commentUrl: null, areas: 1, affected: 2, viewerUrl: url };
      },
    },
  );
  app.server.listen(0);
  const port = (app.server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => app.server.close(() => r())),
    queued: () => app.queue.size,
    pages: app.pages,
    reviewed,
    linked,
    drain: () => app.queue.drain(),
  };
}

test("webhook: an unsigned or forged delivery is refused and queues nothing", async () => {
  const app = start();
  try {
    const unsigned = await fetch(`${app.url}/webhook`, { method: "POST", body: delivery, headers: { "x-github-event": "pull_request" } });
    assert.equal(unsigned.status, 401);

    const forged = await fetch(`${app.url}/webhook`, {
      method: "POST",
      body: delivery,
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign("something else") },
    });
    assert.equal(forged.status, 401);
    assert.equal(app.queued(), 0, "nothing may be queued off an unverified delivery");
  } finally {
    await app.close();
  }
});

test("webhook: a signed fork PR is acknowledged immediately and queued", async () => {
  const app = start();
  try {
    const res = await fetch(`${app.url}/webhook`, {
      method: "POST",
      body: delivery,
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(delivery) },
    });

    // 202, not 200: GitHub gives up on a delivery after ten seconds and a review
    // takes longer than that, so the answer cannot wait for the work.
    assert.equal(res.status, 202);

    await app.drain();
    assert.deepEqual(app.reviewed, [{
      installationId: 5, owner: "NanoNets", repo: "Graft", number: 7,
      baseRef: "main", headSha: "abc", fromFork: true,
    }], "a fork PR is ordinary work here — this is why the App exists");

    // The link the comment would carry has to actually serve the page.
    assert.equal(app.pages.size, 1);
    const link = app.linked[0];
    assert.match(link, new RegExp(`/p/${PageStore.idFor("NanoNets", "Graft", 7)}\\?t=[0-9a-f]{32}$`));
    const page = await fetch(link.replace("http://localhost", app.url));
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<h1>radius</h1>");
  } finally {
    await app.close();
  }
});

test("webhook: noise is acknowledged without work", async () => {
  const app = start();
  try {
    const body = JSON.stringify({ action: "labeled", installation: { id: 5 } });
    const res = await fetch(`${app.url}/webhook`, {
      method: "POST",
      body,
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) },
    });
    assert.equal(res.status, 204);
    assert.equal(app.queued(), 0);
  } finally {
    await app.close();
  }
});

test("pages: readable with its token, invisible without it", async () => {
  const app = start();
  try {
    const { id, token } = app.pages.put("NanoNets", "Graft", 7, "<h1>radius</h1>");

    const ok = await fetch(`${app.url}/p/${id}?t=${token}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "<h1>radius</h1>");
    assert.match(ok.headers.get("cache-control") ?? "", /private/, "a private repo's graph must not be cached publicly");

    // A wrong token, a truncated one and an unknown page are all 404 — a 403
    // would confirm which pull requests exist.
    for (const url of [`${app.url}/p/${id}`, `${app.url}/p/${id}?t=nope`, `${app.url}/p/other?t=${token}`]) {
      assert.equal((await fetch(url)).status, 404, url);
    }
  } finally {
    await app.close();
  }
});

test("pages: a link cannot outlive the page it points at", () => {
  let now = 1_000;
  const store = new PageStore({ secret, ttlMs: 100, now: () => now });
  const { id, token } = store.put("o", "r", 1, "<html>");

  assert.equal(store.get(id, token), "<html>");
  now += 101;
  assert.equal(store.get(id, token), null, "expired by storage time, not by anything encoded in the link");
  assert.equal(store.size, 0, "and the page itself is dropped");
});

test("healthz: reports what the process is doing", async () => {
  const app = start();
  try {
    const res = await fetch(`${app.url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, queued: 0, pages: 0 });
  } finally {
    await app.close();
  }
});
