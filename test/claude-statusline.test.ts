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

test('a 0-node cache without wiring.json is still not built', () => {
  const d = repo();
  writeStats(d, { ...emptyStats(), nodeCount: 0, edgeCount: 0 });
  assert.equal(resolveStats(d), null, 'no artifact → missing, not an empty graph');
  const line = strip(renderStatusline(null, null, { ctxPct: null })[0]);
  assert.match(line, /not built/);
  assert.match(line, /graft build/);
});

/**
 * A workspace parent (#433): its graft/ holds only workspace.json, the graphs
 * live in each child's graft/. Before this, the bar read "not built" at the
 * parent although every child had built and every federated query worked.
 */
function workspace(children: Record<string, { nodes: number; edges: number; langs: string[] } | null>): string {
  const p = repo();
  mkdirSync(join(p, 'graft'), { recursive: true });
  writeFileSync(join(p, 'graft', 'workspace.json'), JSON.stringify({ version: 1, children: Object.keys(children) }));
  for (const [child, w] of Object.entries(children)) {
    if (!w) continue; // listed, not built yet
    writeWiring(join(p, child), {
      meta: { nodeCount: w.nodes, edgeCount: w.edges, languages: w.langs },
      nodes: [{ id: 'a', summary_state: 'ready' }, { id: 'b', summary_state: 'pending' }],
      edges: [],
    });
  }
  return p;
}

test('a workspace parent sums its children instead of reading as not built (#433)', () => {
  const p = workspace({ api: { nodes: 10, edges: 5, langs: ['typescript'] }, web: { nodes: 20, edges: 7, langs: ['python', 'typescript'] } });
  const s = resolveStats(p)!;
  assert.equal(s.nodeCount, 30);
  assert.equal(s.edgeCount, 12);
  assert.deepEqual(s.languages, ['python', 'typescript'], 'union of the children, sorted');
  assert.equal(s.readyCount, 2, 'summed across children');
  assert.equal(s.dirty, false, 'no cache, no drift signal — same as the single-repo wiring fallback');
  const line = strip(renderStatusline(s, null, { ctxPct: null })[0]);
  assert.match(line, /30 nodes \/ 12 edges/);
  assert.doesNotMatch(line, /not built/);
});

test('a zeroed dirty cache at a workspace parent keeps its flags and takes the counts from the children', () => {
  // This is the exact state the hooks leave behind: PostToolUse patches a
  // fresh, all-zero cache with dirty: true, and there is no wiring.json here.
  const p = workspace({ api: { nodes: 10, edges: 5, langs: ['typescript'] }, web: { nodes: 20, edges: 7, langs: ['go'] } });
  writeStats(p, { ...emptyStats(), dirty: true, staleCount: 2, lastFile: 'a.ts' });
  const s = resolveStats(p)!;
  assert.equal(s.nodeCount, 30, 'counts come from the children');
  assert.equal(s.dirty, true, 'the live drift state the cache carries survives');
  assert.equal(s.staleCount, 2);
  assert.equal(s.lastFile, 'a.ts');
});

test('a workspace parent whose children are not built yet is still not built', () => {
  const p = workspace({ api: null, web: null });
  assert.equal(resolveStats(p), null);
});

test('an unbuilt child is skipped; the built ones still count', () => {
  const p = workspace({ api: { nodes: 10, edges: 5, langs: ['typescript'] }, web: null });
  const s = resolveStats(p)!;
  assert.equal(s.nodeCount, 10);
  assert.equal(s.edgeCount, 5);
});
