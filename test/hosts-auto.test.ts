/**
 * `trail init --agents auto`: the website's one setup prompt. Repo files for
 * the main agents (committed, so teammates on them are covered) and any other
 * agent set up here; laptop settings only for agents installed here plus the
 * one running init.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { autoSelection, autoSummary, callingAgent, installedAgents } from "../src/hosts/auto.js";
import { runHostsInit } from "../src/hosts/init.js";
import { hostIds } from "../src/hosts/registry.js";
import { tmpRepo } from "./helpers.js";

process.env.GRAFT_MCP_NPX = "1";

test("the agent running init is read from the variables each one sets", () => {
  assert.equal(callingAgent({ CLAUDECODE: "1" }), "claude");
  assert.equal(callingAgent({ CODEX_THREAD_ID: "019a-x" }), "codex");
  assert.equal(callingAgent({ CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(callingAgent({ OPENCODE: "1", AGENT: "1" }), "opencode");
  assert.equal(callingAgent({ GEMINI_CLI: "1" }), "gemini");
  assert.equal(callingAgent({ CURSOR_AGENT: "1", CI: "1" }), "cursor");
  assert.equal(callingAgent({ ANTIGRAVITY_AGENT: "1" }), "antigravity");
  assert.equal(callingAgent({ COPILOT_AGENT_SESSION_ID: "s" }), "copilot");
  assert.equal(callingAgent({ AI_AGENT: "github-copilot" }), "copilot");
  assert.equal(callingAgent({ AI_AGENT: "cursor-cli@1.2.3" }), "cursor");
  assert.equal(callingAgent({ TERM_PROGRAM: "windsurf" }), "windsurf");
  assert.equal(callingAgent({ TERM_PROGRAM: "kiro" }), "kiro");
});

test("no agent, a bare AGENT=1, or an emptied variable is unknown", () => {
  assert.equal(callingAgent({}), null);
  assert.equal(callingAgent({ AGENT: "1" }), null);
  assert.equal(callingAgent({ CLAUDECODE: "" }), null);
  assert.equal(callingAgent({ TERM_PROGRAM: "vscode" }), null);
  assert.equal(callingAgent({ AI_AGENT: "some-new-agent" }), null);
});

test("installed means a folder in the home dir, never one in the repo init just wrote", () => {
  const home = tmpRepo("auto-home");
  const repo = tmpRepo("auto-repo");
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".cursor"));
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  // In the repo only: a teammate's committed files, not an install.
  mkdirSync(join(repo, ".windsurf"));
  mkdirSync(join(repo, ".github"));
  assert.deepEqual(installedAgents(home, repo), ["claude", "codex", "opencode", "cursor"]);
});

test("the AGENTS.md host is never reported as an agent", () => {
  const home = tmpRepo("auto-home");
  const repo = tmpRepo("auto-repo");
  mkdirSync(join(home, ".config", "agents"), { recursive: true });
  assert.deepEqual(installedAgents(home, repo), []);
});

test("the caller comes first and gets laptop settings even when detection missed it", () => {
  const home = tmpRepo("auto-home");
  const repo = tmpRepo("auto-repo");
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".cursor"));
  const s = autoSelection({ home, repo, env: { CODEX_THREAD_ID: "t" } });
  assert.equal(s.caller, "codex");
  assert.deepEqual(s.agents, ["codex", "claude", "cursor"]);
  assert.deepEqual(s.laptop, ["agents", "claude", "cursor"]);
  assert.deepEqual(s.repo, ["claude", "cursor", "agents"]);
  assert.equal(s.agent, "codex");
});

test("the repo gets the main agents' files, plus any other agent this laptop set up", () => {
  const home = tmpRepo("auto-home");
  const repo = tmpRepo("auto-repo");
  assert.deepEqual(autoSelection({ home, repo, env: {} }).repo, ["claude", "cursor", "agents"]);
  mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
  assert.deepEqual(autoSelection({ home, repo, env: { GEMINI_CLI: "1" } }).repo, ["claude", "cursor", "agents", "gemini", "windsurf"]);
});

test("with no caller, the reported agent is the first one set up, else claude", () => {
  const home = tmpRepo("auto-home");
  const repo = tmpRepo("auto-repo");
  mkdirSync(join(home, ".cursor"));
  assert.equal(autoSelection({ home, repo, env: {} }).agent, "cursor");
  const bare = tmpRepo("auto-home");
  const s = autoSelection({ home: bare, repo, env: {} });
  assert.deepEqual(s.agents, []);
  assert.deepEqual(s.laptop, []);
  assert.equal(s.agent, "claude");
});

test("the summary names the agents plainly, with no em dash", () => {
  assert.equal(
    autoSummary(["claude", "cursor", "codex"]),
    "Set up for Claude Code, Cursor and Codex on this laptop. Teammates on Claude Code, Cursor, Codex or OpenCode are covered once you commit.",
  );
  assert.equal(
    autoSummary(["opencode"]),
    "Set up for OpenCode on this laptop. Teammates on Claude Code, Cursor, Codex or OpenCode are covered once you commit.",
  );
  assert.equal(
    autoSummary([]),
    "No coding agent found on this laptop, so nothing outside this repo changed. Teammates on Claude Code, Cursor, Codex or OpenCode are covered once you commit.",
  );
  for (const s of [autoSummary(["claude", "gemini"]), autoSummary([])]) assert.ok(!s.includes("—"));
});

test("runHostsInit writes every repo file but out-of-repo files only for laptop hosts", () => {
  const home = tmpRepo("auto-home");
  const repo = tmpRepo("auto-repo");
  // Codex and Antigravity both installed, but neither on the laptop list.
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  const r = runHostsInit(repo, { home, agents: hostIds(), laptop: ["cursor"] });
  assert.equal(r.written.length, hostIds().length);
  assert.ok(r.mcp.every((m) => m.path.startsWith(repo)), JSON.stringify(r.mcp));
  assert.ok(r.hooks.every((h) => h.path.startsWith(repo)), JSON.stringify(r.hooks));
  assert.ok(r.hooks.some((h) => h.path.includes(join(".cursor", "hooks"))), "Cursor's repo-local hooks are written");

  const all = runHostsInit(repo, { home, agents: hostIds(), laptop: ["agents", "antigravity"] });
  assert.ok(all.mcp.some((m) => m.path === join(home, ".codex", "config.toml")));
  assert.ok(all.mcp.some((m) => m.path === join(home, ".gemini", "config", "mcp_config.json")));
  assert.ok(all.hooks.some((h) => h.path.startsWith(join(home, ".codex"))));
  assert.ok(all.hooks.some((h) => h.path.startsWith(join(home, ".gemini", "skills"))));
});
