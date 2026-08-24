/**
 * Tests for Python constructor call edges in the Tier-1 code graph.
 *
 * Python spells construction as an ordinary call — `Widget()`, with no `new` to
 * mark it — so a constructor edge reaches the resolver indistinguishable from a
 * function call. Resolved against the function-only index it vanishes, and
 * `graft callers <SomeClass>` reports "no indexed callers" on a class every file
 * in the repo instantiates. That is the same failure `graph-java.test.ts` pins
 * for `new Foo()`, in the language where it is invisible.
 *
 * The fix is a fallback, not a swap: unlike Java, Python HAS free functions, so
 * resolving bare calls against types outright would trade real function edges
 * away. Functions are matched first and unchanged; types are tried only when
 * that finds nothing.
 *
 * The last two tests pin that ordering and the drop rule, because a fallback
 * that fires too eagerly is worse than the missing edge. Both are written as
 * negative assertions — bare-call resolution does not read import bindings
 * today, so pinning which target it picks would freeze that limitation into the
 * suite. What must hold under any implementation is that the fallback stays
 * silent while a function matches, and never guesses between two same-named
 * classes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const THING = `class Widget:
    def run(self):
        return 1


def helper():
    return 2
`;

const MAIN = `from pkg.thing import Widget, helper


def build():
    w = Widget()
    return w.run() + helper()
`;

/** `Thing` is a function here and a class in `dup_class.py` — the function must win. */
const DUAL_FN = `def Thing():
    return 1
`;

const DUAL_CLASS = `class Thing:
    pass
`;

/** `Dup` is a class in two files. `dup_a.py` is the copy `caller.py` does NOT
 * import, and it sorts first — so an implementation that takes the first global
 * candidate instead of requiring a unique one picks it, and test 4 catches that. */
const DUP_A = `class Dup:
    pass
`;

const DUP_B = `class Dup:
    pass
`;

const CALLER = `from dual_fn import Thing
from dup_z import Dup


def use_thing():
    return Thing()


def use_dup():
    return Dup()
`;

/** Construction in the file that declares the class — a same-file, `extracted` edge. */
const LOCAL = `class Local:
    pass


def make():
    return Local()
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-python-"));
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "__init__.py"), "");
  writeFileSync(join(dir, "pkg", "thing.py"), THING);
  writeFileSync(join(dir, "main.py"), MAIN);
  writeFileSync(join(dir, "dual_fn.py"), DUAL_FN);
  writeFileSync(join(dir, "dup_class.py"), DUAL_CLASS);
  writeFileSync(join(dir, "dup_a.py"), DUP_A);
  writeFileSync(join(dir, "dup_z.py"), DUP_B);
  writeFileSync(join(dir, "caller.py"), CALLER);
  writeFileSync(join(dir, "local.py"), LOCAL);
  return dir;
}

async function buildFixture(dir: string): Promise<GraphV1> {
  await buildGraph(dir); // $0, Tier-1 only
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "wiring graph should be written");
  return graph!;
}

test("Python: `Widget()` produces a constructor edge to the class", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const calls = graph.edges.filter((e) => e.relation === "calls");

    assert.ok(
      calls.some((e) => e.source === "main.py#build" && e.target === "pkg/thing.py#Widget"),
      "build should have a constructor edge to Widget",
    );

    // The existing function path is untouched: a plain call still resolves.
    assert.ok(
      calls.some((e) => e.source === "main.py#build" && e.target === "pkg/thing.py#helper"),
      "build should still call helper",
    );

    // And the receiver bound by `w = Widget()` still reaches the method.
    assert.ok(
      calls.some((e) => e.source === "main.py#build" && e.target === "pkg/thing.py#Widget.run"),
      "build should call Widget.run through the constructor-assigned receiver",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: same-file construction resolves as an extracted edge", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const edge = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "local.py#make" && e.target === "local.py#Local",
    );
    assert.ok(edge, "make should have a constructor edge to Local");
    assert.equal(edge!.confidence, "extracted", "a same-file target is certain, not inferred");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: the fallback stays silent when a function of that name matches", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const targets = graph.edges
      .filter((e) => e.relation === "calls" && e.source === "caller.py#use_thing")
      .map((e) => e.target);

    // `caller.py` imports the FUNCTION `Thing`, and a function match means the
    // fallback never runs — so the class of the same name must not be linked.
    assert.ok(targets.includes("dual_fn.py#Thing"), "Thing() should resolve to the imported function");
    assert.ok(
      !targets.includes("dup_class.py#Thing"),
      "the same-named class must not be linked — the fallback fires only when no function matches",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python: an ambiguous class name is never guessed at", async () => {
  const dir = makeFixture();
  try {
    const graph = await buildFixture(dir);
    const targets = graph.edges
      .filter((e) => e.relation === "calls" && e.source === "caller.py#use_dup")
      .map((e) => e.target);

    // `Dup` is declared in two files. Today resolveName finds two global
    // candidates and drops, which is correct-by-omission; an import-aware
    // resolver would instead pick `dup_z`, the one `caller.py` imports. Both are
    // acceptable — picking `dup_a`, the one it does not import, never is.
    assert.ok(
      !targets.includes("dup_a.py#Dup"),
      "a class the caller never imported must never be guessed at",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
