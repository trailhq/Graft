import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { repoId } from '../src/telemetry/identity.js';
import { track } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import { CI_ENV_VARS } from '../src/telemetry/gate.js';
import { cacheDir, resolveContextDir } from '../src/util/state.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// --import resolves a bare package from the child's cwd, which is intentionally
// a scratch repo/caller here. Resolve the loader beside this test instead.
const tsxLoader = import.meta.resolve('tsx');

function sandbox(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'graft-telemetry-dir-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const external = join(base, 'graph');
  mkdirSync(repo); mkdirSync(join(home, '.graft'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'app.ts'), 'export function greet() { return "hello"; }\n');
  const now = Date.now();
  // Keep the actual telemetry gates open, but prevent detached sends and upkeep.
  writeFileSync(join(home, '.graft', 'telemetry.json'), JSON.stringify({
    installId: '00000000-0000-4000-8000-000000000000',
    enabled: true, noticeShownAt: '2026-01-01T00:00:00Z',
    firstRunAt: '2026-01-01T00:00:00Z', flushedAt: now,
  }));
  writeFileSync(join(home, '.graft', 'update-check.json'), JSON.stringify({ latest: null, checkedAt: now }));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, DO_NOT_TRACK: '0',
    GRAFT_POSTHOG_KEY: 'phc_test_context_dir', GRAFT_POSTHOG_HOST: 'http://127.0.0.1:1',
    GRAFT_NO_GITIGNORE: '', GRAFT_NO_REFRESH: '1', GRAFT_NO_AUTOPUSH: '1',
  };
  for (const key of CI_ENV_VARS) delete env[key];
  delete env.GRAFT_DIR;
  return { base, repo, home, external, env };
}

function run(repo: string, env: NodeJS.ProcessEnv, args: string[], success = true, cwd = repo): void {
  const child = spawnSync(process.execPath, ['--import', tsxLoader, cli, ...args], {
    cwd, env, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(child.error, undefined);
  if (success) assert.equal(child.status, 0, child.stderr + child.stdout);
  else assert.notEqual(child.status, 0, 'the blocked context directory must fail the build');
}

function storedId(dir: string): string {
  return JSON.parse(readFileSync(join(dir, '.cache', 'telemetry-repo-id.json'), 'utf8')).repoId;
}

test('CLI telemetry repo ID follows --dir without creating a default cache', t => {
  const { repo, home, external, env } = sandbox(t);
  env.GRAFT_DIR = join(repo, 'env-graph');
  run(repo, env, ['build', repo, '--dir', external]);
  const id = storedId(external);
  assert.equal(existsSync(join(repo, 'graft')), false);
  assert.equal(existsSync(env.GRAFT_DIR), false, 'the explicit flag outranks GRAFT_DIR');
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.equal(existsSync(join(repo, '.ignore')), false, 'an external graph is outside the repo');
  const build = peek(home).find(e => e.event === 'build_completed');
  assert.equal(build?.properties.repo_id, id);
  assert.equal(JSON.stringify(build).includes(external), false, 'context paths stay local');
  // A retrieval also uses its selected graph for the repo identity.
  run(repo, env, ['map', repo, '--dir', external]);
  assert.equal(storedId(external), id, 'build and query share a stable repo ID');
  assert.equal(peek(home).find(e => e.event === 'query')?.properties.repo_id, id);
  assert.equal(existsSync(join(repo, 'graft')), false);
});

test('CLI env-only and default builds preserve their selected caches and ignore behavior', t => {
  const { repo, external, env } = sandbox(t);
  env.GRAFT_DIR = external;
  run(repo, env, ['build', repo]);
  assert.ok(storedId(external));
  assert.equal(existsSync(join(repo, 'graft')), false);
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), 'node_modules/\n');
  delete env.GRAFT_DIR;
  run(repo, env, ['build', repo]);
  assert.ok(storedId(join(repo, 'graft')));
  assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /\/graft\//);
});

test('a failed --dir build does not fall back to the default telemetry cache', t => {
  const { repo, home, external, env } = sandbox(t);
  writeFileSync(external, 'a file cannot hold a graph');
  run(repo, env, ['build', repo, '--dir', external], false);
  assert.equal(existsSync(join(repo, 'graft')), false);
  assert.ok(peek(home).some(e => e.event === 'build_failed'));
});

test('a relative explicit --dir uses the same directory as the actual CLI graph', t => {
  const { repo, env } = sandbox(t);
  run(repo, env, ['build', repo, '--dir', 'custom-graph']);
  assert.ok(storedId(join(repo, 'custom-graph')));
  assert.equal(existsSync(join(repo, 'graft')), false);
});

test('init telemetry honors --dir even when no build is requested', t => {
  const { repo, home, external, env } = sandbox(t);
  run(repo, env, ['init', repo, '--agents', 'agents', '--no-build', '--no-global', '--no-hooks', '--no-mcp', '--dir', external]);
  const id = storedId(external);
  assert.equal(existsSync(join(repo, 'graft', '.cache', 'telemetry-repo-id.json')), false);
  assert.equal(peek(home).find(e => e.event === 'init_completed')?.properties.repo_id, id);
});

test('relative env directory from another cwd shares one identity across build and queries', t => {
  const { base, repo, home, env } = sandbox(t);
  const caller = join(base, 'caller'); mkdirSync(caller);
  env.GRAFT_DIR = 'env-graph';
  const selected = join(caller, env.GRAFT_DIR);
  run(repo, env, ['build', repo], true, caller);
  const id = storedId(selected);
  run(repo, env, ['ask', 'greet', repo], true, caller);
  assert.equal(peek(home).find(e => e.event === 'query')?.properties.repo_id, id);
  run(repo, env, ['map', repo], true, caller);
  const events = peek(home).filter(e => e.event === 'query');
  assert.equal(events.length, 2);
  assert.ok(events.every(e => e.properties.repo_id === id));
  assert.equal(existsSync(join(repo, 'env-graph')), false);
  assert.equal(existsSync(join(repo, 'graft')), false);
});

test('MCP query telemetry uses the same explicit graph cache as the tool', async t => {
  const { repo, home, external, env } = sandbox(t);
  run(repo, env, ['build', repo, '--dir', external]);
  const id = storedId(external);
  const child = spawn(process.execPath, ['--import', tsxLoader, cli, 'mcp', repo, '--dir', external], {
    cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const result = await new Promise<{ isError?: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP tool timed out: ${stderr}`)), 30_000);
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const response = JSON.parse(line);
          if (response.id === 2) { clearTimeout(timer); resolve(response.result); }
        }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`MCP exited before the tool response: ${stderr}`)); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'graft_repo_map', arguments: {} } }) + '\n');
    });
    assert.equal(result.isError, false);
    assert.equal(peek(home).find(e => e.event === 'query' && e.properties.surface === 'mcp')?.properties.repo_id, id);
    assert.equal(existsSync(join(repo, 'graft', '.cache', 'telemetry-repo-id.json')), false);
  } finally {
    const exited = child.pid !== undefined && child.exitCode === null && child.signalCode === null
      ? once(child, 'exit').catch(() => {}) : Promise.resolve();
    child.kill();
    await exited;
  }
});

test('relative GRAFT_DIR remains rooted at the repository for env-only identities', t => {
  const { repo } = sandbox(t);
  const previous = process.env.GRAFT_DIR;
  process.env.GRAFT_DIR = '.repo-docs/graph';
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_DIR; else process.env.GRAFT_DIR = previous; });
  const id = repoId(repo);
  assert.equal(storedId(join(repo, '.repo-docs', 'graph')), id);
  assert.equal(existsSync(join(repo, 'graft')), false);
});

test('cross-drive absolute context overrides stay explicit rather than gaining a repo prefix', () => {
  const selected = 'F:\\scratch\\graph';
  assert.equal(resolveContextDir('C:\\repo', selected), selected);
  assert.equal(win32.normalize(cacheDir('C:\\repo', selected)), 'F:\\scratch\\graph\\.cache');
});

test('TrackContext carries the selected cache locally without exposing the path', t => {
  const { repo, home, external } = sandbox(t);
  const previousKey = process.env.GRAFT_POSTHOG_KEY;
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_context_dir';
  t.after(() => { if (previousKey === undefined) delete process.env.GRAFT_POSTHOG_KEY; else process.env.GRAFT_POSTHOG_KEY = previousKey; });
  const ev = track('query', { command: 'map', surface: 'cli' }, { repo, contextDir: external, home, env: {} });
  assert.ok(ev);
  assert.equal(ev.properties.repo_id, storedId(external));
  assert.equal(JSON.stringify(ev).includes(external), false);
  assert.equal(existsSync(join(repo, 'graft')), false);
});
