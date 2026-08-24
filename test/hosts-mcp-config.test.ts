import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so these expectations are the same on every machine.
process.env.GRAFT_MCP_NPX = '1';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpConfigs, serverEntry, detectPackageRunner, launchForRunner } from '../src/hosts/mcp-config.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-mcpcfg-')); }

test('cursor/gemini/kiro get repo-local JSON entries', () => {
  const repo = fresh(); const home = fresh();
  const w = registerMcpConfigs(repo, ['cursor', 'gemini', 'kiro'], { home });
  assert.deepEqual(w.map((x) => x.action), ['created', 'created', 'created']);
  const cursor = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cursor.mcpServers.graft, { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
  assert.ok(existsSync(join(repo, '.gemini', 'settings.json')));
  assert.ok(existsSync(join(repo, '.kiro', 'settings', 'mcp.json')));
});

test('existing config keys are preserved; re-run is unchanged', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  registerMcpConfigs(repo, ['cursor'], { home });
  const cfg = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cfg.mcpServers.other, 'foreign server preserved');
  assert.ok(cfg.mcpServers.graft);
  const again = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(again.map((x) => x.action), ['unchanged']);
});

test('unparseable JSON is never clobbered', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'mcp.json'), '{ not json');
  const w = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(w.map((x) => x.action), ['skipped-unparseable']);
  assert.equal(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'), '{ not json');
});

test('agents id: codex TOML + opencode JSON, gated on home dirs', () => {
  const repo = fresh(); const home = fresh();
  assert.deepEqual(registerMcpConfigs(repo, ['agents'], { home }), [], 'nothing without home dirs');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const w = registerMcpConfigs(repo, ['agents'], { home });
  assert.equal(w.length, 2);
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.graft\]$/m);
  assert.match(toml, /"@nanonets\/graft"/);
  const oc = JSON.parse(readFileSync(join(repo, 'opencode.json'), 'utf8'));
  assert.equal(oc.mcp.graft.type, 'local');
  const again = registerMcpConfigs(repo, ['agents'], { home });
  assert.deepEqual(again.map((x) => x.action).sort(), ['unchanged', 'unchanged']);
});

test('codex TOML append preserves existing content', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  registerMcpConfigs(repo, ['agents'], { home });
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "o3"/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.match(toml, /\[mcp_servers\.graft\]/);
});

test('grok gets a repo-local TOML MCP section', () => {
  const repo = fresh(); const home = fresh();
  const w = registerMcpConfigs(repo, ['grok'], { home });
  assert.deepEqual(w.map((x) => x.action), ['created']);
  const toml = readFileSync(join(repo, '.grok', 'config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.graft\]$/m);
  assert.match(toml, /"@nanonets\/graft"/);
  const again = registerMcpConfigs(repo, ['grok'], { home });
  assert.deepEqual(again.map((x) => x.action), ['unchanged']);
});

test('JSON with non-object mcpServers value is skipped', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  const badJson = '{"mcpServers": "not-an-object"}';
  writeFileSync(join(repo, '.cursor', 'mcp.json'), badJson);
  const w = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(w.map((x) => x.action), ['skipped-unparseable']);
  assert.equal(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'), badJson);
});

// The launch command: bare binary when graft is installed, npx otherwise. Never an
// absolute path — these files are committed and shared between machines.
test('serverEntry prefers the installed binary and falls back to npx', () => {
  const saved = process.env.GRAFT_MCP_NPX;
  delete process.env.GRAFT_MCP_NPX;
  try {
    assert.deepEqual(serverEntry({ onPath: true }), { command: 'graft', args: ['mcp'] });
    assert.deepEqual(serverEntry({ onPath: false }), { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
    for (const e of [serverEntry({ onPath: true }), serverEntry({ onPath: false })]) {
      assert.ok(!e.command.startsWith('/'), 'never an absolute path — configs get shared');
    }
  } finally {
    if (saved !== undefined) process.env.GRAFT_MCP_NPX = saved;
  }
});

test('GRAFT_MCP_NPX overrides an installed binary', () => {
  process.env.GRAFT_MCP_NPX = '1';
  assert.equal(serverEntry({ onPath: true }).command, 'npx', 'the escape hatch wins');
});

function withoutNpxPin(fn: () => void): void {
  const saved = process.env.GRAFT_MCP_NPX;
  delete process.env.GRAFT_MCP_NPX;
  try { fn(); } finally {
    if (saved !== undefined) process.env.GRAFT_MCP_NPX = saved;
    else delete process.env.GRAFT_MCP_NPX;
  }
}

function lockfileRepo(name: string): string {
  const repo = fresh();
  writeFileSync(join(repo, name), '');
  return repo;
}

test('detectPackageRunner reads lockfiles in bun > pnpm > yarn > npx order', () => {
  assert.equal(detectPackageRunner(lockfileRepo('bun.lock')), 'bunx');
  assert.equal(detectPackageRunner(lockfileRepo('bun.lockb')), 'bunx');
  assert.equal(detectPackageRunner(lockfileRepo('pnpm-lock.yaml')), 'pnpm');
  assert.equal(detectPackageRunner(lockfileRepo('yarn.lock')), 'yarn');
  assert.equal(detectPackageRunner(fresh()), 'npx', 'no lockfile');
  assert.equal(detectPackageRunner(lockfileRepo('package-lock.json')), 'npx', 'npm lockfile is the default');
  const both = fresh();
  writeFileSync(join(both, 'bun.lock'), '');
  writeFileSync(join(both, 'pnpm-lock.yaml'), '');
  assert.equal(detectPackageRunner(both), 'bunx', 'bun wins when several lockfiles exist');
});

test('launchForRunner matches each package manager\'s documented dlx shape', () => {
  assert.deepEqual(launchForRunner('npx'), { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
  assert.deepEqual(launchForRunner('bunx'), { command: 'bunx', args: ['@nanonets/graft', 'mcp'] });
  assert.deepEqual(launchForRunner('pnpm'), { command: 'pnpm', args: ['dlx', '@nanonets/graft', 'mcp'] });
  assert.deepEqual(launchForRunner('yarn'), { command: 'yarn', args: ['dlx', '@nanonets/graft', 'mcp'] });
});

test('serverEntry uses the lockfile runner when graft is not on PATH', () => {
  withoutNpxPin(() => {
    assert.deepEqual(serverEntry({ onPath: false, cwd: lockfileRepo('bun.lock') }), { command: 'bunx', args: ['@nanonets/graft', 'mcp'] });
    assert.deepEqual(serverEntry({ onPath: false, cwd: lockfileRepo('pnpm-lock.yaml') }), { command: 'pnpm', args: ['dlx', '@nanonets/graft', 'mcp'] });
    assert.deepEqual(serverEntry({ onPath: false, cwd: lockfileRepo('yarn.lock') }), { command: 'yarn', args: ['dlx', '@nanonets/graft', 'mcp'] });
    assert.deepEqual(serverEntry({ onPath: false, cwd: fresh() }), { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
  });
});

test('a bun/pnpm/yarn lockfile wins over an installed binary so committed configs stay portable', () => {
  withoutNpxPin(() => {
    assert.equal(serverEntry({ onPath: true, cwd: lockfileRepo('bun.lock') }).command, 'bunx');
    assert.equal(serverEntry({ onPath: true, cwd: lockfileRepo('pnpm-lock.yaml') }).command, 'pnpm');
    assert.equal(serverEntry({ onPath: true, cwd: fresh() }).command, 'graft', 'no lockfile → still prefer PATH');
  });
});

test('--runner wins over lockfile, PATH, and GRAFT_MCP_NPX', () => {
  process.env.GRAFT_MCP_NPX = '1';
  const bun = lockfileRepo('bun.lock');
  assert.deepEqual(serverEntry({ runner: 'pnpm', onPath: true, cwd: bun }), { command: 'pnpm', args: ['dlx', '@nanonets/graft', 'mcp'] });
  assert.deepEqual(serverEntry({ runner: 'bunx' }), { command: 'bunx', args: ['@nanonets/graft', 'mcp'] });
  assert.deepEqual(serverEntry({ runner: 'yarn' }), { command: 'yarn', args: ['dlx', '@nanonets/graft', 'mcp'] });
  assert.deepEqual(serverEntry({ runner: 'npx' }), { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
});

test('re-running init updates an existing JSON graft entry to the new runner', () => {
  const repo = fresh(); const home = fresh();
  registerMcpConfigs(repo, ['cursor'], { home, runner: 'npx' });
  const first = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(first.mcpServers.graft.command, 'npx');
  const w = registerMcpConfigs(repo, ['cursor'], { home, runner: 'bunx' });
  assert.deepEqual(w.map((x) => x.action), ['updated']);
  const cfg = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers.graft, { command: 'bunx', args: ['@nanonets/graft', 'mcp'] });
});

test('re-running init updates an existing TOML graft section to the new runner', () => {
  const repo = fresh(); const home = fresh();
  const w1 = registerMcpConfigs(repo, ['grok'], { home, runner: 'npx' });
  assert.deepEqual(w1.map((x) => x.action), ['created']);
  const w2 = registerMcpConfigs(repo, ['grok'], { home, runner: 'pnpm' });
  assert.deepEqual(w2.map((x) => x.action), ['updated']);
  const toml = readFileSync(join(repo, '.grok', 'config.toml'), 'utf8');
  assert.match(toml, /command = "pnpm"/);
  assert.match(toml, /"dlx"/);
  const w3 = registerMcpConfigs(repo, ['grok'], { home, runner: 'pnpm' });
  assert.deepEqual(w3.map((x) => x.action), ['unchanged']);
});
