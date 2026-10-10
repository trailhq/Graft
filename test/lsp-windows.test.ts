/**
 * `graft build --lsp` on Windows (#385): finding a server with `where.exe` (cmd.exe has no
 * `command -v`), skipping npm's extensionless sh script, and spawning npm's `.cmd` shims,
 * which Node refuses to start without a shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstRunnableWindowsPath } from "../src/graph/lsp/registry.js";
import { spawnSpec } from "../src/graph/lsp/client.js";

test("firstRunnableWindowsPath: npm's extensionless sh script is skipped for its .cmd shim", () => {
  const out = "C:\\Users\\A B\\AppData\\Roaming\\npm\\typescript-language-server\r\n"
    + "C:\\Users\\A B\\AppData\\Roaming\\npm\\typescript-language-server.cmd\r\n";
  assert.equal(firstRunnableWindowsPath(out), "C:\\Users\\A B\\AppData\\Roaming\\npm\\typescript-language-server.cmd");
});

test("firstRunnableWindowsPath: the first runnable match wins, in where.exe's PATH order", () => {
  assert.equal(firstRunnableWindowsPath("C:\\mingw64\\bin\\clangd.exe\r\nC:\\LLVM\\bin\\clangd.exe\r\n"), "C:\\mingw64\\bin\\clangd.exe");
  assert.equal(firstRunnableWindowsPath("C:\\tools\\gopls.EXE\n"), "C:\\tools\\gopls.EXE");
});

test("firstRunnableWindowsPath: nothing runnable → null", () => {
  assert.equal(firstRunnableWindowsPath(""), null);
  assert.equal(firstRunnableWindowsPath("C:\\npm\\pyright-langserver\r\n"), null);
});

test("spawnSpec: a .cmd/.bat on Windows runs through the shell as one quoted command line", () => {
  const cmd = "C:\\Users\\A B\\AppData\\Roaming\\npm\\typescript-language-server.cmd";
  assert.deepEqual(spawnSpec(cmd, ["--stdio"], "win32"), { command: `"${cmd}" --stdio`, args: [], shell: true });
  assert.deepEqual(spawnSpec("C:\\x\\run.BAT", [], "win32"), { command: '"C:\\x\\run.BAT"', args: [], shell: true });
});

test("spawnSpec: everything else is spawned directly, unchanged", () => {
  assert.deepEqual(spawnSpec("C:\\mingw64\\bin\\clangd.exe", ["--background-index"], "win32"),
    { command: "C:\\mingw64\\bin\\clangd.exe", args: ["--background-index"], shell: false });
  assert.deepEqual(spawnSpec("/usr/local/bin/typescript-language-server", ["--stdio"], "darwin"),
    { command: "/usr/local/bin/typescript-language-server", args: ["--stdio"], shell: false });
});

test("spawnSpec: a .cmd in a folder with a space actually starts and gets its args (Windows only)", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft lsp "));
  try {
    const cmd = join(dir, "fake-server.cmd");
    writeFileSync(cmd, "@echo off\r\necho started %*\r\n");
    const s = spawnSpec(cmd, ["--stdio"]);
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(s.command, s.args, { stdio: ["ignore", "pipe", "pipe"], shell: s.shell });
      let text = "";
      p.stdout.on("data", (d) => { text += d; });
      p.on("error", reject);
      p.on("close", () => resolve(text));
    });
    assert.equal(out.trim(), "started --stdio");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
