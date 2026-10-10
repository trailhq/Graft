/**
 * `graft build --lsp` on Windows (#385): finding a server on PATH without `where.exe`
 * (cmd.exe has no `command -v`, and `where` also searches the current folder), skipping
 * npm's extensionless sh script, and starting npm's `.cmd` shims, which Node refuses to
 * spawn without a shell: their JavaScript entry point runs with Node directly, so the
 * repo being mapped can't supply `node` and odd install paths don't break the launch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOnWindowsPath } from "../src/graph/lsp/registry.js";
import { npmShimEntry, spawnSpec, LspClient } from "../src/graph/lsp/client.js";

const onWindows = { skip: process.platform !== "win32" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Windows keeps a just-killed process's hold on its cwd for a moment: retry the cleanup. */
async function removeDir(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) { if (i >= 40) throw e; await sleep(100); }
  }
}

/** What npm (cmd-shim) writes for a bin: the current format. */
const npmShim = (entry: string) => [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`, "",
].join("\r\n");

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

test("npmShimEntry: the entry point of npm's shim, current and older formats", () => {
  const shim = "C:\\Users\\A B\\AppData\\Roaming\\npm\\typescript-language-server.cmd";
  assert.equal(npmShimEntry(shim, npmShim("node_modules\\typescript-language-server\\lib\\cli.mjs")),
    "C:\\Users\\A B\\AppData\\Roaming\\npm\\node_modules\\typescript-language-server\\lib\\cli.mjs");
  assert.equal(npmShimEntry("C:\\p\\node_modules\\.bin\\tsx.cmd", npmShim("..\\tsx\\dist\\cli.mjs")), "C:\\p\\node_modules\\tsx\\dist\\cli.mjs");
  const older = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\pyright\\langserver.index.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\pyright\\langserver.index.js" %*\r\n)\r\n';
  assert.equal(npmShimEntry("C:\\npm\\pyright-langserver.cmd", older), "C:\\npm\\node_modules\\pyright\\langserver.index.js");
});

test("npmShimEntry: not an npm shim → null", () => {
  assert.equal(npmShimEntry("C:\\x\\run.cmd", "@echo off\r\nC:\\tools\\server.exe %*\r\n"), null);
  assert.equal(npmShimEntry("C:\\x\\run.cmd", ""), null);
});

test("spawnSpec: an npm shim runs its entry point with Node directly, preferring the node.exe beside it", () => {
  const shim = "C:\\npm\\typescript-language-server.cmd";
  const read = () => npmShim("node_modules\\typescript-language-server\\lib\\cli.mjs");
  const entry = "C:\\npm\\node_modules\\typescript-language-server\\lib\\cli.mjs";
  assert.deepEqual(spawnSpec(shim, ["--stdio"], "win32", read, () => false), { command: process.execPath, args: [entry, "--stdio"] });
  assert.deepEqual(spawnSpec(shim, ["--stdio"], "win32", read, (p) => p === "C:\\npm\\node.exe"), { command: "C:\\npm\\node.exe", args: [entry, "--stdio"] });
});

test("spawnSpec: everything else is spawned exactly as before", () => {
  const no = () => { throw new Error("must not read"); };
  assert.deepEqual(spawnSpec("C:\\mingw64\\bin\\clangd.exe", ["--background-index"], "win32", no), { command: "C:\\mingw64\\bin\\clangd.exe", args: ["--background-index"] });
  assert.deepEqual(spawnSpec("C:\\x\\run.cmd", [], "win32", () => "@echo off\r\nserver.exe\r\n"), { command: "C:\\x\\run.cmd", args: [] }, "a non-npm .cmd");
  assert.deepEqual(spawnSpec("C:\\x\\gone.cmd", [], "win32", () => { throw new Error("ENOENT"); }), { command: "C:\\x\\gone.cmd", args: [] }, "unreadable");
  assert.deepEqual(spawnSpec("/usr/local/bin/typescript-language-server", ["--stdio"], "darwin", no), { command: "/usr/local/bin/typescript-language-server", args: ["--stdio"] });
});

/** A fake npm install of `bin` under `prefix`: the real shim format, running `script`. */
function fakeNpmBin(prefix: string, bin: string, script: string): string {
  const pkg = join(prefix, "node_modules", bin);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "cli.js"), script);
  const shim = join(prefix, `${bin}.cmd`);
  writeFileSync(shim, npmShim(`node_modules\\${bin}\\cli.js`));
  return shim;
}

test("Windows: an npm shim under a prefix with & % ^ ! starts, gets its args, and the repo can't supply node", onWindows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft lsp "));
  try {
    const prefix = join(dir, "npm & 100% ^ !x");
    const shim = fakeNpmBin(prefix, "fake-server", 'console.log("started " + process.argv.slice(2).join(" "))');
    const repo = join(dir, "repo");
    mkdirSync(repo);
    // A planted `node`: a .cmd for cmd.exe's lookup, and a node.exe (any harmless program;
    // it just mustn't be what runs) for a bare spawn("node").
    writeFileSync(join(repo, "node.cmd"), "@echo off\r\necho HIJACKED\r\n");
    copyFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), join(repo, "node.exe"));
    const s = spawnSpec(shim, ["--stdio"]);
    const env = { ...process.env, PATH: `.;${process.env.PATH}` }; // even with "." on PATH
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(s.command, s.args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      p.stdout.on("data", (d) => { text += d; });
      p.stderr.on("data", (d) => { text += d; });
      p.on("error", reject);
      p.on("close", () => resolve(text));
    });
    assert.equal(out.trim(), "started --stdio");
  } finally {
    await removeDir(dir);
  }
});

test("Windows: dispose stops an npm-shim server that ignores stdin closing", onWindows, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft lsp "));
  try {
    const pidFile = join(dir, "server.pid");
    const shim = fakeNpmBin(join(dir, "npm"), "stubborn-server",
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e9);`);
    const client = new LspClient(shim, [], dir, "javascript");
    let pid = 0;
    try {
      for (let i = 0; i < 100 && !pid; i++) { await sleep(50); if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, "utf8")); }
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      assert.ok(pid && alive(), "the server started");
      await client.dispose();
      for (let i = 0; i < 60 && alive(); i++) await sleep(50);
      assert.equal(alive(), false, "the server was stopped");
    } finally {
      await client.dispose();
    }
  } finally {
    await removeDir(dir);
  }
});
