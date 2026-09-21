import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTS, detectHosts, hostIds, type DetectProbe } from '../src/hosts/registry.js';
import { statSync } from 'node:fs';

function probeFor(home: string, repo: string): DetectProbe {
  return {
    home, repo,
    dirExists: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  };
}
function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-registry-')); }

test('registry exposes the known hosts', () => {
  assert.deepEqual(hostIds().sort(), ['adal', 'agents', 'antigravity', 'copilot', 'cursor', 'droid', 'gemini', 'grok', 'hermes', 'kiro', 'pi', 'project-agents', 'windsurf']);
  for (const h of HOSTS) {
    assert.ok(h.relPath.length > 0);
    assert.ok(h.content().length > 0);
  }
});

test('nothing detected on a bare machine and bare repo', () => {
  assert.deepEqual(detectHosts(probeFor(fresh(), fresh())), []);
});

test('home config dirs light up their hosts', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.cursor'));
  mkdirSync(join(home, '.gemini'));
  mkdirSync(join(home, '.codex'));
  const ids = detectHosts(probeFor(home, repo)).map((h) => h.id).sort();
  assert.deepEqual(ids, ['agents', 'cursor', 'gemini', 'project-agents']);
});

test('project-agents lights up from any standard-reader home dir or a repo .agents dir', () => {
  const repo = fresh();
  for (const dir of [['.codex'], ['.config', 'opencode'], ['.factory'], ['.pi']] as const) {
    const home = fresh();
    mkdirSync(join(home, ...dir), { recursive: true });
    assert.ok(
      detectHosts(probeFor(home, repo)).some((h) => h.id === 'project-agents'),
      `~/${join(...dir)} should detect project-agents`,
    );
  }
  const home = fresh();
  mkdirSync(join(repo, '.agents'));
  assert.ok(detectHosts(probeFor(home, repo)).some((h) => h.id === 'project-agents'), 'repo .agents/ detects');
});

test('repo-local markers also light up hosts', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(repo, '.github'));
  mkdirSync(join(repo, '.kiro'));
  const ids = detectHosts(probeFor(home, repo)).map((h) => h.id).sort();
  assert.deepEqual(ids, ['copilot', 'kiro']);
});

test('~/.adal lights up the adal host', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.adal'));
  const ids = detectHosts(probeFor(home, repo)).map((h) => h.id).sort();
  assert.deepEqual(ids, ['adal']);
});

test('repo-local .adal also lights up the adal host', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(repo, '.adal'));
  const ids = detectHosts(probeFor(home, repo)).map((h) => h.id).sort();
  assert.deepEqual(ids, ['adal']);
});

test('~/.grok lights up the grok host', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, '.grok'));
  const ids = detectHosts(probeFor(home, repo)).map((h) => h.id).sort();
  assert.deepEqual(ids, ['grok']);
});

test('repo-local .grok also lights up the grok host', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(repo, '.grok'));
  const ids = detectHosts(probeFor(home, repo)).map((h) => h.id).sort();
  assert.deepEqual(ids, ['grok']);
});

test('~/.hermes or AppData/Local/hermes lights up the hermes host', () => {
  const home = fresh(); const repo = fresh();
  mkdirSync(join(home, 'AppData', 'Local', 'hermes'), { recursive: true });
  const ids = detectHosts(probeFor(home, repo)).map((h) => h.id).sort();
  assert.deepEqual(ids, ['hermes']);
  assert.ok(HOSTS.find((h) => h.id === 'hermes')?.relPath === 'AGENTS.md');
});
