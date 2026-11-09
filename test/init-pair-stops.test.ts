/**
 * `trail init --pair` that stops never leaves Trail's page waiting: before it
 * told Trail about the run (home folder, not a git repo, agent ids it doesn't
 * know) it says why against the pair code; after (a crash part way) it says so
 * against the run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";

const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|OPENCODE.*|GEMINI_CLI|CURSOR_.*|ANTIGRAVITY_AGENT|COPILOT_.*|AI_AGENT|AGENT|TERM_PROGRAM)$/;
const CODE = "X4GM5OQU4NIA65ZR";

type Call = { path: string; body: Record<string, unknown> };

async function standInTrail(): Promise<{ url: string; calls: Call[]; close: () => void }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      const reply = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.url === "/api/cli/handoffs") return reply(201, { url: "http://127.0.0.1/connect?state=s" });
      if (req.url === "/api/cli/handoffs/progress" || req.url === "/api/cli/pairs/fail") return reply(202, {});
      return reply(410, { error: "gone" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, close: () => server.close() };
}

async function init(dir: string, home: string, server: string, args: string[]): Promise<{ code: number | null; err: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!AGENT_VARS.test(k)) env[k] = v;
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "init", dir, "--no-build", ...args, "--pair", CODE, "--server", server], {
    env: { ...env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), TRAIL_INVOKED_AS: "trail", DO_NOT_TRACK: "1", GRAFT_MCP_NPX: "1", TRAIL_NO_LOOK_BACK: "1", TRAIL_NO_FETCH: "1", CLAUDECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const code = await new Promise<number | null>((ok) => child.on("close", ok));
  return { code, err };
}

const failed = (calls: Call[]) => calls.filter((c) => c.path === "/api/cli/pairs/fail").map((c) => c.body);

test("run from the home folder: init refuses, and Trail's page hears why", async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("pair-stop-home");
    const r = await init(home, home, trail.url, ["--agents", "auto"]);
    assert.equal(r.code, 1, r.err);
    assert.deepEqual(failed(trail.calls), [{ pair: CODE, reason: "home_folder" }]);
    assert.ok(!trail.calls.some((c) => c.path === "/api/cli/handoffs"), "no run registered");
  } finally {
    trail.close();
  }
});

test("a folder that isn't a git repo: --pair refuses before writing anything, and the page hears why", async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("pair-stop-nogit-home");
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    writeFileSync(join(dir, "notes.txt"), "hi\n");
    const r = await init(dir, home, trail.url, ["--agents", "auto"]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /isn't a git repo/);
    assert.deepEqual(failed(trail.calls), [{ pair: CODE, reason: "not_git" }]);
    assert.ok(!trail.calls.some((c) => c.path === "/api/cli/handoffs"), "no run registered");
    assert.deepEqual(spawnSync("ls", ["-A", dir], { encoding: "utf8" }).stdout.trim().split("\n"), ["notes.txt"], "nothing written");
  } finally {
    trail.close();
  }
});

test("an agent id init doesn't know: the page hears the command was changed", async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("pair-stop-agents-home");
    const repo = tmpRepo("pair-stop-agents");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const r = await init(repo, home, trail.url, ["--agents", "claudecode"]);
    assert.equal(r.code, 1, r.err);
    assert.deepEqual(failed(trail.calls), [{ pair: CODE, reason: "bad_agents" }]);
  } finally {
    trail.close();
  }
});

test("a crash part way, after the run reached Trail: the run says it stopped", async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("pair-stop-crash-home");
    mkdirSync(join(home, ".claude"));
    const repo = tmpRepo("pair-stop-crash");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    // .trail as a file: init can't make its folder there.
    writeFileSync(join(repo, ".trail"), "not a folder\n");
    const r = await init(repo, home, trail.url, ["--agents", "auto"]);
    assert.notEqual(r.code, 0, r.err);
    const progress = trail.calls.filter((c) => c.path === "/api/cli/handoffs/progress").map((c) => c.body);
    assert.ok(progress.some((p) => p.failed === "crashed"), JSON.stringify(progress));
  } finally {
    trail.close();
  }
});

// An agent's tool call that runs out of time ends init with SIGTERM.
test("killed part way (an agent's tool timeout): the run says it stopped before it exits", { skip: process.platform === "win32" }, async () => {
  const trail = await standInTrail();
  try {
    const home = tmpRepo("pair-stop-kill-home");
    mkdirSync(join(home, ".claude"));
    const repo = tmpRepo("pair-stop-kill");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!AGENT_VARS.test(k)) env[k] = v;
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "init", repo, "--agents", "auto", "--pair", CODE, "--server", trail.url], {
      env: { ...env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), TRAIL_INVOKED_AS: "trail", DO_NOT_TRACK: "1", GRAFT_MCP_NPX: "1", TRAIL_NO_LOOK_BACK: "1", TRAIL_NO_FETCH: "1", CLAUDECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (c) => {
      err += c;
      if (String(c).includes("following along")) child.kill("SIGTERM");
    });
    const code = await new Promise<number | null>((ok) => child.on("close", (c, sig) => ok(c ?? (sig ? 128 : null))));
    assert.notEqual(code, 0, err);
    const progress = trail.calls.filter((c) => c.path === "/api/cli/handoffs/progress").map((c) => c.body);
    assert.ok(progress.some((p) => p.failed === "crashed"), JSON.stringify(progress));
  } finally {
    trail.close();
  }
});

// Codex runs commands with the network off unless asked. Setting up here anyway left Trail's page waiting on a run it never heard of.
test("Trail can't be reached: --pair stops before writing anything and tells the agent to run it again with network access", async () => {
  const home = tmpRepo("pair-stop-offline-home");
  mkdirSync(join(home, ".claude"));
  const repo = tmpRepo("pair-stop-offline");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const r = await init(repo, home, "http://127.0.0.1:9", ["--agents", "auto"]);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /couldn't reach Trail at http:\/\/127\.0\.0\.1:9/);
  assert.match(r.err, /run this same command again with network access/);
  assert.deepEqual(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout, "", "nothing written");
});
