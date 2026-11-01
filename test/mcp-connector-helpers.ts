/** Shared by the connector tests: a fake workspace per test, `trail mcp` driven over stdio, a paired scratch home. */
import { after } from "node:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { buildGraph } from "../src/graph/build.js";
import { startFakeWorkspace, WORKSPACE_TOKEN, WORKSPACE_TOOLS, type FakeWorkspace } from "./fake-workspace-mcp.js";

const open: FakeWorkspace[] = [];
after(async () => {
  for (const w of open) await w.close();
});

export async function workspace(opts: Parameters<typeof startFakeWorkspace>[0] = {}): Promise<FakeWorkspace> {
  const w = await startFakeWorkspace(opts);
  open.push(w);
  return w;
}

interface Answer {
  msg: any;
  at: number;
}

export async function rpc(
  messages: object[],
  dir: string,
  env: NodeJS.ProcessEnv,
  expected: number,
  extra: string[] = [],
  until: (rs: any[]) => boolean = () => true,
): Promise<{ rs: any[]; at: Map<unknown, number>; sentAt: number }> {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "mcp", dir, ...extra], { stdio: ["pipe", "pipe", "pipe"], env });
  const answers: Answer[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) answers.push({ msg: JSON.parse(line), at: Date.now() });
    }
  });
  const sentAt = Date.now();
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 25000;
  const answered = () => answers.filter((a) => a.msg.id !== undefined).length;
  while ((answered() < expected || !until(answers.map((a) => a.msg))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  await once(child, "exit").catch(() => {});
  return { rs: answers.map((a) => a.msg), at: new Map(answers.map((a) => [a.msg.id, a.at])), sentAt };
}

export const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
export const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
export const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
export const CLOUD_CALL = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_context", arguments: { query: "how do we store money" } } };
export const REPO_CALL = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "trail_find_code", arguments: { query: "retryDo" } } };
export const PROMPTS = { jsonrpc: "2.0", id: 5, method: "prompts/list" };
export const PROMPT = { jsonrpc: "2.0", id: 6, method: "prompts/get", params: { name: "release-to-npm", arguments: { task: "ship 1.2.0" } } };
export const SESSION = [INIT, INITIALIZED, LIST, CLOUD_CALL, REPO_CALL, PROMPTS, PROMPT];

export async function builtRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-connector-"));
  writeFileSync(join(dir, "client.ts"), "export function retryDo(n: number): number {\n  return n;\n}\n");
  writeFileSync(join(dir, "a.ts"), 'import { retryDo } from "./client";\nexport const a = retryDo(4);\n');
  await buildGraph(dir);
  return dir;
}

export function envWith(cloud: object | null, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "mcp-connector-home-"));
  const trailHome = join(home, ".trail");
  mkdirSync(trailHome, { recursive: true });
  if (cloud) writeFileSync(join(trailHome, "cloud.json"), JSON.stringify(cloud));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: trailHome, DO_NOT_TRACK: "1", TRAIL_INVOKED_AS: "trail" };
  delete env.TRAIL_MCP_URL;
  return { ...env, ...extra };
}

export function cloudFor(url: string, token = WORKSPACE_TOKEN) {
  return {
    url,
    token,
    user: { name: "R", email: "r@acme.test" },
    workspace: { id: "w1", name: "Acme", slug: "w1", url, invite_url: url },
    repos: [],
    linkedAt: 1,
    via: "connect",
  };
}

export const CLOUD_TOOLS = WORKSPACE_TOOLS.map((t) => t.name);
export const byId = (rs: any[], id: number) => rs.find((r) => r.id === id);


/** `trail mcp` started once and driven a message at a time, for tests that answer what it says. */
export function live(dir: string, env: NodeJS.ProcessEnv, extra: string[] = []) {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "mcp", dir, ...extra], { stdio: ["pipe", "pipe", "pipe"], env });
  const got: Answer[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) got.push({ msg: JSON.parse(line), at: Date.now() });
    }
  });
  const started = Date.now();
  return {
    started,
    got,
    send: (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`),
    /** The first message `pick` accepts, and when it came; throws after `ms`. */
    async wait(pick: (m: any) => boolean, ms = 20000): Promise<Answer> {
      const end = Date.now() + ms;
      for (;;) {
        const hit = got.find((a) => pick(a.msg));
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(got.map((a) => a.msg.method ?? a.msg.id))}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async close() {
      child.kill();
      await once(child, "exit").catch(() => {});
    },
  };
}
