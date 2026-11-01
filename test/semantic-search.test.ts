/**
 * Tests for the semantic-search pipeline (src/ask/semantic.ts).
 *
 * The real 87 MB all-MiniLM-L6-v2 model is never downloaded in these tests.
 * A deterministic fake embedder is injected via `_setEmbedderForTest` so the
 * full sqlite-vec round-trip (embed → store → KNN query) is exercised against
 * real SQLite rows, not mocked SQL calls.
 *
 * Pattern: node:test + node:assert/strict + mkdtempSync — same as
 * test/search-grep.test.ts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { embedNodes, searchSemantic, _setEmbedderForTest, EMBED_DIM } from '../src/ask/semantic.js';
import type { NodeV1 } from '../src/graph/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal NodeV1 suitable for embedding tests. */
function makeNode(id: string, extra: Partial<NodeV1> = {}): NodeV1 {
  return {
    id,
    name: id,
    kind: 'function',
    path: `src/${id}.ts`,
    span: 'L1-L10',
    signature: `function ${id}(): void`,
    exported: true,
    origin: 'ast',
    body_hash: createHash('sha256').update(id).digest('hex'),
    summary_state: 'pending',
    summary: null,
    crux: null,
    ...extra,
  } as NodeV1;
}

/**
 * Deterministic fake embedder: hashes the text to seed a 384-dim Float32Array.
 * Each dimension is a function of the text hash and the dimension index, so
 * two different texts always produce different (though random-looking) vectors.
 */
function fakeEmbed(text: string): Float32Array {
  const hash = createHash('sha256').update(text).digest();
  const vec = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) {
    // Mix two hash bytes per dimension for variety.
    vec[i] = ((hash[i % 32]! ^ (hash[(i + 1) % 32]! << 4)) / 255) * 2 - 1;
  }
  return vec;
}

/** Install the fake embedder before each test, uninstall after. */
function withFakeEmbedder(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    _setEmbedderForTest(fakeEmbed);
    try {
      await fn();
    } finally {
      _setEmbedderForTest(null);
    }
  };
}

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graft-semantic-'));
  return join(dir, 'embeddings.db');
}

// ---------------------------------------------------------------------------
// Test 1: round-trip — embed 5 nodes, search, assert the right top hit
// ---------------------------------------------------------------------------

test(
  'embedNodes + searchSemantic round-trip: top hit matches the queried node',
  withFakeEmbedder(async () => {
    const dbPath = tmpDb();

    const nodes = [
      makeNode('alpha'),
      makeNode('beta'),
      makeNode('gamma'),
      makeNode('delta'),
      makeNode('epsilon'),
    ];

    await embedNodes(nodes, dbPath);

    // Search using the exact text that would have been embedded for 'gamma':
    // id + signature (no body_text on these nodes).
    const queryText = ['gamma', 'function gamma(): void'].join(' ');
    const hits = await searchSemantic(queryText, dbPath, 3);

    assert.ok(hits.length > 0, 'expected at least one hit');
    // The top hit should be 'gamma' since the query vector == gamma's vector.
    assert.equal(hits[0]!.node_id, 'gamma', `expected top hit 'gamma', got '${hits[0]!.node_id}'`);
  }),
);

// ---------------------------------------------------------------------------
// Test 2: idempotency — calling embedNodes twice with the same nodes is a no-op
// ---------------------------------------------------------------------------

test(
  'embedNodes is idempotent (hash match): second call skips re-embedding',
  withFakeEmbedder(async () => {
    const dbPath = tmpDb();
    const nodes = [makeNode('foo'), makeNode('bar'), makeNode('baz')];

    await embedNodes(nodes, dbPath);
    await embedNodes(nodes, dbPath); // second call — must be a no-op

    const hits = await searchSemantic('foo function foo(): void', dbPath, 5);
    // Row count must still be exactly 3 — no duplicates from a second embed.
    assert.equal(hits.length, 3, `expected 3 rows, got ${hits.length}`);
  }),
);

// ---------------------------------------------------------------------------
// Test 3: invalidation — changing one node triggers re-embedding
// ---------------------------------------------------------------------------

test(
  'embedNodes invalidates on node change: replacing a node causes re-embedding',
  withFakeEmbedder(async () => {
    const dbPath = tmpDb();

    const nodesV1 = [makeNode('alpha'), makeNode('beta'), makeNode('charlie')];
    await embedNodes(nodesV1, dbPath);

    // Verify 'charlie' is reachable in V1.
    const hitsV1 = await searchSemantic('charlie function charlie(): void', dbPath, 3);
    assert.ok(
      hitsV1.some(h => h.node_id === 'charlie'),
      'V1: charlie should be in the index',
    );

    // Replace charlie with delta — different hash → must re-embed.
    const nodesV2 = [makeNode('alpha'), makeNode('beta'), makeNode('delta')];
    await embedNodes(nodesV2, dbPath);

    // delta must now be the top hit for its own text.
    const hitsV2 = await searchSemantic('delta function delta(): void', dbPath, 3);
    assert.ok(
      hitsV2.some(h => h.node_id === 'delta'),
      'V2: delta should be in the index after re-embed',
    );

    // charlie must no longer be in the DB.
    const allV2Ids = hitsV2.map(h => h.node_id);
    assert.equal(
      allV2Ids.includes('charlie'),
      false,
      'V2: charlie must have been removed by re-embedding',
    );
  }),
);

// ---------------------------------------------------------------------------
// Test 4: empty DB — searchSemantic throws (or returns empty) gracefully
// ---------------------------------------------------------------------------

test('searchSemantic on empty DB throws or returns empty gracefully', async () => {
  // Non-existent path → must throw with a helpful message.
  const missingPath = join(tmpdir(), `graft-semantic-missing-${Date.now()}`, 'embeddings.db');
  await assert.rejects(
    () => searchSemantic('anything', missingPath),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'expected Error');
      assert.match(err.message, /not found|does not exist|Embeddings DB/i);
      return true;
    },
  );

  // embedNodes with zero nodes → must return silently (skip, not throw).
  // Valid case: .md-only repos without --include-md, or empty workspace children.
  _setEmbedderForTest(fakeEmbed);
  try {
    const dbPath = tmpDb();
    await assert.doesNotReject(
      () => embedNodes([], dbPath),
      'embedNodes([]) should return silently, not throw',
    );
  } finally {
    _setEmbedderForTest(null);
  }
});
