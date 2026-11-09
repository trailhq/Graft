/**
 * A3 — mint-time unique node ids.
 *
 * extract.ts used to mint a node's id purely from its scope + own name, so two
 * definitions that happen to share a name (a branch-guarded redeclaration, a
 * duplicated class, ...) collided onto the SAME id — the second definition's
 * node silently overwrote the first's in every id-keyed lookup.
 *
 * `walk()` now mints ids against a per-file `minted` Set via the extracted
 * `mintId(base, minted)` helper: the first occurrence keeps its bare id, and
 * every later document-order duplicate gets the next free `~2`, `~3`, ...
 * suffix — collision-proof even against a source name that itself ends in
 * `~N` (which would collide with a single-guess `~2` suffix), because the
 * loop keeps incrementing until it finds a truly free id rather than trusting
 * one guessed candidate.
 *
 * These tests assert the ACTUAL minted ids (not a guessed shape) — the hard
 * invariants are: every id unique, the first occurrence keeps the bare id, and
 * ordinals follow document order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile, mintId } from "../src/graph/extract.js";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";

// extractFile is synchronous; its WASM grammars load once, up front.
await warmDepthGrammars(["typescript", "python", "go"]);

function assertUniqueIds(nodes: { id: string }[], label: string): void {
  const ids = nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: every node id must be unique, got ${JSON.stringify(ids)}`);
}

test("A3 mintId: the while-loop finds the next truly free ordinal, not a single-guess ~2", () => {
  // Pre-seeding both the bare id AND its ~2 ordinal simulates two prior mints
  // (occurrences 1 and 2) already having claimed them; a THIRD occurrence of
  // the same base must skip the taken ~2 and land on ~3 — proving the loop
  // (not a single `~2` guess) is what finds a truly free id.
  const base = "dup.ts#helper";
  const minted = new Set<string>([base, `${base}~2`]);
  const id = mintId(base, minted);
  assert.equal(id, `${base}~3`, "the third occurrence must land on ~3, skipping the already-taken ~2");
  assert.ok(minted.has(`${base}~3`));
});

test("A3 mintId: an unclaimed base id is returned bare (no suffix) and gets added to the set", () => {
  const minted = new Set<string>();
  const id = mintId("solo.ts#f", minted);
  assert.equal(id, "solo.ts#f");
  assert.ok(minted.has("solo.ts#f"));
});

test("A3 ts: branch-guarded duplicate function + duplicate class w/ method mint distinct, unique ids", () => {
  const src = `
if (true) {
  function f() { return 1; }
} else {
  function f() { return 2; }
}

class C {
  m(): void {}
}
class C {
  m(): void {}
}
`;
  const { nodes } = extractFile("mix.ts", src, "typescript");
  assertUniqueIds(nodes, "ts dup fn/class");

  const ids = nodes.map((n) => n.id);
  // Document order: first `f` bare, second gets ~2; same for the two `C` classes.
  assert.deepEqual(
    ids,
    ["mix.ts", "mix.ts#f", "mix.ts#f~2", "mix.ts#C", "mix.ts#C.m", "mix.ts#C~2", "mix.ts#C.m~2"],
  );
});

test("A3 py: duplicate def + duplicate class/method mint distinct, unique ids", () => {
  const src = `
def f():
    return 1

def f():
    return 2

class C:
    def m(self):
        pass

class C:
    def m(self):
        pass
`;
  const { nodes } = extractFile("dup.py", src, "python");
  assertUniqueIds(nodes, "py dup def/class");

  const ids = nodes.map((n) => n.id);
  assert.deepEqual(
    ids,
    ["dup.py", "dup.py#f", "dup.py#f~2", "dup.py#C", "dup.py#C.m", "dup.py#C~2", "dup.py#C.m~2"],
  );
});

test("A3 go: two same-name methods on one receiver mint distinct, unique ids", () => {
  const src = `package pkg

type Worker struct{}

func (w *Worker) Run() {}
func (w *Worker) Run() {}
`;
  const { nodes } = extractFile("dup.go", src, "go");
  assertUniqueIds(nodes, "go dup receiver method");

  const ids = nodes.map((n) => n.id);
  assert.deepEqual(ids, ["dup.go", "dup.go#Worker", "dup.go#Worker.Run", "dup.go#Worker.Run~2"]);
});
