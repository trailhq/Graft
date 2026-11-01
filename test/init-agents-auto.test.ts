/**
 * `trail init --agents auto [--pair CODE]`, the website's one setup prompt, as
 * a coding agent runs it: no TTY, no questions. The main agents' repo files, the
 * laptop's settings only for agents installed here plus the caller, and the
 * agents set up here reported to Trail's page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readStamp, wiringOpts, writeStamp } from "../src/upkeep.js";
import { tmpRepo } from "./helpers.js";

/** Variables an agent sets: the run under test must not inherit the runner's. */
const AGENT_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_.*|OPENCODE.*|GEMINI_CLI|CURSOR_.*|ANTIGRAVITY_AGENT|COPILOT_.*|AI_AGENT|AGENT|TERM_PROGRAM)$/;

function env(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!AGENT_VARS.test(k)) out[k] = v;
  return {
    ...out,
    HOME: home,
    USERPROFILE: home,
    TRAIL_INVOKED_AS: "trail",
    DO_NOT_TRACK: "1",
    GRAFT_MCP_NPX: "1",
    TRAIL_NO_LOOK_BACK: "1",
    TRAIL_NO_FETCH: "1",
    ...extra,
  };
}

function gitRepo(): string {
  const dir = tmpRepo("auto-cli");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function init(repo: string, home: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "init", repo, "--no-build", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: env(home, extra),
  });
}

/** The main agents' committed files, under trail's names. */
const REPO_FILES = [
  join(".claude", "settings.json"),
  join(".trail", "hook.cjs"),
  "AGENTS.md",
  join(".cursor", "rules", "trail.mdc"),
  join(".cursor", "hooks.json"),
  join(".cursor", "mcp.json"),
];

/** Other agents' files: only when this laptop has that agent. */
const OTHER_FILES = ["GEMINI.md", ".windsurf", ".kiro", join(".github", "copilot-instructions.md"), ".adal", ".grok"];

test("auto writes the main agents' repo files, and laptop settings only for the ones installed here", () => {
  const home = tmpRepo("auto-cli-home");
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".cursor"));
  const repo = gitRepo();
  const r = init(repo, home, ["--agents", "auto"], { CLAUDECODE: "1" });
  assert.equal(r.status, 0, r.stderr);
  for (const f of REPO_FILES) assert.ok(existsSync(join(repo, f)), `${f} missing\n${r.stderr}`);
  for (const f of OTHER_FILES) assert.ok(!existsSync(join(repo, f)), `${f} written for an agent nobody here uses`);
  assert.ok(existsSync(join(home, ".claude", "settings.json")), "Claude Code's laptop hooks");
  assert.ok(existsSync(join(home, ".claude", "skills", "trail", "SKILL.md")), "Claude Code's skill");
  assert.ok(!existsSync(join(home, ".codex")), "Codex isn't installed: nothing for it in the home dir");
  assert.ok(!existsSync(join(home, ".gemini")), "nor for Gemini CLI or Antigravity");
  assert.match(r.stderr, /Set up for Claude Code and Cursor on this laptop\. Teammates on Claude Code, Cursor, Codex or OpenCode are covered once you commit\./);
  assert.doesNotMatch(r.stderr, /—/);
  assert.deepEqual(wiringOpts(readStamp(repo)).laptop, ["claude", "cursor"]);
});

test("auto with no Claude Code here writes its committed files but nothing in ~/.claude", () => {
  const home = tmpRepo("auto-cli-home");
  mkdirSync(join(home, ".cursor"));
  const repo = gitRepo();
  const r = init(repo, home, ["--agents", "auto"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, ".claude", "settings.json")));
  assert.ok(existsSync(join(repo, ".trail", "hook.cjs")));
  assert.ok(!existsSync(join(home, ".claude")), readdirSync(home).join(","));
  assert.match(r.stderr, /Set up for Cursor on this laptop\./);
});

test("a later refresh keeps to the laptop's agents", async () => {
  const home = tmpRepo("auto-cli-home");
  mkdirSync(join(home, ".cursor"));
  const repo = gitRepo();
  assert.equal(init(repo, home, ["--agents", "auto"]).status, 0);
  const stamp = readStamp(repo)!;
  writeStamp(repo, "0.0.1", stamp.hosts, stamp.opts);
  const { runUpkeep } = await import("../src/upkeep-run.js");
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, brand: process.env.TRAIL_INVOKED_AS };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TRAIL_INVOKED_AS = "trail";
  try {
    runUpkeep(repo, "9.9.9", { background: false, home });
  } finally {
    for (const [k, v] of Object.entries({ HOME: was.HOME, USERPROFILE: was.USERPROFILE, TRAIL_INVOKED_AS: was.brand })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(readStamp(repo)!.version, "9.9.9", "the refresh ran");
  assert.ok(!existsSync(join(home, ".claude")), "no Claude Code here: the refresh leaves ~/.claude alone");
  assert.ok(!existsSync(join(home, ".gemini")), "no Antigravity here either");
});

test("auto --dry-run prints the plan, without other agents' laptop files, and writes nothing", () => {
  const home = tmpRepo("auto-cli-home");
  mkdirSync(join(home, ".cursor"));
  const repo = gitRepo();
  const r = init(repo, home, ["--agents", "auto", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /would write in this repo:/);
  assert.ok(!r.stderr.includes(".windsurf"), "Windsurf isn't here: no repo file for it in the plan");
  assert.ok(r.stderr.includes(join(".cursor", "rules", "trail.mdc")), r.stderr);
  assert.ok(!r.stderr.includes(join(".claude", "skills", "trail")), "Claude Code isn't here: no ~/.claude skill in the plan");
  assert.doesNotMatch(r.stderr, /affects ALL repos/);
  assert.match(r.stderr, /Cursor/);
  assert.deepEqual(readdirSync(repo), [".git"]);
});

test("auto can't be mixed with agent ids", () => {
  const home = tmpRepo("auto-cli-home");
  const repo = gitRepo();
  const r = init(repo, home, ["--agents", "auto", "cursor"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /auto/);
  assert.deepEqual(readdirSync(repo), [".git"]);
});

test("auto --pair tells Trail the agent running init and the agents set up on this laptop", async () => {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      bodies.push({ path: req.url ?? "", body });
      const reply = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.url === "/api/cli/handoffs") return reply(201, { url: "http://127.0.0.1/connect?state=s" });
      if (req.url === "/api/cli/handoffs/progress") return reply(202, {});
      return reply(410, { error: "gone" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  try {
    const home = tmpRepo("auto-cli-home");
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".codex"));
    const repo = gitRepo();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "init", repo, "--no-build", "--agents", "auto", "--pair", "X4GM5OQU4NIA65ZR", "--server", `http://127.0.0.1:${port}`],
      { env: env(home, { CURSOR_AGENT: "1" }), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise<number | null>((ok) => child.on("close", ok));
    assert.equal(code, 0, stderr);
    const progress = bodies.filter((b) => b.path === "/api/cli/handoffs/progress").map((b) => b.body);
    assert.equal(progress[0]?.agent, "cursor", "the agent running init");
    const agents = progress.map((p) => (p.findings as { agents?: string[] } | undefined)?.agents).filter(Boolean);
    assert.ok(agents.length > 0, JSON.stringify(progress));
    assert.deepEqual(agents[0], ["cursor", "claude", "codex"]);
    // Sent as soon as the wiring is done: before the map's step.
    const first = progress.findIndex((p) => (p.findings as { agents?: string[] } | undefined)?.agents);
    const mapped = progress.findIndex((p) => (p.phases as Array<{ id: string; status: string }> | undefined)?.some((ph) => ph.id === "files" && ph.status !== "todo"));
    assert.ok(first < mapped, `agents at ${first}, map at ${mapped}`);
  } finally {
    server.close();
  }
});
