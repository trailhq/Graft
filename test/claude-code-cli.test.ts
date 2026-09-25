/**
 * `--provider claude-code` and `graft auth` at the process boundary, against a
 * stand-in `claude` executable (GRAFT_CLAUDE_CODE_BIN) that logs how it was run
 * and answers the way Claude Code 2.1.281 does. No real `claude` ever starts.
 *
 * What only this level can show: the deep build runs with no API key at all, every
 * call really arrives with the isolation flags, the prompt on stdin and a scratch
 * working directory outside the repo, `-j` reaches both LLM passes, and a
 * signed-out Claude Code stops the build before any call.
 *
 * The stand-in is a script run through its shebang, which Windows does not honour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpRepo } from "./helpers.js";

const skip = process.platform === "win32" ? "the stand-in claude is a shebang script" : false;

/** A `claude` that logs each run as a JSON line and answers `auth status` and `-p`. */
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
const env = { CLAUDECODE: process.env.CLAUDECODE ?? null, ENABLE_CLAUDEAI_MCP_SERVERS: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null,
  GRAFT_API_KEY: process.env.GRAFT_API_KEY ?? null };
if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN !== "0";
  log({ args, cwd: process.cwd(), env });
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty",
    email: "someone@example.com", orgName: "Example Org", subscriptionType: loggedIn ? "max" : null }));
  process.exit(loggedIn ? 0 : 1);
}
if (args[0] !== "-p") {
  log({ args, cwd: process.cwd(), env });
  if (args[0] === "setup-token") process.stdout.write("FAKE-TOKEN-FROM-CLAUDE\n");
  process.exit(0);
}
let input = "";
process.stdin.setEncoding("utf8").on("data", (d) => (input += d)).on("end", () => {
  const start = Date.now();
  setTimeout(() => {
    const i = args.indexOf("--json-schema");
    const schema = i >= 0 ? JSON.parse(args[i + 1]) : null;
    const props = (schema && schema.properties) || {};
    let structured;
    if (props.symbols) {
      const ids = [...input.matchAll(/^- id=(\S+) \|/gm)].map((m) => m[1]);
      structured = { symbols: ids.map((id) => ({ id, summary: "Does " + id + ".", crux_start: 0, crux_end: 0 })) };
    } else if (props.nodes) {
      const paths = [...input.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
      structured = { nodes: [{ name: "Fake Concept", type: "concept", summary: "A concept.", sources: paths, links: [] }] };
    }
    log({ args, cwd: process.cwd(), env, input, start, end: Date.now() });
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
      result: structured ? JSON.stringify(structured) : "A file that returns a number.",
      structured_output: structured, stop_reason: structured ? "tool_use" : "end_turn", total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
  }, 150);
});
`;

interface LogEntry {
  args: string[];
  cwd: string;
  env: Record<string, string | null>;
  input?: string;
  start?: number;
  end?: number;
}

function setup(files: number): { repo: string; bin: string; log: string } {
  const repo = tmpRepo("claudecode");
  mkdirSync(join(repo, "src"), { recursive: true });
  for (let i = 0; i < files; i++) {
    writeFileSync(join(repo, "src", `m${i}.ts`), `export function run${i}(): number {\n  return ${i};\n}\n`);
  }
  const tools = tmpRepo("claudecode-bin");
  const bin = join(tools, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  return { repo, bin, log: join(tools, "calls.jsonl") };
}

function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
}

/** Asynchronous so the stand-in's stdin/stdout never contend with a blocked parent. */
async function graft(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  // No key anywhere: the claude-code provider must not need one.
  for (const k of ["GRAFT_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "ORCAROUTER_API_KEY", "GRAFT_PROVIDER", "GRAFT_MODEL"]) {
    if (!(k in env)) delete childEnv[k];
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env: childEnv });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  const status = await new Promise<number | null>((r) => child.on("close", r));
  return { status, stdout, stderr };
}

test("build --deep --provider claude-code: runs with no key, isolated, prompt on stdin, -j honoured", { skip }, async () => {
  const { repo, bin, log } = setup(4);
  const r = await graft(["--provider", "claude-code", "build", repo, "--deep", "-j", "1"], {
    GRAFT_CLAUDE_CODE_BIN: bin,
    FAKE_CLAUDE_LOG: log,
    CLAUDECODE: "1", // as when graft itself runs inside a Claude Code session
  });
  const describe = `status ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
  assert.equal(r.status, 0, describe);
  assert.match(r.stderr, /claude-code: signed in with a Claude Max subscription, model sonnet/);
  assert.match(r.stdout, /✓ concepts: [1-9]\d* nodes/, describe);
  assert.match(r.stdout, /meaning: [1-9]\d* computed/, describe);
  assert.match(r.stdout, /claude-code: \d+ calls, \$0\.\d\d at API prices/);
  assert.doesNotMatch(r.stdout + r.stderr, /someone@example\.com|Example Org/, "never the account's identity");

  const calls = readLog(log).filter((e) => e.args[0] === "-p");
  // 4 file summaries + 1 synthesis batch + 4 crux calls.
  assert.equal(calls.length, 9, describe);
  for (const c of calls) {
    for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) {
      assert.ok(c.args.includes(flag), `${flag} in ${c.args.join(" ")}`);
    }
    assert.equal(c.args[c.args.indexOf("--setting-sources") + 1], "");
    assert.equal(c.args[c.args.indexOf("--tools") + 1], "");
    assert.equal(c.args[c.args.indexOf("--model") + 1], "sonnet");
    assert.ok(!resolve(c.cwd).startsWith(resolve(repo)), "never the repo being indexed");
    assert.ok(!existsSync(c.cwd), "the scratch directory is removed");
    assert.equal(c.env.CLAUDECODE, null, "the parent session marker is scrubbed");
    assert.equal(c.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.ok(!c.args.some((a) => a.includes("return 0;")), "file contents never ride in argv");
  }
  assert.ok(calls.some((c) => c.input?.includes("export function run0")), "file contents arrive on stdin");

  // -j 1: never two claude processes at once, in the concept pass or the crux pass.
  const spans = calls.map((c) => [c.start!, c.end!]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i][0] >= spans[i - 1][1], `calls ${i - 1} and ${i} overlapped under -j 1`);
  }
});

test("build --deep --provider claude-code: a signed-out Claude Code fails before any call", { skip }, async () => {
  const { repo, bin, log } = setup(2);
  const r = await graft(["--provider", "claude-code", "build", repo, "--deep"], {
    GRAFT_CLAUDE_CODE_BIN: bin,
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_LOGGED_IN: "0",
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--provider claude-code: Claude Code is not signed in\. Run `graft auth login`/);
  assert.equal(readLog(log).filter((e) => e.args[0] === "-p").length, 0);
});

test("build --deep --provider claude-code: a missing claude binary fails early and says how to fix it", { skip }, async () => {
  const { repo } = setup(1);
  const r = await graft(["--provider", "claude-code", "build", repo, "--deep"], {
    GRAFT_CLAUDE_CODE_BIN: join(repo, "no-such-claude"),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /was not found\. Install it .*graft auth login/);
});

test("graft auth status / login / token dispatch to the matching claude subcommand", { skip }, async () => {
  const { bin, log } = setup(0);
  const env = { GRAFT_CLAUDE_CODE_BIN: bin, FAKE_CLAUDE_LOG: log };

  const status = await graft(["auth", "status"], env);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Claude Code: signed in with a Claude Max subscription/);
  assert.doesNotMatch(status.stdout + status.stderr, /someone@example\.com|Example Org/);

  const login = await graft(["auth", "login"], env);
  assert.equal(login.status, 0, login.stderr);

  const token = await graft(["auth", "token"], env);
  assert.equal(token.status, 0, token.stderr);
  // The token is Claude Code's own output on the inherited terminal; graft adds
  // only the instruction to export it.
  assert.match(token.stderr, /export CLAUDE_CODE_OAUTH_TOKEN=<the token above>/);

  const invoked = readLog(log).map((e) => e.args.join(" "));
  assert.ok(invoked.includes("auth status --json"));
  assert.ok(invoked.includes("auth login"));
  assert.ok(invoked.includes("setup-token"));

  const out = await graft(["auth", "status"], { ...env, FAKE_CLAUDE_LOGGED_IN: "0" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /graft auth login/);
});
