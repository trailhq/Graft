/**
 * A machine in several Trail workspaces: `cloud.json` keeps one connection per
 * workspace, the newest at the top level so an older trail still reads it, and
 * each repo's learnings and uses go to the newest workspace that has the repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCloud, cloudForRepo, readCloud, readClouds, writeCloud, type Cloud } from "../src/cloud/workspace.js";
import { flushActivity, recordActivity } from "../src/cloud/workspace-sync.js";

process.env.DO_NOT_TRACK = "1";

function freshHome(): NodeJS.ProcessEnv {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "workspaces-trail-home-"));
  return process.env;
}

function cloud(id: string, slug: string, repos: string[], linkedAt: number, url = `http://${slug}.test`): Cloud {
  return {
    url,
    token: `trl_${slug}`,
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id, name: slug[0]!.toUpperCase() + slug.slice(1), slug, url: `${url}/app/?w=${slug}`, invite_url: `${url}/join/x` },
    repos,
    linkedAt,
  };
}

const X = "github.com/acme/extract";
const Y = "github.com/client/portal";

test("each repo goes to the newest workspace that has it", () => {
  freshHome();
  writeCloud(cloud("w1", "acme", [X], 1000));
  writeCloud(cloud("w2", "client", [Y, X], 2000));
  assert.deepEqual(readClouds().map((c) => c.workspace.slug), ["client", "acme"], "newest link first");
  assert.equal(cloudForRepo(Y)?.workspace.slug, "client");
  assert.equal(cloudForRepo(X)?.workspace.slug, "client", "a repo in both goes to the newest link");
  assert.equal(cloudForRepo("github.com/acme/other"), null);
  assert.equal(readCloud()?.workspace.slug, "client");
});

test("an older trail still reads the newest connection, and the others ride along", () => {
  freshHome();
  writeCloud(cloud("w1", "acme", [X], 1000));
  writeCloud(cloud("w2", "client", [Y], 2000));
  const raw = JSON.parse(readFileSync(join(process.env.TRAIL_HOME!, "cloud.json"), "utf8"));
  assert.equal(raw.token, "trl_client", "the newest at the top level, as one connection");
  assert.equal(raw.others.length, 1);
  // What an older trail writes back: the top-level connection, spread with whatever else the file held.
  writeFileSync(join(process.env.TRAIL_HOME!, "cloud.json"), JSON.stringify({ ...raw, repos: [Y, "github.com/client/api"] }));
  assert.deepEqual(readClouds().map((c) => c.workspace.slug), ["client", "acme"]);
  assert.equal(cloudForRepo("github.com/client/api")?.workspace.slug, "client");
});

test("a file from before several workspaces reads as one connection", () => {
  freshHome();
  writeFileSync(join(process.env.TRAIL_HOME!, "cloud.json"), JSON.stringify(cloud("w1", "acme", [X], 1000)));
  assert.equal(readClouds().length, 1);
  assert.equal(cloudForRepo(X)?.workspace.slug, "acme");
});

test("the same workspace again replaces it, even at a new address", () => {
  freshHome();
  writeCloud(cloud("w1", "acme", [X], 1000));
  writeCloud(cloud("w1", "acme", [X, Y], 1000, "http://127.0.0.1:9999"));
  assert.equal(readClouds().length, 1);
  assert.equal(readCloud()?.url, "http://127.0.0.1:9999");
});

test("logout of one workspace keeps the rest; plain logout forgets all", () => {
  freshHome();
  writeCloud(cloud("w1", "acme", [X], 1000));
  writeCloud(cloud("w2", "client", [Y], 2000));
  assert.equal(clearCloud(process.env, "nope"), false);
  assert.equal(clearCloud(process.env, "client"), true);
  assert.deepEqual(readClouds().map((c) => c.workspace.slug), ["acme"]);
  assert.equal(cloudForRepo(Y), null);
  writeCloud(cloud("w2", "client", [Y], 2000));
  assert.equal(clearCloud(), true);
  assert.deepEqual(readClouds(), []);
});

test("uses go to the workspace their repo goes to, and only there", async () => {
  freshHome();
  writeCloud(cloud("w1", "acme", [X], Date.now() - 60_000));
  writeCloud(cloud("w2", "client", [Y], Date.now() - 30_000));
  const at = new Date().toISOString();
  const use = (repo: string) => ({ repo, kind: "search" as const, asker: "Priya", session: "s1", file_count: 0, shown_paths: [], shown_authors: [], saved_tokens: 900, at });
  recordActivity(use(X));
  recordActivity(use(Y));
  recordActivity(use("github.com/acme/other"));
  const got: Array<{ url: string; auth: string; repos: string[] }> = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    got.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), repos: body.events.map((e: { repo: string }) => e.repo) });
    return new Response(JSON.stringify({ stored: body.events.length }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  assert.equal(await flushActivity(readClouds(), fake), 2, "a repo no workspace has isn't recorded at all");
  const byUrl = Object.fromEntries(got.map((g) => [new URL(g.url).host, g]));
  assert.deepEqual(byUrl["acme.test"]?.repos, [X]);
  assert.equal(byUrl["acme.test"]?.auth, "Bearer trl_acme");
  assert.deepEqual(byUrl["client.test"]?.repos, [Y]);
  assert.equal(byUrl["client.test"]?.auth, "Bearer trl_client");
});
