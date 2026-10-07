/**
 * `trail` and `graft`: one program under two names.
 *
 * Under graft every command keeps its old name, meaning and output, because
 * agents, hooks and CI already parse it. Under trail the layout changes: the
 * `graft trail …` group moves to the top level, `check` hands its name to the
 * team check, and the freshness check becomes `build --check`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand, cmd, graftNotice, noticeStampPath, tag } from "../src/brand.js";
import { track } from "../src/telemetry/track.js";
import { commandInvokesGraft } from "../src/claude/session-metrics.js";
import { savingsLine, sumSavingsFooters } from "../src/context/savings.js";
import { homeEnv, tmpRepo } from "./helpers.js";

// --- the name itself ---

test("unset means graft: anything that loads cli.js directly was wired by an older graft", () => {
  assert.equal(brand({}), "graft");
  assert.equal(brand({ TRAIL_INVOKED_AS: "trail" }), "trail");
  assert.equal(brand({ TRAIL_INVOKED_AS: "something-else" }), "graft");
  assert.equal(tag({ TRAIL_INVOKED_AS: "trail" }), "[trail]");
  assert.equal(tag({}), "[graft]");
});

test("cmd spells a graft command the way the running name does", () => {
  for (const s of ["graft ask", "graft check", "graft trail push", "graft build --deep"]) assert.equal(cmd(s, "graft"), s);
  assert.equal(cmd("graft ask", "trail"), "trail ask");
  assert.equal(cmd("graft build --deep", "trail"), "trail build --deep");
  assert.equal(cmd("graft check", "trail"), "trail build --check");
  assert.equal(cmd("graft stats", "trail"), "trail status");
  assert.equal(cmd("graft trail status", "trail"), "trail status");
  assert.equal(cmd("graft trail push", "trail"), "trail push");
  assert.equal(cmd("graft trail connect", "trail"), "trail login");
  assert.equal(cmd("graft trail disconnect", "trail"), "trail logout");
  // A prefix only matches a whole word: `graft checkout` is not `graft check`.
  assert.equal(cmd("graft checkout", "trail"), "trail checkout");
});

// --- the once-a-day line for people still typing graft ---

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "graft-notice-"));
}

test("a person typing graft sees the new name once a day, with what it ran", () => {
  const home = scratchHome();
  const env = { PATH: "" };
  const now = Date.parse("2026-10-07T10:00:00Z");
  const first = graftNotice({ ran: "graft ask", tty: true, env, home, now });
  assert.equal(
    first,
    "· graft is now trail. this ran trail ask, and graft keeps working (shown once a day)\n" +
      "· run graft upgrade to get the trail command too",
  );
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env, home, now: now + 60_000 }), null, "not twice in a day");
  assert.ok(graftNotice({ ran: "graft ask", tty: true, env, home, now: now + 25 * 3600_000 }), "again the next day");
});

test("the notice names the trail spelling of a renamed command", () => {
  const out = graftNotice({ ran: "graft check", tty: true, env: { PATH: "" }, home: scratchHome() });
  assert.match(out ?? "", /this ran trail build --check,/);
});

test("no upgrade hint once a trail command is on PATH", () => {
  const bin = mkdtempSync(join(tmpdir(), "graft-bin-"));
  const exe = join(bin, process.platform === "win32" ? "trail.cmd" : "trail");
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  const out = graftNotice({ ran: "graft grep", tty: true, env: { PATH: bin }, home: scratchHome() });
  assert.equal(out, "· graft is now trail. this ran trail grep, and graft keeps working (shown once a day)");
});

test("agents, pipes, CI and trail itself never see the notice, and it isn't stamped for them", () => {
  const home = scratchHome();
  assert.equal(graftNotice({ ran: "graft ask", tty: false, env: {}, home }), null, "no terminal");
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env: { CLAUDECODE: "1" }, home }), null, "Claude Code");
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env: { CI: "true" }, home }), null, "CI");
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env: { TRAIL_INVOKED_AS: "trail" }, home }), null, "trail");
  assert.equal(graftNotice({ ran: "graft ask", tty: true, env: { GRAFT_NO_RENAME_NOTICE: "1" }, home }), null, "opted out");
  assert.equal(existsSync(noticeStampPath(home)), false, "nothing stamped");
});

// --- what parses the output ---

test("the savings footer is read under either name", () => {
  assert.equal(sumSavingsFooters("[graft] tokens saved ≈ 1,200 (80%)\n[trail] tokens saved ≈ 300 (50%)"), 1500);
});

test("a shell command running trail counts as a retrieval, like graft", () => {
  assert.equal(commandInvokesGraft('trail ask "auth" --source'), true);
  assert.equal(commandInvokesGraft("npx -y @trailhq/trail grep foo"), true);
  assert.equal(commandInvokesGraft("cd x && trail callers run"), true);
  assert.equal(commandInvokesGraft("node dist/bin/trail.js ask x"), true);
  assert.equal(commandInvokesGraft("graft ask x"), true);
  assert.equal(commandInvokesGraft("mytrail ask x"), false);
  assert.equal(commandInvokesGraft("echo trail"), false);
});

test("every telemetry event says which name ran it", () => {
  process.env.GRAFT_POSTHOG_KEY = "phc_test_key";
  const home = scratchHome();
  const open = { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv;
  const viaTrail = track("first_run", {}, { home, env: { ...open, TRAIL_INVOKED_AS: "trail" } });
  const other = scratchHome();
  const viaGraft = track("first_run", {}, { home: other, env: { HOME: other, USERPROFILE: other } });
  assert.equal(viaTrail?.properties.cli_name, "trail");
  assert.equal(viaGraft?.properties.cli_name, "graft");
});

// --- the two command layouts, end to end ---

function run(name: "trail" | "graft", args: string[], home: string, cwd = process.cwd()) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", `${name}.ts`), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function builtRepo(): string {
  const d = tmpRepo("trailname");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "export function alpha(): number {\n  return beta();\n}\n");
  writeFileSync(join(d, "src", "b.ts"), "export function beta(): number {\n  return 1;\n}\n");
  spawnSync("git", ["init", "-q"], { cwd: d });
  return d;
}

test("trail --help groups the commands and lists the cloud ones at the top level", () => {
  const home = scratchHome();
  const r = run("trail", ["--help"], home);
  assert.equal(r.status, 0);
  for (const heading of ["Find code", "Setup:", "Trail cloud:", "CI:"]) assert.ok(r.out.includes(heading), heading);
  for (const c of ["login", "team", "check", "logout", "push", "pull", "status"]) assert.match(r.out, new RegExp(`^  ${c} `, "m"), c);
  // Still run, just not listed.
  for (const c of ["viz", "mcp", "stats", "watch", "connect", "trail"]) assert.doesNotMatch(r.out, new RegExp(`^  ${c} `, "m"), c);
});

test("graft --help keeps its old flat list, including check and the trail group", () => {
  const r = run("graft", ["--help"], scratchHome());
  assert.equal(r.status, 0);
  assert.match(r.out, /^Usage: graft /m);
  for (const c of ["check", "stats", "viz", "trail"]) assert.match(r.out, new RegExp(`^  ${c} `, "m"), c);
  assert.ok(!r.out.includes("Trail cloud:"));
});

test("the freshness check is graft check under graft and trail build --check under trail", () => {
  const home = scratchHome();
  const d = builtRepo();
  assert.equal(run("graft", ["build", d], home).status, 0);
  const g = run("graft", ["check", d], home);
  assert.equal(g.status, 0, g.err);
  assert.match(g.out, /graph check: OK/);
  assert.match(g.out, /Run `graft build --deep` to summarize them/);
  const t = run("trail", ["build", "--check", d], home);
  assert.equal(t.status, 0, t.err);
  assert.match(t.out, /graph check: OK/);
  assert.match(t.out, /Run `trail build --deep` to summarize them/);
  assert.equal(run("graft", ["build", "--check", d], home).status, 0, "graft build --check works too");
  // Stale: a new function the graph has never seen fails both, the same way.
  writeFileSync(join(d, "src", "c.ts"), "export function gamma(): number {\n  return 2;\n}\n");
  assert.equal(run("graft", ["check", d, "--json"], home).status, 1);
  assert.equal(run("trail", ["build", "--check", d, "--json"], home).status, 1);
});

test("trail check is the team check, not the freshness check", () => {
  // Outside a git repo there is no diff to check; the freshness check is build --check.
  const r = run("trail", ["check", mkdtempSync(join(tmpdir(), "not-git-"))], scratchHome());
  assert.equal(r.status, 1);
  assert.match(r.err, /not a git repository/);
});

test("trail status puts the code map and the cloud link on one screen", () => {
  const home = scratchHome();
  const d = builtRepo();
  run("trail", ["build", d], home);
  const r = run("trail", ["status", d], home);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^code map {4}✓ \d+ nodes · in sync with the code$/m);
  assert.match(r.out, /^cloud {7}not signed in · trail login$/m);
  const json = JSON.parse(run("trail", ["status", d, "--json"], home).out);
  assert.equal(json.cloud, null);
});

test("old spellings keep working under trail: trail trail status, trail brain status, trail stats", () => {
  const home = scratchHome();
  const d = builtRepo();
  run("trail", ["build", d], home);
  for (const args of [["trail", "status", d], ["brain", "status", d], ["stats", d]]) {
    const r = run("trail", args, home);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.err}`);
  }
  assert.match(run("trail", ["trail", "status", d], home).out, /^code map/m);
});

test("graft trail status is unchanged", () => {
  const home = scratchHome();
  const d = builtRepo();
  const r = run("graft", ["trail", "status", d], home);
  assert.equal(r.status, 0);
  assert.match(r.err, /no brain attached — run `graft trail connect <brainId>:<token>`/);
});

test("the savings footer says [trail] under trail and [graft] under graft", () => {
  const saved = { baselineChars: 40_000, files: 3 } as Parameters<typeof savingsLine>[1];
  const before = process.env.TRAIL_INVOKED_AS;
  try {
    delete process.env.TRAIL_INVOKED_AS;
    assert.match(savingsLine("short pack", saved), /^\[graft\] tokens saved ≈ /);
    process.env.TRAIL_INVOKED_AS = "trail";
    assert.match(savingsLine("short pack", saved), /^\[trail\] tokens saved ≈ /);
  } finally {
    if (before === undefined) delete process.env.TRAIL_INVOKED_AS;
    else process.env.TRAIL_INVOKED_AS = before;
  }
});

// --- MCP: trail's tool names, graft's still answered ---

async function mcpRpc(name: "trail" | "graft", dir: string, messages: object[], expected: number): Promise<any[]> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", `${name}.ts`), "mcp", dir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DO_NOT_TRACK: "1", TRAIL_INVOKED_AS: undefined },
  });
  const out: any[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) out.push(JSON.parse(line));
    }
  });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 20000;
  while (out.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  return out;
}

test("trail mcp advertises trail_* tools and answers graft_* calls too; graft mcp is unchanged", async () => {
  const d = builtRepo();
  run("graft", ["build", d], scratchHome());
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = (id: number, tool: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: { query: "beta" } } });

  const t = await mcpRpc("trail", d, [init, list, call(3, "trail_find_code"), call(4, "graft_find_code")], 4);
  assert.equal(t.find((r) => r.id === 1)?.result.serverInfo.name, "trail");
  assert.match(t.find((r) => r.id === 1)?.result.instructions, /select:mcp__trail__trail_find_code,/);
  const names = t.find((r) => r.id === 2)?.result.tools.map((x: { name: string }) => x.name);
  assert.ok(names.includes("trail_find_code") && !names.some((n: string) => n.startsWith("graft_")), String(names));
  for (const id of [3, 4]) assert.equal(t.find((r) => r.id === id)?.result.isError, false, `call ${id}`);

  const g = await mcpRpc("graft", d, [init, list], 2);
  assert.equal(g.find((r) => r.id === 1)?.result.serverInfo.name, "graft");
  assert.ok(g.find((r) => r.id === 2)?.result.tools.some((x: { name: string }) => x.name === "graft_find_code"));
});

test("both tool vocabularies count as retrievals", async () => {
  const { canonicalToolName } = await import("../src/mcp/tool-names.js");
  const { isGraftMcpTool } = await import("../src/claude/session-metrics.js");
  assert.equal(canonicalToolName("trail_find_code"), "graft_find_code");
  assert.equal(canonicalToolName("graft_ask"), "graft_find_code");
  assert.equal(isGraftMcpTool("mcp__trail__trail_trace_calls"), true);
  assert.equal(isGraftMcpTool("mcp__graft__graft_find_all"), true);
});
