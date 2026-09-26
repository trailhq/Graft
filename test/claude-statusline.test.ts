import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStats, resolveWorkspaceStats } from '../src/claude/statusline.js';
import { renderStatusline } from '../src/claude/format.js';
import { writeStats, emptyStats } from '../src/claude/state.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
// Absolute, so the spawned statusline resolves tsx regardless of its env.
const TSX = pathToFileURL(createRequire(join(process.cwd(), 'x.js')).resolve('tsx')).href;

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


// ── Workspace roots (#455): graphs live in each child's graft/, never at the root ──

/** A workspace root listing `children`, with a root cache holding nodeCount 0 as
 * the hooks leave it. Only `workspace.json` and `.cache/` exist at the root. */
function workspaceRoot(children: string[]): string {
  const root = repo();
  mkdirSync(join(root, 'graft'), { recursive: true });
  writeFileSync(join(root, 'graft', 'workspace.json'), JSON.stringify({ version: 1, children }));
  writeStats(root, { ...emptyStats(), nodeCount: 0, edgeCount: 0 });
  for (const c of children) mkdirSync(join(root, c), { recursive: true });
  return root;
}

test('workspace root: resolveWorkspaceStats sums every built child', () => {
  const root = workspaceRoot(['api', 'web']);
  // One child answers from its hook cache (live drift state), the other from its graph.
  writeStats(join(root, 'api'), { ...emptyStats(), nodeCount: 10, edgeCount: 20, totalCount: 10,
    readyCount: 4, dirty: true, staleCount: 2, languages: ['python'] });
  writeWiring(join(root, 'web'), {
    meta: { nodeCount: 5, edgeCount: 7, languages: ['typescript'] },
    nodes: [{ id: 'a', summary_state: 'ready' }], edges: [],
  });

  assert.equal(resolveStats(root), null, "the root's own graph is still absent");
  const ws = resolveWorkspaceStats(root)!;
  assert.deepEqual(ws.workspace, { built: 2, total: 2 });
  assert.equal(ws.stats.nodeCount, 15);
  assert.equal(ws.stats.edgeCount, 27);
  assert.equal(ws.stats.readyCount, 5);
  assert.equal(ws.stats.staleCount, 2);
  assert.equal(ws.stats.dirty, true, 'any dirty child makes the workspace dirty');
  assert.deepEqual(ws.stats.languages, ['python', 'typescript']);

  const line = strip(renderStatusline(ws.stats, null, { ctxPct: null, workspace: ws.workspace })[0]);
  assert.doesNotMatch(line, /not built/);
  assert.match(line, /workspace 2 repos/);
  assert.match(line, /15 nodes \/ 27 edges/);
  assert.match(line, /⚠ 2 stale/);
});

test('workspace root: an unbuilt child is named in the count, not hidden', () => {
  const root = workspaceRoot(['api', 'docs', 'web']);
  writeWiring(join(root, 'api'), { meta: { nodeCount: 3, edgeCount: 1, languages: [] }, nodes: [], edges: [] });
  writeWiring(join(root, 'web'), { meta: { nodeCount: 0, edgeCount: 0, languages: [] }, nodes: [], edges: [] });
  const ws = resolveWorkspaceStats(root)!;
  assert.deepEqual(ws.workspace, { built: 2, total: 3 }, 'an empty graph is built; a missing one is not');
  const line = strip(renderStatusline(ws.stats, null, { ctxPct: null, workspace: ws.workspace })[0]);
  assert.match(line, /workspace 2\/3 repos built/);
  assert.match(line, /3 nodes \/ 1 edges/);
});

test('workspace root with no built child is still "not built"', () => {
  assert.equal(resolveWorkspaceStats(workspaceRoot(['api', 'web'])), null);
});

test('resolveWorkspaceStats is null for a plain repo (no workspace.json)', () => {
  const d = repo();
  writeWiring(d, { meta: { nodeCount: 1, edgeCount: 0, languages: [] }, nodes: [], edges: [] });
  assert.equal(resolveWorkspaceStats(d), null);
});

test('workspace.json entries that are not a plain child dir name are ignored', () => {
  const parent = repo();
  const root = join(parent, 'ws');
  mkdirSync(join(root, 'graft'), { recursive: true });
  writeFileSync(join(root, 'graft', 'workspace.json'),
    JSON.stringify({ version: 1, children: ['../outside', 'api', ''] }));
  writeWiring(join(parent, 'outside'), { meta: { nodeCount: 99, edgeCount: 0, languages: [] }, nodes: [], edges: [] });
  writeWiring(join(root, 'api'), { meta: { nodeCount: 2, edgeCount: 0, languages: [] }, nodes: [], edges: [] });
  const ws = resolveWorkspaceStats(root)!;
  assert.deepEqual(ws.workspace, { built: 1, total: 1 });
  assert.equal(ws.stats.nodeCount, 2, 'the graph outside the root is never read');
});

test('statusline process at a workspace root reports the workspace (#455)', () => {
  const root = workspaceRoot(['api', 'web']);
  writeWiring(join(root, 'api'), { meta: { nodeCount: 4, edgeCount: 2, languages: [] }, nodes: [], edges: [] });
  writeWiring(join(root, 'web'), { meta: { nodeCount: 6, edgeCount: 3, languages: [] }, nodes: [], edges: [] });
  const statusline = pathToFileURL(resolve(process.cwd(), 'src/claude/statusline.ts')).href;
  const r = spawnSync(process.execPath, ['--import', TSX, '-e', `import(${JSON.stringify(statusline)}).then((m) => m.main())`], {
    input: JSON.stringify({ session_id: 't', context_window: { used_percentage: 12 } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = strip(r.stdout).split('\n');
  assert.doesNotMatch(lines[0], /not built/);
  assert.match(lines[0], /workspace 2 repos · 10 nodes \/ 5 edges/);
  assert.match(lines[1], /ctx 12%/);
});
