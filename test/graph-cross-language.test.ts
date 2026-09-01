/**
 * A call never crosses a language boundary.
 *
 * Name resolution is repo-wide: when a bare call has nothing local to bind to,
 * `resolveName` accepts a unique match anywhere in the repo. That fallback was
 * language-blind, and the failure it produced was not subtle. In a real polyglot
 * repository (Go backend + TypeScript frontend) a frontend test file defined a
 * helper named `make`. Go's `make` is a builtin, so every `make(map[...])` and
 * `make(chan ...)` in the backend had nothing to resolve against — and matched
 * that helper, because it was the only symbol named `make` in the repo.
 *
 * The result: 1040 in-edges into one test file, spread across 476 files, and any
 * pull request touching that file reported the whole backend as its blast radius.
 *
 * The uniqueness rule is what made it fire, so the guard cannot live there — a
 * rarer collision was a *more* confident wrong answer. It has to be the language.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEdges } from "../src/graph/resolve.js";
import type { NodeV1 } from "../src/graph/types.js";

function n(id: string, kind: NodeV1["kind"]): NodeV1 {
  const post = id.includes("#") ? id.split("#")[1] : id;
  const segs = post.split(".");
  const name = segs[segs.length - 1];
  const owner = kind === "method" && segs.length >= 2 ? segs[segs.length - 2] : undefined;
  return {
    id, name, kind, owner, path: id.split("#")[0], span: "L1-L1", signature: null,
    exported: true, origin: "ast", body_hash: "h", summary_state: "pending", summary: null, crux: null,
  } as NodeV1;
}

const calls = (edges: ReturnType<typeof resolveEdges>): string[] =>
  edges.filter((e) => e.relation === "calls").map((e) => e.target);

test("cross-language: a Go builtin does not resolve to a TypeScript helper", () => {
  // Exactly the shape found in the wild — `make` exists only in a frontend test.
  const nodes = [
    n("backend/internal/evals/artifact_renderer.go", "file"),
    n("backend/internal/evals/artifact_renderer.go#renderXLSX", "function"),
    n("frontend/src/hooks/queries/useDraftDiffFiles.test.ts", "file"),
    n("frontend/src/hooks/queries/useDraftDiffFiles.test.ts#make", "function"),
  ];

  const edges = resolveEdges(nodes, [
    {
      source: "backend/internal/evals/artifact_renderer.go#renderXLSX",
      relation: "calls",
      name: "make",
      file: "backend/internal/evals/artifact_renderer.go",
    },
  ]);

  assert.deepEqual(calls(edges), [], "an unresolvable Go builtin drops rather than reaching into the frontend");
});

test("cross-language: the guard is the language, not the ambiguity", () => {
  // Two definitions of `render` — one reachable, one not. The Python one being
  // present must not turn this into an "ambiguous, therefore drop": the TS caller
  // has exactly one candidate it could actually call.
  const nodes = [
    n("web/app.ts", "file"), n("web/app.ts#boot", "function"),
    n("web/view.ts", "file"), n("web/view.ts#render", "function"),
    n("api/report.py", "file"), n("api/report.py#render", "function"),
  ];

  const edges = resolveEdges(nodes, [
    { source: "web/app.ts#boot", relation: "calls", name: "render", file: "web/app.ts" },
  ]);

  assert.deepEqual(calls(edges), ["web/view.ts#render"]);
});

test("cross-language: families that really do interoperate still resolve", () => {
  // TS/TSX/JS import each other freely; C and C++ share headers. Grouping them is
  // the whole reason this is a family test and not a grammar equality check.
  const tsx = resolveEdges(
    [
      n("web/page.ts", "file"), n("web/page.ts#mount", "function"),
      n("web/Button.tsx", "file"), n("web/Button.tsx#Button", "function"),
    ],
    [{ source: "web/page.ts#mount", relation: "calls", name: "Button", file: "web/page.ts" }],
  );
  assert.deepEqual(calls(tsx), ["web/Button.tsx#Button"], "a .ts file calls into a .tsx file");

  const c = resolveEdges(
    [
      n("src/main.cpp", "file"), n("src/main.cpp#run", "function"),
      n("src/util.h", "file"), n("src/util.h#checksum", "function"),
    ],
    [{ source: "src/main.cpp#run", relation: "calls", name: "checksum", file: "src/main.cpp" }],
  );
  assert.deepEqual(calls(c), ["src/util.h#checksum"], "C++ calls a function declared in a C header");
});

test("cross-language: an unclaimed extension never filters", () => {
  // Absence of data is not evidence of a mismatch. If graft cannot name the
  // language of a file, the old behaviour has to stand or the graph silently
  // loses real edges for anything outside the extension tables.
  const nodes = [
    n("scripts/tool.zzz", "file"), n("scripts/tool.zzz#drive", "function"),
    n("scripts/lib.zzz", "file"), n("scripts/lib.zzz#helper", "function"),
  ];

  const edges = resolveEdges(nodes, [
    { source: "scripts/tool.zzz#drive", relation: "calls", name: "helper", file: "scripts/tool.zzz" },
  ]);

  assert.deepEqual(calls(edges), ["scripts/lib.zzz#helper"]);
});

test("cross-language: a typed member call cannot cross either", () => {
  // The owner-qualified path is stricter than bare names, but `Widget.render`
  // colliding between a Python class and a TypeScript one is ordinary in a
  // full-stack repo, so it needs the same guard.
  const nodes = [
    n("web/app.ts", "file"), n("web/app.ts#boot", "function"),
    n("api/widget.py", "file"), n("api/widget.py#Widget", "class"),
    n("api/widget.py#Widget.render", "method"),
  ];

  const edges = resolveEdges(nodes, [
    { source: "web/app.ts#boot", relation: "calls", name: "render", viaMember: true, recvType: "Widget", file: "web/app.ts" },
  ]);

  assert.deepEqual(calls(edges), [], "a TS receiver does not bind to a Python class's method");
});
