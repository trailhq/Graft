import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStats } from '../src/claude/statusline.js';
import { renderStatusline } from '../src/claude/format.js';
import { writeStats, emptyStats } from '../src/claude/state.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function repo(): string { return mkdtempSync(join(tmpdir(), 'graft-sl-')); }
function writeWiring(dir: string, obj: unknown): void {
  mkdirSync(join(dir, 'graft', '.graph'), { recursive: true });
  writeFileSync(join(dir, 'graft', '.graph', 'wiring.json'), JSON.stringify(obj));
}
function writeWorkspaceIndex(dir: string, children: string[]): void {
  mkdirSync(join(dir, 'graft'), { recursive: true });
  writeFileSync(join(dir, 'graft', 'workspace.json'), JSON.stringify({ version: 1, children }));
}

test('resolveStats returns the hook-maintained cache when present and non-empty', () => {
  const d = repo();
  writeStats(d, { ...emptyStats(), nodeCount: 5, edgeCount: 9, dirty: true, staleCount: 2 });
  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 5);
  assert.equal(s.dirty, true, 'cache is the source of truth when present');
});

test('resolveStats falls back to wiring.json when no cache (manual graft build / fresh checkout)', () => {
  const d = repo();
  writeWiring(d, {
    meta: { nodeCount: 42, edgeCount: 100, languages: ['typescript'] },
    nodes: [{ id: 'a', summary_state: 'ready' }, { id: 'b', summary_state: 'pending' }],
    edges: [],
  });
  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 42, 'reflects the graph immediately instead of "not built"');
  assert.equal(s.readyCount, 1);
  assert.equal(s.dirty, false, 'defaults to synced — no drift signal available from the graph alone');
});

test('resolveStats prefers the cache over the graph even when both exist', () => {
  const d = repo();
  writeWiring(d, { meta: { nodeCount: 42, edgeCount: 100, languages: [] }, nodes: [], edges: [] });
  writeStats(d, { ...emptyStats(), nodeCount: 7, edgeCount: 3, dirty: true, staleCount: 4 });
  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 7, 'cache wins (it carries live drift state the graph cannot)');
  assert.equal(s.staleCount, 4);
});

test('resolveStats returns null when neither cache nor graph exists', () => {
  assert.equal(resolveStats(repo()), null);
});

test('empty wiring.json is a built graph: statusline shows 0 nodes, not "not built"', () => {
  const d = repo();
  writeWiring(d, { meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] });
  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 0);
  assert.equal(s.edgeCount, 0);
  const line = strip(renderStatusline(s, null, { ctxPct: null })[0]);
  assert.doesNotMatch(line, /not built/);
  assert.doesNotMatch(line, /graft build/);
  assert.match(line, /0 nodes \/ 0 edges/);
});

test('a workspace parent reports the sum of its children, not "not built" (#311)', () => {
  const d = repo();
  writeWorkspaceIndex(d, ['svc-a', 'svc-b']);
  // One child built by a plain `graft build` (graph only), one carrying a live
  // hook cache — the parent has to reach both the same way each child would.
  writeWiring(join(d, 'svc-a'), {
    meta: { nodeCount: 1919, edgeCount: 5679, languages: ['java'] },
    nodes: [{ id: 'a', summary_state: 'ready' }, { id: 'b', summary_state: 'pending' }],
    edges: [],
  });
  writeStats(join(d, 'svc-b'), {
    ...emptyStats(), nodeCount: 81, edgeCount: 120, languages: ['rust'],
    totalCount: 4, readyCount: 3, dirty: true, staleCount: 2,
  });

  const s = resolveStats(d)!;
  assert.equal(s.nodeCount, 2000, 'nodes live in the children; the parent is their sum');
  assert.equal(s.edgeCount, 5799);
  assert.deepEqual(s.languages, ['java', 'rust'], 'every child language, deduped');
  assert.equal(s.readyCount, 4);
  assert.equal(s.dirty, true, 'one drifting child makes the workspace drift');
  assert.equal(s.staleCount, 2);
  const line = strip(renderStatusline(s, null, { ctxPct: null })[0]);
  assert.doesNotMatch(line, /not built/);
  assert.match(line, /2000 nodes \/ 5799 edges/);
});

test('a workspace parent whose children are all unbuilt is still not built', () => {
  const d = repo();
  writeWorkspaceIndex(d, ['svc-a', 'svc-b']);
  assert.equal(resolveStats(d), null, 'an index of unbuilt children is not a built graph');
});

test('a foreign workspace.json is not a workspace', () => {
  const d = repo();
  mkdirSync(join(d, 'graft'), { recursive: true });
  writeFileSync(join(d, 'graft', 'workspace.json'), JSON.stringify({ version: 2, children: ['svc-a'] }));
  writeWiring(join(d, 'svc-a'), { meta: { nodeCount: 5, edgeCount: 5, languages: [] }, nodes: [], edges: [] });
  assert.equal(resolveStats(d), null, 'a version this build does not know is treated as absent, not guessed at');
});

test('a 0-node cache without wiring.json is still not built', () => {
  const d = repo();
  writeStats(d, { ...emptyStats(), nodeCount: 0, edgeCount: 0 });
  assert.equal(resolveStats(d), null, 'no artifact → missing, not an empty graph');
  const line = strip(renderStatusline(null, null, { ctxPct: null })[0]);
  assert.match(line, /not built/);
  assert.match(line, /graft build/);
});
