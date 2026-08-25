import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeStats, readWiring } from '../src/claude/stats.js';

const wiring = {
  meta: { version: 1, nodeCount: 3, edgeCount: 2, languages: ['typescript'] },
  nodes: [
    { id: 'a', summary_state: 'ready' },
    { id: 'b', summary_state: 'pending' },
    { id: 'c', summary_state: 'ready' },
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'c', to: 'a' }],
} as any;

test('computeStats derives counts and readyCount', () => {
  const s = computeStats(wiring);
  assert.equal(s.nodeCount, 3);
  assert.equal(s.edgeCount, 2);
  assert.deepEqual(s.languages, ['typescript']);
  assert.equal(s.totalCount, 3);
  assert.equal(s.readyCount, 2);
});

test('computeStats tolerates missing meta by counting arrays', () => {
  const s = computeStats({ nodes: [{ id: 'x', summary_state: 'pending' }], edges: [] } as any);
  assert.equal(s.nodeCount, 1);
  assert.equal(s.edgeCount, 0);
  assert.equal(s.readyCount, 0);
});

test('readWiring reads from a GRAFT_DIR-relocated context dir instead of <projectDir>/graft', () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-stats-dir-'));
  mkdirSync(join(d, 'elsewhere', '.graph'), { recursive: true });
  writeFileSync(join(d, 'elsewhere', '.graph', 'wiring.json'), JSON.stringify(wiring));
  process.env.GRAFT_DIR = 'elsewhere';
  try {
    assert.deepEqual(readWiring(d), wiring);
  } finally {
    delete process.env.GRAFT_DIR;
  }
});
