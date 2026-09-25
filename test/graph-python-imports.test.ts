import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFile } from "../src/graph/extract.js";
import { calleesOf } from "../src/graph/traverse.js";
import { readGraph } from "../src/graph/write.js";

function importEdges(source: string) {
  return extractFile("app.py", source, "python").rawEdges.filter((edge) => edge.relation === "imports");
}

test("Python import metadata is additive", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-python-imports-"));
  const path = join(dir, "legacy-wiring.json");
  const fileNode = (id: string) => ({
    id,
    name: id,
    kind: "file",
    path: id,
    span: "L1-L1",
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: id,
    summary_state: "pending",
    summary: null,
    crux: null,
  });

  try {
    writeFileSync(
      path,
      JSON.stringify({
        meta: { version: 1, nodeCount: 2, edgeCount: 1, languages: ["python"] },
        nodes: [fileNode("app.py"), fileNode("dep.py")],
        edges: [{ source: "app.py", target: "dep.py", relation: "imports", confidence: "inferred" }],
      }),
    );
    const legacy = readGraph(path);
    assert.ok(legacy, "a graph whose edges predate optional import metadata still loads");
    assert.deepEqual(calleesOf(legacy, legacy.nodes[0]!), [
      { node: legacy.nodes[1], id: "dep.py", relation: "imports", depth: 1 },
    ]);

    const edges = importEdges(
      [
        "import top",
        "if sys.version_info:",
        "    import conditional",
        "from typing import TYPE_CHECKING as TC",
        "if TC:",
        "    import aliased",
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      edges.map(({ specifier, line, lazy }) => ({ specifier, line, lazy })),
      [
        { specifier: "top", line: 1, lazy: undefined },
        { specifier: "conditional", line: 3, lazy: undefined },
        { specifier: "typing", line: 4, lazy: undefined },
        { specifier: "aliased", line: 6, lazy: undefined },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python definition-scoped imports are lazy", () => {
  const edges = importEdges(
    ["def load():", "    import inside_function", "class Plugin:", "    import inside_class", ""].join("\n"),
  );

  assert.deepEqual(
    edges.map(({ specifier, line, lazy }) => ({ specifier, line, lazy })),
    [
      { specifier: "inside_function", line: 2, lazy: true },
      { specifier: "inside_class", line: 4, lazy: true },
    ],
  );
});

test("Python bare TYPE_CHECKING defers only its consequence", () => {
  const edges = importEdges(
    [
      "from typing import TYPE_CHECKING",
      "if TYPE_CHECKING:",
      "    import type_only",
      "else:",
      "    import runtime_fallback",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    edges.map(({ specifier, line, lazy }) => ({ specifier, line, lazy })),
    [
      { specifier: "typing", line: 1, lazy: undefined },
      { specifier: "type_only", line: 3, lazy: true },
      { specifier: "runtime_fallback", line: 5, lazy: undefined },
    ],
  );
});

test("Python typing.TYPE_CHECKING imports are lazy", () => {
  const edges = importEdges(["import typing", "if typing.TYPE_CHECKING:", "    import models", ""].join("\n"));

  assert.deepEqual(
    edges.map(({ specifier, line, lazy }) => ({ specifier, line, lazy })),
    [
      { specifier: "typing", line: 1, lazy: undefined },
      { specifier: "models", line: 3, lazy: true },
    ],
  );
});
