/**
 * The connector's edges, from PR #691's review: a broken pairing file never
 * crashes the server, the token goes only to the paired Trail, a slow
 * workspace's late listing is kept and served, one shared wait from boot,
 * a short back-off after a failure, and the small answers (a refused token,
 * an empty prompt, a repo tool's old name).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceConnector, connectorUrl } from "../src/mcp/connector.js";
import { readCloud } from "../src/cloud/workspace.js";
import { WORKSPACE_TOKEN } from "./fake-workspace-mcp.js";
import { builtRepo, byId, cloudFor, CLOUD_TOOLS, envWith, INIT, INITIALIZED, LIST, live, rpc, workspace } from "./mcp-connector-helpers.js";

test("a cloud.json with no url: not paired, and trail mcp (repo or --brains) starts and answers", async () => {
  const broken = { token: "trl_x", workspace: { slug: "w" } };
  const env = envWith(broken);
  assert.equal(readCloud(env), null, "a pairing with no address is no pairing");
  const c = new WorkspaceConnector({ env });
  assert.doesNotThrow(() => c.warm());
  assert.equal(c.connected(), false);

  const dir = await builtRepo();
  const repo = await rpc([INIT, INITIALIZED, LIST], dir, envWith(broken), 2);
  assert.ok(byId(repo.rs, 2).result.tools.some((t: any) => t.name === "trail_find_code"), JSON.stringify(repo.rs));
  const brains = await rpc([INIT, INITIALIZED, LIST], dir, envWith(broken), 2, ["--brains"]);
  assert.deepEqual(byId(brains.rs, 2).result.tools, []);

  // A url that isn't a string or an address is the same.
  for (const url of [42, "not a url"]) {
    const e = envWith({ ...cloudFor("http://127.0.0.1:9"), url });
    assert.doesNotThrow(() => new WorkspaceConnector({ env: e }).warm());
    const r = await rpc([INIT, INITIALIZED, LIST], dir, e, 2);
    assert.ok(byId(r.rs, 2).result.tools.some((t: any) => t.name === "trail_find_code"), String(url));
  }
});

test("TRAIL_MCP_URL moves the connector only to the paired Trail's origin or a host on this machine", () => {
  const cloud = { url: "https://team.trailhq.com" };
  assert.equal(connectorUrl(cloud, { TRAIL_MCP_URL: "https://evil.example/mcp" }), "https://team.trailhq.com/mcp", "another host never gets the token");
  assert.equal(connectorUrl(cloud, { TRAIL_MCP_URL: "https://team.trailhq.com/v2/mcp" }), "https://team.trailhq.com/v2/mcp");
  assert.equal(connectorUrl(cloud, { TRAIL_MCP_URL: "http://localhost:8790/mcp" }), "http://localhost:8790/mcp");
  assert.equal(connectorUrl(cloud, { TRAIL_MCP_URL: "http://127.0.0.1:8790/mcp" }), "http://127.0.0.1:8790/mcp");
  assert.equal(connectorUrl(cloud, { TRAIL_MCP_URL: "http://trail.test/mcp" }), "http://trail.test/mcp");
  assert.equal(connectorUrl(cloud, { TRAIL_MCP_URL: "not a url" }), "https://team.trailhq.com/mcp");
  assert.equal(connectorUrl({ url: "nope" }, {}), null);
});

test("a redirect is never followed: the token stays with the paired Trail", async () => {
  const elsewhere = await workspace();
  const moved = await workspace({ redirectTo: elsewhere.url });
  const c = new WorkspaceConnector({ env: envWith(cloudFor(moved.url)) });
  assert.equal(await c.listTools(), null);
  const r = await c.callTool("get_context", { query: "x" });
  assert.equal(r.isError, true);
  assert.ok(moved.log.length >= 1);
  assert.equal(elsewhere.log.length, 0, "nothing reached the other host");
});

test("a workspace slower than the wait: its late listing is kept, and a re-list after list_changed has it at once", async () => {
  const ws = await workspace({ delayMs: 4500 });
  const dir = await builtRepo();
  const s = live(dir, envWith(cloudFor(ws.url)));
  try {
    s.send(INIT);
    s.send(INITIALIZED);
    s.send(LIST);
    const first = await s.wait((m) => m.id === 2);
    assert.ok(!first.msg.result.tools.some((t: any) => t.name === "get_context"), "not in time for the first list");
    await s.wait((m) => m.method === "notifications/tools/list_changed", 25000);
    const asked = Date.now();
    s.send({ ...LIST, id: 7 });
    const again = await s.wait((m) => m.id === 7);
    for (const n of CLOUD_TOOLS) assert.ok(again.msg.result.tools.some((t: any) => t.name === n), n);
    assert.ok(again.at - asked < 1500, `the re-list answered from what was kept (${again.at - asked} ms)`);
  } finally {
    await s.close();
  }
});

test("one wait from boot: with a workspace that never answers, initialize and tools/list are both answered within about 4 s", async () => {
  const ws = await workspace({ delayMs: 60000 });
  const dir = await builtRepo();
  const s = live(dir, envWith(cloudFor(ws.url)));
  try {
    s.send(INIT);
    s.send(INITIALIZED);
    const init = await s.wait((m) => m.id === 1);
    s.send(LIST);
    const list = await s.wait((m) => m.id === 2);
    assert.ok(list.msg.result.tools.some((t: any) => t.name === "trail_find_code"));
    assert.ok(list.at - init.at < 1000, `tools/list waited ${list.at - init.at} ms after initialize`);
    // From start includes booting node with tsx, which Windows CI takes 7 to 9 s over on its own.
    assert.ok(list.at - s.started < (process.platform === "win32" ? 15000 : 7000), `${list.at - s.started} ms from start`);
  } finally {
    await s.close();
  }
});

test("after a failed start, calls fail fast for a while instead of starting again each time", async () => {
  const ws = await workspace({ delayMs: 3000 });
  const c = new WorkspaceConnector({ env: envWith(cloudFor(ws.url)), timeoutMs: 200 });
  assert.equal(await c.instructions(), "");
  const t = Date.now();
  const r = await c.callTool("get_context", { query: "x" });
  assert.equal(r.isError, true);
  assert.ok(Date.now() - t < 100, `answered in ${Date.now() - t} ms`);
  assert.equal(ws.log.filter((l) => l.body?.method === "initialize").length, 1, "no second initialize inside the back-off");
});

test("a refused token says so at start, not that the workspace didn't answer", async () => {
  const ws = await workspace();
  const dir = await builtRepo();
  const { rs } = await rpc([INIT, INITIALIZED, LIST], dir, envWith(cloudFor(ws.url, "trl_revoked")), 2);
  const text: string = byId(rs, 1).result.instructions;
  assert.doesNotMatch(text, /didn't answer/);
  assert.match(text, /refused this machine's token|older version/);
});

test("small answers: an empty prompt result is {}, and trail_ask (a repo tool's old name) stays local when paired", async () => {
  const ws = await workspace();
  const dir = await builtRepo();
  const { rs } = await rpc(
    [
      INIT,
      INITIALIZED,
      { jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "empty", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "trail_ask", arguments: { query: "retryDo" } } },
    ],
    dir,
    envWith(cloudFor(ws.url)),
    3,
  );
  assert.deepEqual(byId(rs, 2).result, {});
  assert.equal(byId(rs, 3).result.isError, false);
  assert.match(byId(rs, 3).result.content[0].text, /retryDo/);
  assert.ok(!ws.log.some((l) => l.body?.method === "tools/call"), "the old repo name never went to the workspace");
  assert.ok(ws.log.every((l) => l.auth === `Bearer ${WORKSPACE_TOKEN}`));
});

test("a reply with neither result nor error is not taken as an answer", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-review-"));
  mkdirSync(join(home, ".trail"), { recursive: true });
  writeFileSync(join(home, ".trail", "cloud.json"), JSON.stringify(cloudFor("http://127.0.0.1:1")));
  const fetchImpl = (async (_u: unknown, init: any) => {
    const body = JSON.parse(init.body);
    const msg = body.method === "initialize" ? { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } } : { jsonrpc: "2.0", id: body.id };
    return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const c = new WorkspaceConnector({ env: { TRAIL_HOME: join(home, ".trail") }, fetchImpl });
  assert.equal(await c.listTools(), null);
  const r = await c.callTool("get_context", {});
  assert.equal(r.isError, true);
});
