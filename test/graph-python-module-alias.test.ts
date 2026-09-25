/**
 * Python calls through an imported MODULE name.
 *
 * `from analysis import pump_signature as P` followed by `P.find_pumps()` is the
 * dominant call style in numeric Python codebases (numpy-style `import x as np`
 * generalised to the project's own modules). The extractor saw the receiver `P`,
 * found no type binding for it and — correctly, for an object of unknown class —
 * dropped the edge rather than guess. The result was `graft callers find_pumps`
 * reporting "no indexed callers" for a function called from a dozen sites.
 *
 * A module receiver is not an unknown object: the import statement names the
 * exact file. So the call resolves inside THAT file only, never globally — a
 * same-named function elsewhere in the repo must not become an edge (the last
 * test pins that). Four import spellings bind a local module name:
 *
 *   import pkg.mod as M          → M
 *   from pkg import mod as M     → M
 *   from pkg import mod          → mod
 *   import pkg.mod               → pkg.mod   (call spelled `pkg.mod.f()`)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const MOD = `def find_pumps(close):
    return close


def compute_all(x):
    return x
`;

/** A package whose __init__ is the module: \`from pkg import init_mod\` must reach it. */
const INIT_MOD = `def in_init():
    return 1
`;

/** Same-named function in an unrelated file: must never be the target. */
const DECOY = `def find_pumps(other):
    return other
`;

const CALLERS = `import pkg.mod as M
from pkg import mod as P
from pkg import mod
from pkg import init_mod
import pkg.mod


def via_import_as():
    return M.find_pumps(1)


def via_from_as():
    return P.find_pumps(2)


def via_from_plain():
    return mod.compute_all(3)


def via_dotted():
    return pkg.mod.compute_all(4)


def via_init():
    return init_mod.in_init()
`;

/** Receiver that is NOT a module: the drop rule must still hold. */
const UNKNOWN = `def use(obj):
    return obj.find_pumps(5)
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-pyalias-"));
  mkdirSync(join(dir, "pkg", "init_mod"), { recursive: true });
  writeFileSync(join(dir, "pkg", "__init__.py"), "");
  writeFileSync(join(dir, "pkg", "mod.py"), MOD);
  writeFileSync(join(dir, "pkg", "init_mod", "__init__.py"), INIT_MOD);
  writeFileSync(join(dir, "decoy.py"), DECOY);
  writeFileSync(join(dir, "callers.py"), CALLERS);
  writeFileSync(join(dir, "unknown.py"), UNKNOWN);
  return dir;
}

async function buildFixture(dir: string): Promise<GraphV1> {
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  return graph!;
}

function hasCall(graph: GraphV1, source: string, target: string): boolean {
  return graph.edges.some((e) => e.relation === "calls" && e.source === source && e.target === target);
}

test("Python: calls through an imported module name resolve into that module's file", async () => {
  const dir = makeFixture();
  try {
    const g = await buildFixture(dir);
    assert.ok(hasCall(g, "callers.py#via_import_as", "pkg/mod.py#find_pumps"), "import pkg.mod as M → M.f()");
    assert.ok(hasCall(g, "callers.py#via_from_as", "pkg/mod.py#find_pumps"), "from pkg import mod as P → P.f()");
    assert.ok(hasCall(g, "callers.py#via_from_plain", "pkg/mod.py#compute_all"), "from pkg import mod → mod.f()");
    assert.ok(hasCall(g, "callers.py#via_dotted", "pkg/mod.py#compute_all"), "import pkg.mod → pkg.mod.f()");
    assert.ok(hasCall(g, "callers.py#via_init", "pkg/init_mod/__init__.py#in_init"), "package module via __init__.py");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: a module-qualified call never resolves to a same-named function elsewhere", async () => {
  const dir = makeFixture();
  try {
    const g = await buildFixture(dir);
    const toDecoy = g.edges.filter((e) => e.relation === "calls" && e.target === "decoy.py#find_pumps");
    assert.deepEqual(toDecoy, [], "decoy.py#find_pumps must have no callers");
    // Unknown receiver: still dropped, not guessed (the #35 precision rule).
    const fromUnknown = g.edges.filter((e) => e.relation === "calls" && e.source === "unknown.py#use");
    assert.deepEqual(fromUnknown, [], "obj.find_pumps() on an untyped receiver stays unresolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
