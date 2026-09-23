/**
 * PR 4 Unit Tests: Multi-Artifact Parsers (`multiArtifactParser.test.ts`)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiArtifactParser } from "../src/ingest/multiArtifactParser.js";
import type { GraphV1 } from "../src/graph/types.js";

test("MultiArtifactParser: parses SQL files as database_schema nodes", () => {
  const { nodes } = MultiArtifactParser.parseArtifact("schema.sql", "CREATE TABLE users (id INT);");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "database_schema");
});

test("MultiArtifactParser: parses Markdown files as architectural_decision nodes", () => {
  const { nodes } = MultiArtifactParser.parseArtifact("ADR-001.md", "# ADR 1\nDecision details.");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "architectural_decision");
});

test("MultiArtifactParser: integrates artifacts into GraphV1", () => {
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["ts"] },
    nodes: [],
    edges: [],
  };

  const artifacts = new Map([["config.yaml", "env: production"]]);
  MultiArtifactParser.integrateIntoGraph(graph, artifacts);

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].kind, "config_definition");
});
