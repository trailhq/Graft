/**
 * Tests for the shared "tokens saved" estimate ({@link savingsFor} +
 * {@link withSavings}) that every retrieval-style command routes through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savingsFor, savingsLine, withSavings, toTokens } from '../src/context/savings.js';
import type { GraphV1, NodeV1 } from '../src/graph/types.js';

function fileNode(path: string, chars?: number): NodeV1 {
  return {
    id: path,
    name: path,
    kind: 'file',
    path,
    span: 'L1-L1',
    signature: null,
    exported: true,
    origin: 'ast',
    body_hash: '',
    summary_state: 'pending',
    summary: null,
    crux: null,
    chars,
  };
}

function graphOf(nodes: NodeV1[]): GraphV1 {
  return { meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: [] }, nodes, edges: [] };
}

test('savingsFor: sums the sizes of the distinct baseline files', () => {
  const g = graphOf([fileNode('a.ts', 400), fileNode('b.ts', 600)]);
  const s = savingsFor(g, ['a.ts', 'b.ts', 'a.ts']); // duplicate a.ts counted once
  assert.deepEqual(s, { files: 2, baselineChars: 1000 });
});

test('savingsFor: skips files with no known size, returns undefined when none are sized', () => {
  const g = graphOf([fileNode('a.ts'), fileNode('b.ts', 800)]);
  assert.deepEqual(savingsFor(g, ['a.ts', 'b.ts']), { files: 1, baselineChars: 800 });
  assert.equal(savingsFor(graphOf([fileNode('a.ts')]), ['a.ts']), undefined);
  assert.equal(savingsFor(g, ['missing.ts']), undefined);
});

test('savingsLine: reports saved tokens and percent when the output is smaller', () => {
  const body = 'x'.repeat(40); // ≈ 10 tok
  const footer = savingsLine(body, { files: 2, baselineChars: 8000 }); // baseline ≈ 2000 tok
  assert.match(footer, /tokens saved ≈ [\d,]+ \(\d+%\)/);
  assert.match(footer, /2 file\(s\)/);
  const base = toTokens(8000);
  assert.ok(footer.includes((base - toTokens(body.length)).toLocaleString()));
  // The nudge rides along so the agent reports the turn total without SKILL.md.
  assert.match(footer, /end of your reply/i);
  assert.match(footer, /graft saved ~N tokens this turn/);
  // The nudge must NOT introduce a second "[graft] tokens saved ≈ <n>" token —
  // the PostToolUse accumulator sums every such match, so a stray one double-counts.
  assert.equal((footer.match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
});

test('savingsLine: stays silent when there is nothing honest to claim', () => {
  assert.equal(savingsLine('anything', undefined), '');
  assert.equal(savingsLine('anything', { files: 1, baselineChars: 0 }), '');
  // Baseline no bigger than the output itself (tiny file) → no claim.
  assert.equal(savingsLine('x'.repeat(1000), { files: 1, baselineChars: 40 }), '');
});

test('withSavings: puts the line on top so `head -N` and host truncation keep it', () => {
  const body = 'line1\nline2\nline3';
  const out = withSavings(body, { files: 2, baselineChars: 8000 });
  const first = out.split('\n')[0];
  assert.match(first, /^\[graft\] tokens saved ≈ [\d,]+/);
  assert.ok(out.endsWith(body), 'body follows the header verbatim');
  // Exactly one number in the whole output — a second copy would be
  // double-counted by the PostToolUse accumulator's matchAll.
  assert.equal((out.match(/\[graft\] tokens saved ≈ [\d,]+/g) ?? []).length, 1);
});

test('withSavings: returns the body untouched when there is nothing to claim', () => {
  assert.equal(withSavings('body', undefined), 'body');
});
