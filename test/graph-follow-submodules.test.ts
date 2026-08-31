import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isClean, probeDrift } from "../src/graph/fingerprint.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { callTool } from "../src/mcp/tools.js";
import { readBuildConfig } from "../src/util/state.js";
import type { GraphV1 } from "../src/graph/types.js";
import { runCli, tmpRepo } from "./helpers.js";

function gitRun(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function commitAll(root: string, message: string): void {
  gitRun(root, ["add", "-A"]);
  gitRun(root, [
    "-c", "user.name=Graft Tests",
    "-c", "user.email=graft-tests@example.invalid",
    "commit", "-qm", message,
  ]);
}

function graphOf(root: string): GraphV1 {
  const graph = readGraph(wiringPath(join(root, "graft")));
  assert.ok(graph, `expected a graph for ${root}`);
  return graph;
}

function expectCliOk(args: string[]): void {
  const result = runCli(args);
  assert.equal(result.status, 0, result.describe());
}

test("follow-submodules is opt-in, persisted for MCP refresh, and explicitly reversible (#74)", async () => {
  const parent = tmpRepo("follow-submodules-parent");
  const child = tmpRepo("follow-submodules-child");
  try {
    gitRun(child, ["init", "-q"]);
    mkdirSync(join(child, "src"), { recursive: true });
    writeFileSync(
      join(child, "src", "sub.ts"),
      "export function subValue(): number { return 1; }\n",
    );
    commitAll(child, "child fixture");

    gitRun(parent, ["init", "-q"]);
    mkdirSync(join(parent, "src"), { recursive: true });
    mkdirSync(join(parent, "build"), { recursive: true });
    writeFileSync(join(parent, "src", "root.ts"), "export const rootValue = 1;\n");
    writeFileSync(
      join(parent, "build", "local.ts"),
      "export function localBuildValue(): number { return 1; }\n",
    );
    commitAll(parent, "parent fixture");
    gitRun(parent, [
      "-c", "protocol.file.allow=always",
      "submodule", "add", "-q", child.replace(/\\/g, "/"), "modules/child",
    ]);
    commitAll(parent, "add child submodule");

    expectCliOk(["build", parent]);
    const defaultGraph = graphOf(parent);
    assert.ok(defaultGraph.nodes.some((node) => node.path === "src/root.ts"));
    assert.ok(!defaultGraph.nodes.some((node) => node.path.startsWith("modules/child/")));
    assert.ok(!defaultGraph.nodes.some((node) => node.path.startsWith("build/")));
    assert.equal(
      existsSync(join(parent, ".graft", "config.json")),
      false,
      "an implicit default must not create local config",
    );

    expectCliOk(["build", parent, "--follow-submodules", "--include-dir", "build"]);
    const enabled = graphOf(parent);
    assert.ok(enabled.nodes.some((node) => node.id === "modules/child/src/sub.ts#subValue"));
    assert.ok(enabled.nodes.some((node) => node.id === "build/local.ts#localBuildValue"));
    assert.deepEqual(readBuildConfig(parent), {
      includeDirs: ["build"],
      followSubmodules: true,
    });
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    expectCliOk(["build", parent]);
    assert.ok(
      graphOf(parent).nodes.some((node) => node.id === "modules/child/src/sub.ts#subValue"),
      "a no-flag build must retain the persisted opt-in",
    );

    const childCheckout = join(parent, "modules", "child", "src", "sub.ts");
    writeFileSync(
      childCheckout,
      "export function changedSubValue(): number { return 2; }\n",
    );
    const mcp = await callTool(parent, "graft_file_api", {
      file: "modules/child/src/sub.ts",
    });
    assert.equal(mcp.isError, false, mcp.text);
    assert.match(mcp.text, /^\[graft\] refreshed the graph/);
    assert.match(mcp.text, /changedSubValue/);
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    expectCliOk(["build", parent, "--no-follow-submodules"]);
    const disabled = graphOf(parent);
    assert.ok(!disabled.nodes.some((node) => node.path.startsWith("modules/child/")));
    assert.ok(
      disabled.nodes.some((node) => node.id === "build/local.ts#localBuildValue"),
      "updating the submodule choice must preserve includeDirs",
    );
    assert.deepEqual(readBuildConfig(parent), {
      includeDirs: ["build"],
      followSubmodules: false,
    });
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    writeFileSync(
      childCheckout,
      "export function ignoredAfterDisable(): number { return 3; }\n",
    );
    assert.ok(
      isClean(probeDrift(parent, join(parent, "graft"))!),
      "disabled child edits must not trigger automatic refresh",
    );

    expectCliOk(["build", parent]);
    const persistedDisabled = graphOf(parent);
    assert.ok(!persistedDisabled.nodes.some((node) => node.path.startsWith("modules/child/")));
    assert.ok(persistedDisabled.nodes.some((node) => node.id === "build/local.ts#localBuildValue"));
    assert.deepEqual(readBuildConfig(parent), {
      includeDirs: ["build"],
      followSubmodules: false,
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});
