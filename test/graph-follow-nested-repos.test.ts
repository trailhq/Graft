import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isClean, probeDrift } from "../src/graph/fingerprint.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
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

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/**
 * A multi-repo manifest checkout clones dependencies into the parent tree as
 * ORDINARY repos, with no gitlink and no index entry — so `followSubmodules`
 * can never reach them. Built here with a plain `git init` inside the parent.
 */
test("follow-nested-repos is opt-in, persisted, reversible, and does not mistake a plain untracked dir for a repo", () => {
  const parent = tmpRepo("follow-nested-parent");
  try {
    gitRun(parent, ["init", "-q"]);
    write(parent, "src/root.ts", "export const rootValue = 1;\n");
    // A plain untracked directory: git expands it file by file, so it must NOT
    // trip the trailing-slash heuristic. This is the regression guard.
    write(parent, "plain/a.ts", "export const plainValue = 1;\n");
    write(parent, "plain/deep/b.ts", "export const deepPlainValue = 1;\n");
    // A directory that looks like a checkout but has no .git — must be skipped,
    // not recursed. Git expands it too (it is not a repo), so its files land in
    // the graph the ordinary way.
    write(parent, "external/not_a_repo/c.ts", "export const notARepoValue = 1;\n");
    commitAll(parent, "parent fixture");

    // Two nested clones, the second importing from the first — the cross-repo
    // edge is the whole point of folding them into ONE graph rather than
    // federating them into N disjoint ones.
    const depA = join(parent, "external", "dep_a");
    mkdirSync(depA, { recursive: true });
    gitRun(depA, ["init", "-q"]);
    write(depA, "src/api.ts", "export function depAValue(): number { return 1; }\n");
    write(depA, "build/generated.ts", "export const generatedValue = 1;\n");
    commitAll(depA, "dep_a fixture");

    const depB = join(parent, "external", "dep_b");
    mkdirSync(depB, { recursive: true });
    gitRun(depB, ["init", "-q"]);
    write(
      depB,
      "src/consumer.ts",
      'import { depAValue } from "../../dep_a/src/api.js";\n' +
        "export function depBValue(): number { return depAValue(); }\n",
    );
    commitAll(depB, "dep_b fixture");

    // 1. Default build excludes both nested clones and keeps everything else.
    expectCliOk(["build", parent]);
    const def = graphOf(parent);
    assert.ok(def.nodes.some((n) => n.path === "src/root.ts"));
    assert.ok(def.nodes.some((n) => n.path === "plain/a.ts"), "a plain untracked dir must still be expanded");
    assert.ok(def.nodes.some((n) => n.path === "plain/deep/b.ts"));
    assert.ok(def.nodes.some((n) => n.path === "external/not_a_repo/c.ts"));
    assert.ok(!def.nodes.some((n) => n.path.startsWith("external/dep_a/")));
    assert.ok(!def.nodes.some((n) => n.path.startsWith("external/dep_b/")));
    assert.equal(
      existsSync(join(parent, ".graft", "config.json")),
      false,
      "an implicit default must not create local config",
    );

    // 2. Opt in: both clones are indexed, into the SAME graph, and the choice
    //    is persisted. SKIP_DIRS still applies inside the child (build/).
    expectCliOk(["build", parent, "--follow-nested-repos"]);
    const enabled = graphOf(parent);
    assert.ok(enabled.nodes.some((n) => n.id === "external/dep_a/src/api.ts#depAValue"));
    assert.ok(enabled.nodes.some((n) => n.id === "external/dep_b/src/consumer.ts#depBValue"));
    assert.ok(
      !enabled.nodes.some((n) => n.path.startsWith("external/dep_a/build/")),
      "SKIP_DIRS must still apply inside a followed nested repo",
    );
    assert.deepEqual(readBuildConfig(parent), { followNestedRepos: true });
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    // 3. The cross-repo edge: one graph, so dep_b's import resolves into dep_a.
    assert.ok(
      enabled.edges.some(
        (e) =>
          e.relation === "imports" &&
          e.source === "external/dep_b/src/consumer.ts" &&
          e.target === "external/dep_a/src/api.ts",
      ),
      "an import crossing two nested repos must resolve to an in-graph edge",
    );

    // 4. A later no-flag rebuild retains the opt-in — the contract the
    //    fingerprint probe and the MCP refresh path depend on.
    expectCliOk(["build", parent]);
    assert.ok(
      graphOf(parent).nodes.some((n) => n.id === "external/dep_a/src/api.ts#depAValue"),
      "a no-flag build must retain the persisted opt-in",
    );

    // 5. Explicitly reversible, and likewise persisted.
    expectCliOk(["build", parent, "--no-follow-nested-repos"]);
    assert.ok(!graphOf(parent).nodes.some((n) => n.path.startsWith("external/dep_a/")));
    assert.deepEqual(readBuildConfig(parent), { followNestedRepos: false });
    assert.ok(isClean(probeDrift(parent, join(parent, "graft"))!));

    expectCliOk(["build", parent]);
    assert.ok(!graphOf(parent).nodes.some((n) => n.path.startsWith("external/dep_a/")));
    assert.deepEqual(readBuildConfig(parent), { followNestedRepos: false });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/** The two opt-ins are independent: neither implies the other. */
test("follow-nested-repos and follow-submodules are independent switches", () => {
  const parent = tmpRepo("follow-nested-mixed-parent");
  const sub = tmpRepo("follow-nested-mixed-sub");
  try {
    gitRun(sub, ["init", "-q"]);
    write(sub, "src/sub.ts", "export function subValue(): number { return 1; }\n");
    commitAll(sub, "submodule fixture");

    gitRun(parent, ["init", "-q"]);
    write(parent, "src/root.ts", "export const rootValue = 1;\n");
    commitAll(parent, "parent fixture");
    gitRun(parent, [
      "-c", "protocol.file.allow=always",
      "submodule", "add", "-q", sub.replace(/\\/g, "/"), "modules/sub",
    ]);
    commitAll(parent, "add submodule");

    const nested = join(parent, "external", "dep");
    mkdirSync(nested, { recursive: true });
    gitRun(nested, ["init", "-q"]);
    write(nested, "src/dep.ts", "export function depValue(): number { return 1; }\n");
    commitAll(nested, "nested fixture");

    // Nested only: the gitlink stays outside the boundary.
    expectCliOk(["build", parent, "--follow-nested-repos"]);
    const nestedOnly = graphOf(parent);
    assert.ok(nestedOnly.nodes.some((n) => n.id === "external/dep/src/dep.ts#depValue"));
    assert.ok(!nestedOnly.nodes.some((n) => n.path.startsWith("modules/sub/")));

    // Submodules only: the nested clone stays outside the boundary.
    expectCliOk(["build", parent, "--no-follow-nested-repos", "--follow-submodules"]);
    const g = graphOf(parent);
    assert.ok(g.nodes.some((n) => n.id === "modules/sub/src/sub.ts#subValue"));
    assert.ok(!g.nodes.some((n) => n.path.startsWith("external/dep/")));
    assert.deepEqual(readBuildConfig(parent), {
      followNestedRepos: false,
      followSubmodules: true,
    });

    // Both: one graph spanning both kinds of boundary.
    expectCliOk(["build", parent, "--follow-nested-repos"]);
    const both = graphOf(parent);
    assert.ok(both.nodes.some((n) => n.id === "modules/sub/src/sub.ts#subValue"));
    assert.ok(both.nodes.some((n) => n.id === "external/dep/src/dep.ts#depValue"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});
