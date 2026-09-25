import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { resolveEdges } from "../src/graph/resolve.js";
import type { RawEdge } from "../src/graph/extract.js";
import type { NodeV1 } from "../src/graph/types.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

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

function rawImport(file: string, specifier: string, metadata: Pick<RawEdge, "lazy" | "line"> = {}): RawEdge {
  return { source: file, relation: "imports", specifier, file, ...metadata };
}

function importTargets(nodes: NodeV1[], rawEdges: RawEdge[]): string[] {
  return resolveEdges(nodes, rawEdges)
    .filter((edge) => edge.relation === "imports")
    .map((edge) => edge.target);
}

test("Python absolute import resolution is suffix-precise", () => {
  const importer = "consumer.py";
  const nodes = [
    importer,
    "vendor/pkg/module.py",
    "vendor/pkg/contracts.pyi",
    "vendor/pkg/__init__.py",
    "vendor/pkg/api.py",
    "one/pkg/dup.py",
    "two/pkg/dup.py",
    "one/pkg/both.py",
    "one/pkg/both.pyi",
  ].map(fileNode);
  const specs = ["pkg.module", "pkg.contracts", "pkg", "pkg.api.symbol", "pkg.dup", "pkg.both", "typing"];

  assert.deepEqual(
    importTargets(nodes, specs.map((specifier) => rawImport(importer, specifier))),
    [
      "vendor/pkg/module.py",
      "vendor/pkg/contracts.pyi",
      "pkg",
      "vendor/pkg/api.py",
      "pkg.dup",
      "pkg.both",
      "typing",
    ],
  );
});

test("Python suffix collisions resolve only within one importer root", () => {
  const importer = "apps/a/src/service.py";
  const nodes = [
    importer,
    "apps/a/src/db/models.py",
    "apps/b/src/db/models.py",
    "apps/a/db/models.py",
    "x/shared/item.py",
    "y/shared/item.py",
  ].map(fileNode);

  assert.deepEqual(
    importTargets(nodes, ["src.db.models", "db.models", "shared.item"].map((spec) => rawImport(importer, spec))),
    ["apps/a/src/db/models.py", "db.models", "shared.item"],
  );
});

test("Python unique single-segment imports stay raw outside the importer source root", () => {
  const importer = "apps/admin/src/service.py";
  const nodes = [importer, "apps/entities/src/explore/utils/logging.py"].map(fileNode);

  assert.deepEqual(importTargets(nodes, [rawImport(importer, "logging")]), ["logging"]);
});

test("Python unique single-segment imports resolve at the importer source root", () => {
  const importer = "apps/figaro/src/service.py";
  const nodes = [importer, "apps/figaro/src/config.py"].map(fileNode);

  assert.deepEqual(importTargets(nodes, [rawImport(importer, "config")]), ["apps/figaro/src/config.py"]);
});

test("Python relative imports honor parent hops and stay raw when unresolved", () => {
  const importer = "pkg/sub/deep/importer.py";
  const nodes = [
    importer,
    "pkg/sub/deep/local.py",
    "pkg/sub/shared.py",
    "pkg/rootmod.py",
    "outside.py",
  ].map(fileNode);

  assert.deepEqual(
    importTargets(
      nodes,
      [".local", "..shared", "...rootmod", ".missing", "....outside"].map((spec) =>
        rawImport(importer, spec),
      ),
    ),
    ["pkg/sub/deep/local.py", "pkg/sub/shared.py", "pkg/rootmod.py", ".missing", "....outside"],
  );
});

test("Python build serializes resolved and unresolved imports with metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-python-resolve-"));
  const importer = "pkg/sub/importer.py";
  try {
    for (const path of [
      "pkg/__init__.py",
      "pkg/absolute.py",
      "pkg/deferred.py",
      "pkg/sub/__init__.py",
      "pkg/sub/relative.py",
      "one/ambiguous/target.py",
      "two/ambiguous/target.py",
    ]) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "");
    }
    writeFileSync(
      join(dir, importer),
      [
        "import pkg.absolute",
        "from .relative import Thing",
        "import ambiguous.target",
        "import os",
        "",
        "def late():",
        "    import pkg.deferred",
        "",
      ].join("\n"),
    );

    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const imports = graph.edges.filter((edge) => edge.relation === "imports" && edge.source === importer);

    assert.deepEqual(imports, [
      { source: importer, target: "ambiguous.target", relation: "imports", confidence: "extracted", line: 3 },
      { source: importer, target: "os", relation: "imports", confidence: "extracted", line: 4 },
      { source: importer, target: "pkg/absolute.py", relation: "imports", confidence: "extracted", line: 1 },
      {
        source: importer,
        target: "pkg/deferred.py",
        relation: "imports",
        confidence: "extracted",
        lazy: true,
        line: 7,
      },
      { source: importer, target: "pkg/sub/relative.py", relation: "imports", confidence: "extracted", line: 2 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Python import dedupe is eager-wins in both arrival orders", () => {
  const importer = "importer.py";
  const nodes = [importer, "target.py"].map(fileNode);
  const eager = rawImport(importer, "target", { line: 4 });
  const lazy = rawImport(importer, "target", { lazy: true, line: 10 });
  const expected = [
    {
      source: importer,
      target: "target.py",
      relation: "imports",
      confidence: "extracted",
      line: 4,
    },
  ];

  assert.deepEqual(
    [resolveEdges(nodes, [lazy, eager]), resolveEdges(nodes, [eager, lazy])],
    [expected, expected],
  );
});
