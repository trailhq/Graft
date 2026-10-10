/**
 * `graft build --lsp` on Windows (#385): finding a server on PATH without `where.exe`
 * (cmd.exe has no `command -v`, and `where` also searches the current folder), skipping
 * npm's extensionless sh script, and launching npm's `.cmd` shims, which Node refuses to
 * start without a shell — without letting the repo being mapped supply programs, without
 * cmd.exe rewriting the path, and without leaving the server running on dispose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOnWindowsPath } from "../src/graph/lsp/registry.js";
import { spawnSpec, LspClient } from "../src/graph/lsp/client.js";

const onWindows = { skip: process.platform !== "win32" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("findOnWindowsPath: npm's .cmd shim is found, its extensionless sh script is not", () => {
  const files = new Set(["C:\\npm\\typescript-language-server", "C:\\npm\\typescript-language-server.cmd"]);
  assert.equal(findOnWindowsPath("typescript-language-server", "C:\\npm", (p) => files.has(p)), "C:\\npm\\typescript-language-server.cmd");
});

test("findOnWindowsPath: PATH order wins, then .com/.exe/.bat/.cmd within a folder", () => {
  const files = new Set(["C:\\a\\clangd.cmd", "C:\\a\\clangd.exe", "C:\\b\\clangd.exe"]);
  const has = (p: string) => files.has(p);
  assert.equal(findOnWindowsPath("clangd", "C:\\a;C:\\b", has), "C:\\a\\clangd.exe");
  assert.equal(findOnWindowsPath("clangd", "C:\\b;C:\\a", has), "C:\\b\\clangd.exe");
  assert.equal(findOnWindowsPath("clangd", '"C:\\b";', has), "C:\\b\\clangd.exe", "a quoted PATH entry");
});

test("findOnWindowsPath: relative and empty PATH entries are never searched (no current-folder hijack)", () => {
  const seen: string[] = [];
  const has = (p: string) => { seen.push(p); return true; };
  assert.equal(findOnWindowsPath("gopls", ".;;tools;bin\\x;C:relative", has), null);
  assert.deepEqual(seen, [], "nothing outside an absolute folder was even checked");
  assert.equal(findOnWindowsPath("gopls", "", has), null);
});

test("spawnSpec: a Windows .cmd runs through the absolute cmd.exe with the path in an env var", () => {
  const cmd = "C:\\Users\\A B\\AppData\\Roaming\\npm\\typescript-language-server.cmd";
  const s = spawnSpec(cmd, ["--stdio"], "win32");
  assert.match(s.command, /^[A-Za-z]:\\.*cmd\.exe$/i, "an absolute cmd.exe");
  assert.deepEqual(s.args, ["/d", "/v:off", "/s", "/c", '""%GRAFT_LSP_SHIM%" --stdio"']);
  assert.deepEqual(s.env, { GRAFT_LSP_SHIM: cmd, NoDefaultCurrentDirectoryInExePath: "1" });
  assert.equal(s.windowsVerbatimArguments, true);
  assert.equal(s.killTree, true);
});

test("spawnSpec: everything else is spawned directly, unchanged", () => {
  assert.deepEqual(spawnSpec("C:\\mingw64\\bin\\clangd.exe", ["--background-index"], "win32"),
    { command: "C:\\mingw64\\bin\\clangd.exe", args: ["--background-index"] });
  assert.deepEqual(spawnSpec("/usr/local/bin/typescript-language-server", ["--stdio"], "darwin"),
    { command: "/usr/local/bin/typescript-language-server", args: ["--stdio"] });
});

/** The environment without NoDefaultCurrentDirectoryInExePath, which some shells (and CI
 * agents) already set; the tests must see what spawnSpec itself adds. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === "nodefaultcurrentdirectoryinexepath") delete env[k];
  return env;
}

/** Runs a spec (or, with `bare`, the same cmd.exe line minus spawnSpec's env) to completion
 * in `cwd`; resolves its output. */
function run(command: string, args: string[], cwd: string, bare = false): Promise<string> {
  const s = spawnSpec(command, args);
  return new Promise((resolve, reject) => {
    const env = bare ? { ...cleanEnv(), GRAFT_LSP_SHIM: command } : { ...cleanEnv(), ...s.env };
    const p = spawn(s.command, s.args, { cwd, stdio: ["ignore", "pipe", "pipe"], env, windowsVerbatimArguments: s.windowsVerbatimArguments });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("error", reject);
    p.on("close", () => resolve(out));
  });
}

test("Windows: a .cmd in a folder with spaces, %, & and ! in its name starts and gets its args", onWindows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft lsp "));
  try {
    const odd = join(dir, "100% & %USERNAME% !x");
    mkdirSync(odd);
    const cmd = join(odd, "fake-server.cmd");
    writeFileSync(cmd, "@echo off\r\necho started %*\r\n");
    assert.equal((await run(cmd, ["--stdio"], dir)).trim(), "started --stdio");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: a program planted in the repo folder isn't run in place of a bare command", onWindows, async () => {
  // npm's shim runs a bare `node` when there's no node.exe beside it; cmd.exe would look in
  // the cwd (the repo being mapped) first. Stand-in: the shim calls a bare `graftprobe`,
  // which exists only in the cwd.
  const dir = mkdtempSync(join(tmpdir(), "graft lsp "));
  try {
    const repo = join(dir, "repo");
    const bin = join(dir, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(join(repo, "graftprobe.cmd"), "@echo off\r\necho HIJACKED\r\n");
    const shim = join(bin, "fake-server.cmd");
    writeFileSync(shim, "@echo off\r\ngraftprobe\r\necho done\r\n");
    assert.ok((await run(shim, [], repo, true)).includes("HIJACKED"), "control: without the setting, cmd.exe does use the cwd");
    const out = await run(shim, [], repo);
    assert.ok(!out.includes("HIJACKED"), `the repo's graftprobe.cmd ran: ${out}`);
    assert.ok(out.includes("done"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: dispose stops a .cmd-launched server even when it ignores stdin closing", onWindows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft lsp "));
  try {
    const pidFile = join(dir, "server.pid");
    const server = join(dir, "server.js");
    writeFileSync(server, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e9);`);
    const shim = join(dir, "stubborn-server.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${server}"\r\n`);
    const client = new LspClient(shim, [], dir, "javascript");
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.ok(alive(), "the server started");
    await client.dispose();
    for (let i = 0; i < 60 && alive(); i++) await sleep(50);
    assert.equal(alive(), false, "the server behind cmd.exe was stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
