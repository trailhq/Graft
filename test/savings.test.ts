/** Tests for the retained structured file-read-size estimate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savingsFor, toTokens } from '../src/context/savings.js';
import { formatAsk, formatSkeleton } from '../src/ask/ask.js';
import { formatGrepResult } from '../src/search/grep-cli.js';
import { formatRepoMap } from '../src/graph/map.js';
import type { GraphV1, NodeV1 } from '../src/graph/types.js';

function fileNode(path: string, chars?: number): NodeV1 {
  return { id: path, kind: 'file', name: path, path, span: 'L1-L1', signature: null,
    exported: true, origin: 'ast', body_hash: '', summary_state: 'pending', summary: null,
    crux: null, ...(chars === undefined ? {} : { chars }) };
}
function graphOf(nodes: NodeV1[]): GraphV1 {
  return { meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: [] }, nodes, edges: [] };
}

test('savingsFor retains a distinct-file size estimate for structured consumers', () => {
  const g = graphOf([fileNode('a.ts', 400), fileNode('b.ts', 600)]);
  assert.deepEqual(savingsFor(g, ['a.ts', 'b.ts', 'a.ts']), { files: 2, baselineChars: 1000 });
});

test('savingsFor omits unknown file sizes', () => {
  const g = graphOf([fileNode('a.ts'), fileNode('b.ts', 800)]);
  assert.deepEqual(savingsFor(g, ['a.ts', 'b.ts']), { files: 1, baselineChars: 800 });
  assert.equal(savingsFor(g, ['a.ts']), undefined);
});

test('toTokens remains an explicitly rough diagnostic conversion', () => {
  assert.equal(toTokens(8000), 2000);
});

test('normal retrieval formatters do not render token-savings footers', () => {
  const outputs = [
    formatAsk({ query: 'auth', mode: 'lexical', hits: [], saved: { files: 1, baselineChars: 8000 } } as any),
    formatSkeleton({ file: 'a.ts', entries: [], saved: { files: 1, baselineChars: 8000 } } as any),
    formatGrepResult({ pattern: 'auth', totalHits: 1, filesSearched: 1, groups: [{ path: 'a.ts', inDegree: 0, hits: [{ line: 1, text: 'auth' }] }], truncated: { files: 0, hits: 0 }, saved: { files: 1, baselineChars: 8000 } } as any),
    formatRepoMap({ totals: { files: 1, symbols: 0, edges: 0, languages: [] }, dirs: [], hotspots: [], dropped: 0, saved: { files: 1, baselineChars: 8000 } }),
  ];
  for (const output of outputs) assert.doesNotMatch(output, /\[graft\] tokens saved|tok saved/i);
});
