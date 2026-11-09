/**
 * No em dashes in what the hooks and `trail stats` say to a person or an
 * agent (the copy rule). Each line here is one a person or an agent reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatOrientation, weakMatchNudge } from '../src/claude/format.js';
import { lastFileScopeHint } from '../src/claude/prompt-hook.js';
import { formatSessionStats } from '../src/claude/session-metrics.js';

const DASH = /—/;

test('trail stats says it without an em dash', () => {
  assert.doesNotMatch(formatSessionStats(null), DASH);
  assert.doesNotMatch(formatSessionStats({ id: 's1', graftReads: 2, sourceReads: 1, savedTokens: 900 }), DASH);
});

test('the session-start directive and the weak-match line say it without an em dash', () => {
  assert.doesNotMatch(formatOrientation('# repo map\n'), DASH);
  const nudge = weakMatchNudge({}, 0.05);
  assert.ok(nudge, 'a weak match gets its line');
  assert.doesNotMatch(nudge, DASH);
});

test("the prompt hook's scope-hint misses are logged without an em dash", () => {
  const d = mkdtempSync(join(tmpdir(), 'copy-dashes-'));
  mkdirSync(join(d, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(d, 'graft', '.graph', 'wiring.json'), JSON.stringify({
    meta: { nodeCount: 2, edgeCount: 0, languages: ['typescript'], scopes: [{ prefix: 'api', label: 'api', markers: ['package.json'] }, { prefix: 'web', label: 'web', markers: ['package.json'] }] },
    nodes: [
      { id: 'api/index.ts', name: 'index.ts', kind: 'file', path: 'api/index.ts', span: 'L1-L1' },
      { id: 'web/index.ts', name: 'index.ts', kind: 'file', path: 'web/index.ts', span: 'L1-L1' },
    ],
    edges: [],
  }));
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    assert.equal(lastFileScopeHint(d, 'gone.ts'), null);
    assert.equal(lastFileScopeHint(d, 'index.ts'), null);
  } finally {
    console.error = error;
  }
  assert.equal(logged.length, 2, logged.join('\n'));
  for (const line of logged) assert.doesNotMatch(line, DASH);
});
