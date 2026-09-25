import { test } from "node:test";
import assert from "node:assert/strict";
import type { EdgeV1, GraphV1, NodeV1, Relation } from "../src/graph/types.js";

function fileNode(id: string): NodeV1 {
  return {
    id,
    name: id.split("/").at(-1)!,
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
  };
}

function edge(
  source: string,
  target: string,
  relation: Relation = "imports",
  metadata: Pick<EdgeV1, "lazy" | "line"> = {},
): EdgeV1 {
  return { source, target, relation, confidence: "extracted", ...metadata };
}

function graph(nodeIds: string[], edges: EdgeV1[]): GraphV1 {
  const nodes = nodeIds.map(fileNode);
  return {
    meta: { version: 1, nodeCount: nodes.length, edgeCount: edges.length, languages: ["python"] },
    nodes,
    edges,
  };
}

async function cyclesApi() {
  try {
    return await import("../src/graph/cycles.js");
  } catch {
    assert.fail("the cycles core module should exist");
  }
}

test("findImportCycles returns a resolved two-file SCC with import metadata", async () => {
  const { findImportCycles } = await cyclesApi();
  const edges = [
    edge("a.py", "b.py", "imports", { lazy: true, line: 10 }),
    edge("b.py", "a.py", "imports", { line: 20 }),
    edge("solo.py", "solo.py", "imports", { line: 30 }),
    edge("solo.py", "external.module", "imports", { line: 31 }),
    edge("a.py", "solo.py", "references", { line: 32 }),
  ];

  assert.deepEqual(findImportCycles(graph(["a.py", "b.py", "solo.py"], edges)), [
    {
      files: ["a.py", "b.py"],
      edges: [
        edge("a.py", "b.py", "imports", { lazy: true, line: 10 }),
        edge("b.py", "a.py", "imports", { line: 20 }),
      ],
    },
  ]);
});

test("findImportCycles orders disjoint and multi-file SCCs independently of graph arrival order", async () => {
  const { findImportCycles } = await cyclesApi();
  const nodes = ["z.py", "y.py", "x.py", "d.py", "c.py"];
  const edges = [
    edge("z.py", "x.py", "imports", { line: 30 }),
    edge("y.py", "z.py", "imports", { line: 20 }),
    edge("x.py", "y.py", "imports", { line: 10 }),
    edge("d.py", "c.py", "imports", { line: 50 }),
    edge("c.py", "d.py", "imports", { line: 40 }),
  ];
  const expected = [
    {
      files: ["c.py", "d.py"],
      edges: [edge("c.py", "d.py", "imports", { line: 40 }), edge("d.py", "c.py", "imports", { line: 50 })],
    },
    {
      files: ["x.py", "y.py", "z.py"],
      edges: [
        edge("x.py", "y.py", "imports", { line: 10 }),
        edge("y.py", "z.py", "imports", { line: 20 }),
        edge("z.py", "x.py", "imports", { line: 30 }),
      ],
    },
  ];

  assert.deepEqual(findImportCycles(graph(nodes, edges)), expected);
  assert.deepEqual(findImportCycles(graph([...nodes].reverse(), [...edges].reverse())), expected);
});

test("formatImportCycles renders titled arrow blocks with line and lazy annotations", async () => {
  const { findImportCycles, formatImportCycles } = await cyclesApi();
  assert.equal(typeof formatImportCycles, "function");
  const cycles = findImportCycles(
    graph(
      ["a.py", "b.py"],
      [edge("a.py", "b.py", "imports", { lazy: true, line: 10 }), edge("b.py", "a.py", "imports", { line: 20 })],
    ),
  );

  assert.equal(
    formatImportCycles(cycles),
    ["Cycle 1 · 2 files", "  a.py:10 imports → b.py [lazy]", "  b.py:20 imports → a.py", ""].join("\n"),
  );
});

test("formatImportCycles reports an empty result without failing", async () => {
  const { formatImportCycles } = await cyclesApi();
  assert.equal(typeof formatImportCycles, "function");
  assert.equal(formatImportCycles([]), "no import cycles found\n");
});
