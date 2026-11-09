/**
 * Claude Code through Trail-Code gets what the Claude.ai connector gets: once
 * this machine is paired with a Trail workspace, the local `trail mcp` server
 * passes the workspace's own MCP server (`<trail>/mcp`) through. Its tools are
 * listed beside the repo tools, its prompts and instructions come along, and
 * every call carries the CLI token as a bearer. A slow or unreachable
 * workspace never holds the repo tools up, and never crashes the server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceConnector, connectorUrl } from "../src/mcp/connector.js";
import { WORKSPACE_INSTRUCTIONS, WORKSPACE_TOKEN } from "./fake-workspace-mcp.js";
import {
  builtRepo, byId, cloudFor, CLOUD_CALL, CLOUD_TOOLS, envWith, INIT, INITIALIZED, LIST, PROMPTS, REPO_CALL, rpc, SESSION, workspace,
} from "./mcp-connector-helpers.js";

test("lists the workspace's tools beside the repo tools, and passes calls through", async () => {
  const ws = await workspace();
  const dir = await builtRepo();
  const { rs } = await rpc(SESSION, dir, envWith(cloudFor(ws.url)), 6);
  const tools = byId(rs, 2).result.tools;
  const names = tools.map((t: any) => t.name);
  assert.ok(names.includes("trail_find_code"), names.join(","));
  for (const n of CLOUD_TOOLS) assert.ok(names.includes(n), `${n} in ${names.join(",")}`);
  // The workspace's own definitions, whole: schema (always_follow) and annotations too.
  const save = tools.find((t: any) => t.name === "save_learning");
  assert.equal(save.inputSchema.properties.always_follow.type, "boolean");
  assert.deepEqual(tools.find((t: any) => t.name === "get_context").annotations, { readOnlyHint: true });
  for (const old of ["list_brains", "search_rules", "get_rules"]) assert.ok(!names.includes(old), `${old} is gone`);

  const call = byId(rs, 3).result;
  assert.notEqual(call.isError, true);
  assert.equal(call.content[0].text, "Store money in integer cents. (asked: how do we store money)");
  assert.deepEqual(call.structuredContent, { learnings: [{ title: "Store money in integer cents", always_follow: true }] });
  const local = byId(rs, 4).result;
  assert.equal(local.isError, false);
  assert.match(local.content[0].text, /retryDo/);

  const calls = ws.log.filter((l) => l.body?.method === "tools/call");
  assert.deepEqual(calls.map((l) => l.body.params), [{ name: "get_context", arguments: { query: "how do we store money" } }], "the repo tool never goes to the workspace");
});

test("passes the workspace's prompts through", async () => {
  const ws = await workspace();
  const dir = await builtRepo();
  const { rs } = await rpc(SESSION, dir, envWith(cloudFor(ws.url)), 6);
  assert.ok(byId(rs, 1).result.capabilities.prompts, "prompts are offered");
  const prompts = byId(rs, 5).result.prompts;
  assert.deepEqual(
    prompts.map((p: any) => [p.name, p.title, p.arguments[0].name]),
    [["release-to-npm", "Release to npm", "task"]],
  );
  const got = byId(rs, 6).result;
  assert.equal(got.description, "Release to npm");
  assert.equal(got.messages[0].role, "user");
  assert.match(got.messages[0].content.text, /"Release to npm" skill[\s\S]*The job: ship 1\.2\.0$/);
  const asked = ws.log.find((l) => l.body?.method === "prompts/get");
  assert.deepEqual(asked?.body.params, { name: "release-to-npm", arguments: { task: "ship 1.2.0" } });
});

test("passes the workspace's instructions on, after the repo's own", async () => {
  const ws = await workspace();
  const dir = await builtRepo();
  const { rs } = await rpc([INIT, INITIALIZED, LIST], dir, envWith(cloudFor(ws.url)), 2);
  const text: string = byId(rs, 1).result.instructions;
  assert.match(text, /indexed by trail/);
  assert.ok(text.includes(WORKSPACE_INSTRUCTIONS), text);
  assert.ok(text.indexOf("indexed by trail") < text.indexOf(WORKSPACE_INSTRUCTIONS), "local first, the workspace's appended");
  assert.equal(ws.log.filter((l) => l.body?.method === "initialize").length, 1, "initialized once");
});

test("sends the CLI token as a bearer, to <trail>/mcp, or to TRAIL_MCP_URL when set", async () => {
  const ws = await workspace();
  const dir = await builtRepo();
  await rpc(SESSION, dir, envWith(cloudFor(ws.url)), 6);
  assert.ok(ws.log.length >= 5);
  assert.ok(ws.log.every((l) => l.auth === `Bearer ${WORKSPACE_TOKEN}`), "every request carries the token");
  assert.ok(ws.log.every((l) => l.path === "/mcp"));
  assert.equal(ws.log[0]!.body.method, "initialize");

  // TRAIL_MCP_URL wins over the paired Trail's address.
  const other = await workspace();
  const { rs } = await rpc([INIT, INITIALIZED, LIST], dir, envWith(cloudFor("http://127.0.0.1:9"), { TRAIL_MCP_URL: `${other.url}/mcp` }), 2);
  const names = byId(rs, 2).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("get_context"), names.join(","));
  assert.ok(other.log.every((l) => l.auth === `Bearer ${WORKSPACE_TOKEN}`));
  assert.equal(connectorUrl({ url: "https://team.trailhq.com/" } as any, {}), "https://team.trailhq.com/mcp");
  assert.equal(connectorUrl({ url: "https://team.trailhq.com" } as any, { TRAIL_MCP_URL: "http://localhost:8790/mcp/" }), "http://localhost:8790/mcp");
});

test("trail tools fail soft when the workspace is unreachable: the repo tools list and answer", async () => {
  const dir = await builtRepo();
  const { rs } = await rpc(SESSION, dir, envWith(cloudFor("http://127.0.0.1:9")), 6);
  assert.ok(byId(rs, 1).result.instructions.includes("indexed by trail"));
  const names = byId(rs, 2).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("trail_find_code"));
  for (const n of CLOUD_TOOLS) assert.ok(!names.includes(n), `${n} isn't listed when the workspace can't say it has it`);
  const call = byId(rs, 3).result;
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /couldn't reach your Trail workspace · the repo tools still work/);
  assert.equal(byId(rs, 4).result.isError, false);
  assert.deepEqual(byId(rs, 5).result.prompts, []);
  assert.ok(byId(rs, 6).error, "a prompt it can't fetch is a JSON-RPC error, not a crash");
});

test("a slow workspace holds the tool list up for 4 s at most", async () => {
  const ws = await workspace({ delayMs: 12000 });
  const dir = await builtRepo();
  const { rs, at, sentAt } = await rpc([INIT, INITIALIZED, LIST, REPO_CALL], dir, envWith(cloudFor(ws.url)), 3);
  const names = byId(rs, 2).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("trail_find_code"));
  // initialize and tools/list each wait 4 s at most; tsx start-up is on top.
  assert.ok(at.get(2)! - sentAt < 11000, `tools/list took ${at.get(2)! - sentAt} ms`);
  assert.equal(byId(rs, 4).result.isError, false);
});

test("a workspace that answers after the 4 s wait gets its tools listed then: trail says the list changed", async () => {
  // initialize, then tools/list, each 2.5 s: past the 4 s wait, well within the request timeout.
  const ws = await workspace({ delayMs: 2500 });
  const dir = await builtRepo();
  const { rs } = await rpc([INIT, INITIALIZED, LIST], dir, envWith(cloudFor(ws.url)), 2, [], (r) => r.some((m) => m.method === "notifications/tools/list_changed"));
  assert.ok(byId(rs, 2).result.tools.some((t: any) => t.name === "trail_find_code"));
  assert.ok(rs.some((m) => m.method === "notifications/tools/list_changed"), JSON.stringify(rs.map((m) => m.method ?? m.id)));
});

test("a token the workspace won't take says how to reconnect", async () => {
  const ws = await workspace();
  const dir = await builtRepo();
  const { rs } = await rpc([INIT, INITIALIZED, LIST, CLOUD_CALL], dir, envWith(cloudFor(ws.url, "trl_revoked")), 3);
  const call = byId(rs, 3).result;
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /refused this laptop's sign-in; run `trail logout`, then `trail login`/);
});

test("not paired: the repo tools as before, nothing of the workspace's", async () => {
  const dir = await builtRepo();
  const { rs } = await rpc([INIT, INITIALIZED, LIST, CLOUD_CALL], dir, envWith(null), 3);
  const init = byId(rs, 1).result;
  assert.deepEqual(init.capabilities, { tools: {} });
  assert.doesNotMatch(init.instructions, /Trail workspace|memory/);
  const names = byId(rs, 2).result.tools.map((t: any) => t.name);
  assert.ok(names.includes("trail_find_code"));
  for (const n of [...CLOUD_TOOLS, "list_brains", "search_rules", "get_rules"]) assert.ok(!names.includes(n));
  assert.equal(byId(rs, 3).result.isError, true);
});

test("not signed in, in a repo whose team uses Trail: one line offers the sign-in to that workspace", async () => {
  const dir = await builtRepo();
  mkdirSync(join(dir, ".trail"), { recursive: true });
  writeFileSync(join(dir, ".trail", "workspace.json"), JSON.stringify({ trail: "https://team.trailhq.com", workspace: "acme", name: "Acme" }));
  const { rs } = await rpc([INIT, INITIALIZED, LIST], dir, envWith(null), 2);
  assert.match(byId(rs, 1).result.instructions, /workspace Acme .* run `(trail|npx -y @trailhq\/trail-code@latest) login --workspace acme`/);
  // Another Trail named in the repo is never where a laptop is sent to sign in.
  writeFileSync(join(dir, ".trail", "workspace.json"), JSON.stringify({ trail: "https://trail.evil.example", workspace: "acme", name: "Acme" }));
  const other = await rpc([INIT, INITIALIZED, LIST], dir, envWith(null), 2);
  assert.doesNotMatch(byId(other.rs, 1).result.instructions, /login --workspace/);
});

test("trail mcp --brains, Claude Code's user-level entry: the workspace's tools, prompts and instructions, nothing of the repo's", async () => {
  const ws = await workspace();
  const dir = await builtRepo();
  const { rs } = await rpc(SESSION, dir, envWith(cloudFor(ws.url)), 6, ["--brains"]);
  assert.deepEqual(byId(rs, 2).result.tools.map((t: any) => t.name).sort(), [...CLOUD_TOOLS].sort());
  assert.equal(byId(rs, 1).result.instructions, WORKSPACE_INSTRUCTIONS);
  assert.notEqual(byId(rs, 3).result.isError, true);
  const repoTool = byId(rs, 4).result;
  assert.equal(repoTool.isError, true);
  assert.match(repoTool.content[0].text, /workspace's tools only/);
  assert.equal(byId(rs, 5).result.prompts.length, 1);

  const off = await rpc([INIT, INITIALIZED, LIST], dir, envWith(null), 2, ["--brains"]);
  assert.deepEqual(byId(off.rs, 2).result.tools, []);
  assert.match(byId(off.rs, 1).result.instructions, /isn't signed in to Trail.*Run `trail login`/);
});

test("a workspace that keeps sessions: the id goes back on every request, and a dropped session starts again once", async () => {
  const ws = await workspace({ mode: "session" });
  const env = envWith(cloudFor(ws.url));
  const c = new WorkspaceConnector({ env, version: "9.9.9" });
  assert.equal(c.connected(), true);
  assert.equal(await c.instructions(), WORKSPACE_INSTRUCTIONS);
  const tools = await c.listTools();
  assert.deepEqual(tools?.map((t) => t.name), CLOUD_TOOLS);
  const after = ws.log.filter((l) => l.body?.method !== "initialize");
  assert.ok(after.length >= 2 && after.every((l) => l.session === "s1"), JSON.stringify(after.map((l) => l.session)));
  assert.ok(after.every((l) => l.protocol === "2025-06-18"));
  assert.equal(ws.log[0]!.body.params.clientInfo.version, "9.9.9");

  ws.dropSessions();
  const r = await c.callTool("save_learning", { title: "Store money in integer cents", body: "Floats drift.", always_follow: true });
  assert.notEqual(r.isError, true);
  assert.equal(r.content[0]!.text, 'saved "Store money in integer cents" as always follow');
  assert.equal(ws.log.filter((l) => l.body?.method === "initialize").length, 2, "one fresh start");
  assert.equal(ws.log.at(-1)!.session, "s2");
});

test("the connector never throws, paired or not", async () => {
  const off = new WorkspaceConnector({ env: envWith(null) });
  assert.equal(off.connected(), false);
  assert.equal(await off.listTools(), null);
  assert.equal(await off.instructions(), "");
  const r = await off.callTool("get_context", { query: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /isn't signed in to Trail/);
  const p = await off.getPrompt("release-to-npm", {});
  assert.ok("error" in p);
});
