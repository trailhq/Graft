/**
 * Tests for @detacoop/trail-code knowledge-repos feature.
 *
 * Covers:
 * - readKnowledgeRepos / writeKnowledgeRepos (read/write .trail/knowledge-repos.json)
 * - findWorkspaceRoot: finds dir with knowledge-repos.json, walks up correctly
 * - Multiple knowledge repos warning
 * - --include-md / mdOnlyDirs BuildConfig persistence
 * - trail note --issue field in LearningFields
 *
 * Pattern: node:test + node:assert/strict + tmp dirs, no network, no git.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKnowledgeRepos, writeKnowledgeRepos, findWorkspaceRoot } from '../src/graph/workspace.js';
import { readBuildConfig, patchBuildConfig } from '../src/util/state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'trail-knowledge-test-'));
}

/** Create a minimal workspace.json so readWorkspace() returns non-null. */
function makeWorkspace(dir: string, children: string[] = []): void {
  const cacheDir = join(dir, '.trail', 'cache');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'workspace.json'), JSON.stringify({ version: 1, children }));
}

/** Create a minimal .git so a dir looks like a git repo. */
function makeGitRepo(dir: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true });
}

// ---------------------------------------------------------------------------
// readKnowledgeRepos / writeKnowledgeRepos
// ---------------------------------------------------------------------------

test('readKnowledgeRepos returns [] when no file exists', () => {
  const dir = tmpDir();
  assert.deepEqual(readKnowledgeRepos(dir), []);
});

test('writeKnowledgeRepos + readKnowledgeRepos round-trips URLs', () => {
  const dir = tmpDir();
  const urls = [
    'https://gitlab.com/detacoop/equipo-desarrolladores/detacoop-knowledge',
    'https://github.com/acme/team-knowledge',
  ];
  writeKnowledgeRepos(dir, urls);
  assert.ok(existsSync(join(dir, '.trail', 'knowledge-repos.json')));
  assert.deepEqual(readKnowledgeRepos(dir), urls);
});

test('writeKnowledgeRepos overwrites on second call', () => {
  const dir = tmpDir();
  writeKnowledgeRepos(dir, ['https://example.com/repo-a']);
  writeKnowledgeRepos(dir, ['https://example.com/repo-b']);
  assert.deepEqual(readKnowledgeRepos(dir), ['https://example.com/repo-b']);
});

test('writeKnowledgeRepos with empty array stores empty JSON array', () => {
  const dir = tmpDir();
  writeKnowledgeRepos(dir, ['https://example.com/repo']);
  writeKnowledgeRepos(dir, []);
  assert.deepEqual(readKnowledgeRepos(dir), []);
});

// ---------------------------------------------------------------------------
// findWorkspaceRoot
// ---------------------------------------------------------------------------

test('findWorkspaceRoot returns dir when knowledge-repos.json is in the same dir', () => {
  const dir = tmpDir();
  writeKnowledgeRepos(dir, ['https://example.com/knowledge']);
  assert.equal(findWorkspaceRoot(dir), dir);
});

test('findWorkspaceRoot walks up to find knowledge-repos.json in parent', () => {
  const parent = tmpDir();
  const child = join(parent, 'child-repo');
  mkdirSync(child);
  writeKnowledgeRepos(parent, ['https://example.com/knowledge']);
  assert.equal(findWorkspaceRoot(child), parent);
});

test('findWorkspaceRoot returns null when no workspace or knowledge-repos found', () => {
  const dir = tmpDir(); // no .trail/knowledge-repos.json, no workspace.json
  assert.equal(findWorkspaceRoot(dir), null);
});

test('findWorkspaceRoot prefers dir with knowledgeRepos over nearer workspace without', () => {
  const grandParent = tmpDir();
  const parent = join(grandParent, 'sub');
  const child = join(parent, 'project');
  mkdirSync(child, { recursive: true });
  // parent has a workspace but no knowledge repos
  makeWorkspace(parent);
  // grandParent has knowledge repos
  writeKnowledgeRepos(grandParent, ['https://example.com/knowledge']);
  assert.equal(findWorkspaceRoot(child), grandParent);
});

// ---------------------------------------------------------------------------
// Multiple knowledge repos warning detection
// ---------------------------------------------------------------------------

test('multiple knowledge repos: readKnowledgeRepos returns all', () => {
  const dir = tmpDir();
  const urls = [
    'https://gitlab.com/org/knowledge-a',
    'https://gitlab.com/org/knowledge-b',
    'https://github.com/org/knowledge-c',
  ];
  writeKnowledgeRepos(dir, urls);
  const result = readKnowledgeRepos(dir);
  assert.equal(result.length, 3);
  assert.equal(result[0], urls[0]); // first is the one --team uses
  assert.deepEqual(result, urls);
});

// ---------------------------------------------------------------------------
// BuildConfig: includeMd + mdOnlyDirs
// ---------------------------------------------------------------------------

test('patchBuildConfig persists includeMd to .trail/config.json', () => {
  const dir = tmpDir();
  makeGitRepo(dir);
  patchBuildConfig(dir, { includeMd: true });
  const cfg = readBuildConfig(dir);
  assert.equal(cfg?.includeMd, true);
  assert.ok(existsSync(join(dir, '.trail', 'config.json')));
});

test('patchBuildConfig persists mdOnlyDirs', () => {
  const dir = tmpDir();
  makeGitRepo(dir);
  patchBuildConfig(dir, { includeMd: true, mdOnlyDirs: ['specs', 'docs'] });
  const cfg = readBuildConfig(dir);
  assert.deepEqual(cfg?.mdOnlyDirs, ['specs', 'docs']);
});

test('patchBuildConfig merges: mdOnlyDirs does not erase includeMd', () => {
  const dir = tmpDir();
  makeGitRepo(dir);
  patchBuildConfig(dir, { includeMd: true });
  patchBuildConfig(dir, { mdOnlyDirs: ['specs'] });
  const cfg = readBuildConfig(dir);
  assert.equal(cfg?.includeMd, true);
  assert.deepEqual(cfg?.mdOnlyDirs, ['specs']);
});

test('.graft/config.json auto-migrates to .trail/config.json on write', () => {
  const dir = tmpDir();
  makeGitRepo(dir);
  // Simulate legacy config
  const graftDir = join(dir, '.graft');
  mkdirSync(graftDir);
  writeFileSync(join(graftDir, 'config.json'), JSON.stringify({ includeMd: true }));
  // patchBuildConfig should migrate
  patchBuildConfig(dir, { mdOnlyDirs: ['specs'] });
  // .trail/config.json should now exist with merged config
  assert.ok(existsSync(join(dir, '.trail', 'config.json')));
  // .graft/ should be gone
  assert.ok(!existsSync(graftDir), '.graft/ should have been removed after migration');
  const cfg = readBuildConfig(dir);
  assert.equal(cfg?.includeMd, true);
  assert.deepEqual(cfg?.mdOnlyDirs, ['specs']);
});

// ---------------------------------------------------------------------------
// LearningFields: issue field
// ---------------------------------------------------------------------------

test('issue field round-trips in LearningFields', async () => {
  const { readLearningFields } = await import('../src/notes/learning-fields.js');
  const fields = readLearningFields(
    { id: 'l-abc123', status: 'active', issue: 'MTD-287' },
    'test-learning.md'
  );
  assert.equal(fields.issue, 'MTD-287');
});

test('issue field accepts GitLab issue reference', async () => {
  const { readLearningFields } = await import('../src/notes/learning-fields.js');
  const fields = readLearningFields(
    { id: 'l-abc123', status: 'active', issue: '#134' },
    'test-learning.md'
  );
  assert.equal(fields.issue, '#134');
});

test('issue field accepts full URL', async () => {
  const { readLearningFields } = await import('../src/notes/learning-fields.js');
  const fields = readLearningFields(
    { id: 'l-abc123', status: 'active', issue: 'https://gitlab.com/detacoop/project/-/issues/42' },
    'test-learning.md'
  );
  assert.equal(fields.issue, 'https://gitlab.com/detacoop/project/-/issues/42');
});

test('issue field is absent when not provided', async () => {
  const { readLearningFields } = await import('../src/notes/learning-fields.js');
  const fields = readLearningFields(
    { id: 'l-abc123', status: 'active' },
    'test-learning.md'
  );
  assert.equal(fields.issue, undefined);
});

test('issue field ignores empty string', async () => {
  const { readLearningFields } = await import('../src/notes/learning-fields.js');
  const fields = readLearningFields(
    { id: 'l-abc123', status: 'active', issue: '  ' },
    'test-learning.md'
  );
  assert.equal(fields.issue, undefined);
});
