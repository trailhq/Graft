import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { writeWorkspace } from "../src/graph/workspace.js";
import { TOOLS, callTool } from "../src/mcp/tools.js";

test("cycles CLI refreshes the graph and matches the listed MCP tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-cycles-cli-"));
  const pkg = join(dir, "pkg");
  const expected = [
    "Cycle 1 · 2 files",
    "  pkg/a.py:2 imports → pkg/b.py [lazy]",
    "  pkg/b.py:1 imports → pkg/a.py",
    "",
  ].join("\n");
  try {
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "__init__.py"), "");
    writeFileSync(join(pkg, "a.py"), "def load():\n    return None\n");
    writeFileSync(join(pkg, "b.py"), "import pkg.a\n");
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "build", dir], { stdio: "pipe" });

    writeFileSync(join(pkg, "a.py"), "def load():\n    import pkg.b\n");
    const cli = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "cycles", dir], {
      encoding: "utf8",
    });
    const mcp = await callTool(dir, "graft_find_import_cycles", {});

    assert.deepEqual(
      {
        cli: { status: cli.status, stdout: cli.stdout },
        listed: TOOLS.some((tool) => tool.name === "graft_find_import_cycles"),
        mcp,
      },
      {
        cli: { status: 0, stdout: expected },
        listed: true,
        mcp: { text: expected, isError: false },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cycles CLI federates every child graph from a workspace parent", async () => {
  const parent = mkdtempSync(join(tmpdir(), "graft-cycles-workspace-"));
  const children = ["repoA", "repoB"];
  try {
    for (const child of children) {
      const childDir = join(parent, child);
      const pkg = join(childDir, "pkg");
      mkdirSync(join(childDir, ".git"), { recursive: true });
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "__init__.py"), "");
      writeFileSync(join(pkg, "a.py"), "import pkg.b\n");
      writeFileSync(join(pkg, "b.py"), "import pkg.a\n");
      await buildGraph(childDir);
    }
    writeWorkspace(parent, { version: 1, children });

    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "cycles", "--no-refresh", parent],
      { encoding: "utf8" },
    );

    assert.deepEqual(
      { status: cli.status, stdout: cli.stdout, stderr: cli.stderr },
      {
        status: 0,
        stdout: [
          "## repoA/",
          "Cycle 1 · 2 files",
          "  pkg/a.py:1 imports → pkg/b.py",
          "  pkg/b.py:1 imports → pkg/a.py",
          "",
          "## repoB/",
          "Cycle 1 · 2 files",
          "  pkg/a.py:1 imports → pkg/b.py",
          "  pkg/b.py:1 imports → pkg/a.py",
          "",
        ].join("\n"),
        stderr: "",
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
