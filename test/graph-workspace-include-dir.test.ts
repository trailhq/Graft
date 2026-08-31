/**
 * A5 (V4) — a workspace build's `--include-dir` must reach the children.
 *
 * `runWorkspaceBuild` builds each child through its own `Graft` engine
 * (`workspace-cli.ts`), then `splitWorkspace` replaces the PARENT's generated
 * `graft/` with `workspace.json`.
 * Without threading the CLI's `--include-dir` value into
 * `runWorkspaceBuild`/`buildChild`, a workspace build had no way to see it —
 * children are independent repos with their own graft state, so the fix
 * persists the include list in EACH CHILD's own state too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkspaceBuild } from "../src/graph/workspace-cli.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { readBuildConfig, writeBuildConfig } from "../src/util/state.js";
import type { GraphV1 } from "../src/graph/types.js";

function workspaceWithBuildDirs(): string {
  const parent = mkdtempSync(join(tmpdir(), "ws-include-dir-"));
  for (const child of ["repoA", "repoB"]) {
    mkdirSync(join(parent, child, ".git"), { recursive: true });
    mkdirSync(join(parent, child, "build"), { recursive: true });
    writeFileSync(join(parent, child, "build", "util.ts"), "export function fromBuild(): number {\n  return 1;\n}\n");
    writeFileSync(join(parent, child, "main.ts"), "export function main(): number {\n  return 2;\n}\n");
  }
  return parent;
}

function graphOf(childDir: string): GraphV1 | null {
  return readGraph(wiringPath(join(childDir, "graft")));
}

test("A5: --include-dir on a workspace build reaches every child, which persists it for a later no-flag rebuild", async () => {
  const parent = workspaceWithBuildDirs();
  try {
    await runWorkspaceBuild(parent, {
      deep: false,
      childConfig: {},
      includeDirs: ["build"],
      followSubmodules: true,
    });

    for (const child of ["repoA", "repoB"]) {
      const g = graphOf(join(parent, child));
      assert.ok(g, `expected a built graph for ${child}`);
      assert.ok(
        g!.nodes.some((n) => n.id === "build/util.ts#fromBuild"),
        `${child}'s build/ file must be indexed with --include-dir`,
      );
      assert.deepEqual(readBuildConfig(join(parent, child)), {
        includeDirs: ["build"],
        followSubmodules: true,
      });
    }

    // A later no-flag rebuild of a single child (never sees the parent's CLI
    // invocation at all, let alone its flags) must still include build/ —
    // proof the child persisted the override in ITS OWN state.
    await buildGraph(join(parent, "repoA"));
    const rebuilt = graphOf(join(parent, "repoA"));
    assert.ok(rebuilt);
    assert.ok(
      rebuilt!.nodes.some((n) => n.id === "build/util.ts#fromBuild"),
      "child's own persisted include-dir state must survive a no-flag rebuild",
    );

    await runWorkspaceBuild(parent, {
      deep: false,
      childConfig: {},
      followSubmodules: false,
    });
    for (const child of ["repoA", "repoB"]) {
      assert.deepEqual(readBuildConfig(join(parent, child)), {
        includeDirs: ["build"],
        followSubmodules: false,
      });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("A5: a skipped-name workspace child remains discoverable on a later no-flag rebuild", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ws-include-child-"));
  try {
    for (const child of ["app", "build"]) {
      mkdirSync(join(parent, child, ".git"), { recursive: true });
      writeFileSync(join(parent, child, "main.ts"), `export const ${child}Value = 1;\n`);
    }

    writeBuildConfig(parent, { includeDirs: ["build"] });
    await runWorkspaceBuild(parent, { deep: false, childConfig: {}, includeDirs: ["build"] });
    await runWorkspaceBuild(parent, { deep: false, childConfig: {} });

    const workspace = JSON.parse(readFileSync(join(parent, "graft", "workspace.json"), "utf8")) as { children: string[] };
    assert.deepEqual(workspace.children, ["app", "build"]);
    assert.equal(readFileSync(join(parent, ".graft", "config.json"), "utf8").includes("build"), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
