/**
 * PR 1 Unit Tests: AST-Differential Summarization Caching (`astCache.test.ts`)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ASTSignatureExtractor, ASTCacheManager } from "../src/cache/astCache.js";
import type { NodeV1 } from "../src/graph/types.js";

function makeNode(id: string, name: string, kind: NodeV1["kind"], signature: string | null = null): NodeV1 {
  return {
    id,
    name,
    kind,
    path: "src/sample.ts",
    span: "L1-L5",
    signature,
    exported: true,
    origin: "ast",
    body_hash: "abc",
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

test("ASTSignatureExtractor: computes stable hash for identical structure", () => {
  const nodes1 = [makeNode("n1", "foo", "function", "foo(): void")];
  const nodes2 = [makeNode("n1", "foo", "function", "foo(): void")];

  const sig1 = ASTSignatureExtractor.extract("src/sample.ts", nodes1);
  const sig2 = ASTSignatureExtractor.extract("src/sample.ts", nodes2);

  assert.equal(sig1.astHash, sig2.astHash);
  assert.equal(sig1.symbolSignatures["n1"], sig2.symbolSignatures["n1"]);
});

test("ASTSignatureExtractor: distinguishes structural changes (signature update)", () => {
  const nodes1 = [makeNode("n1", "foo", "function", "foo(): void")];
  const nodes2 = [makeNode("n1", "foo", "function", "foo(x: number): void")];

  const sig1 = ASTSignatureExtractor.extract("src/sample.ts", nodes1);
  const sig2 = ASTSignatureExtractor.extract("src/sample.ts", nodes2);

  assert.notEqual(sig1.astHash, sig2.astHash);
});

test("ASTCacheManager: detects unchanged vs changed files correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-astcache-"));
  const cacheFile = join(dir, "ast-cache.json");

  try {
    const manager = new ASTCacheManager(cacheFile);
    const nodes = [makeNode("n1", "bar", "class", "class Bar {}")];

    assert.equal(manager.isUnchanged("src/sample.ts", nodes), false);

    manager.update("src/sample.ts", nodes);
    assert.equal(manager.isUnchanged("src/sample.ts", nodes), true);

    // Modify signature
    const modifiedNodes = [makeNode("n1", "bar", "class", "class Bar extends Base {}")];
    assert.equal(manager.isUnchanged("src/sample.ts", modifiedNodes), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
