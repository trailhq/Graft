import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit } from '../src/claude/init.js';
import { runRetract } from '../src/hosts/retract.js';

// Never probe an installed package or start a missing-graph build/provider.
process.env.GRAFT_MCP_NPX = '1';
const owned: string[] = [];
function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graft-preservation-'));
  owned.push(dir);
  return dir;
}
after(() => { for (const dir of owned) rmSync(dir, { recursive: true, force: true }); });

for (const body of ['{ malformed', 'null', '[]', '[{"model":"user"}]', '42', '"user"', 'false']) {
  test(`invalid project settings ${body} stay byte-identical before any other installation write`, () => {
    const repo = fresh();
    const home = fresh();
    mkdirSync(join(repo, '.claude'));
    const settings = join(repo, '.claude', 'settings.json');
    writeFileSync(settings, body);
    assert.throws(() => runInit(repo, { build: false, global: false, home }), /not a readable JSON object/);
    assert.equal(readFileSync(settings, 'utf8'), body);
    assert.deepEqual(readdirSync(join(repo, '.claude')), ['settings.json']);
    assert.deepEqual(readdirSync(home), []);
    assert.equal(existsSync(join(repo, '.mcp.json')), false);
    assert.equal(existsSync(join(repo, 'graft')), false);
  });
}

test('missing project settings create normal repo wiring without home or graph writes', () => {
  const repo = fresh();
  const home = fresh();
  const result = runInit(repo, { build: false, global: false, home });
  const settings = JSON.parse(readFileSync(result.settingsPath, 'utf8'));
  assert.ok(settings.hooks.Stop);
  assert.ok(existsSync(join(repo, '.mcp.json')));
  assert.equal(result.built, false);
  assert.deepEqual(result.global, []);
  assert.deepEqual(readdirSync(home), []);
  assert.equal(existsSync(join(repo, 'graft')), false);
});

test('valid project settings preserve foreign settings and ordinary foreign handlers', () => {
  const repo = fresh();
  const home = fresh();
  mkdirSync(join(repo, '.claude'));
  const path = join(repo, '.claude', 'settings.json');
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'inert-foreign-sentinel' }] };
  writeFileSync(path, JSON.stringify({ model: 'user-choice', statusLine: { command: 'inert-user-bar' },
    permissions: { deny: ['Bash(inert-deny:*)'], allow: ['Bash(inert-allow:*)'] }, hooks: { Stop: [foreign] } }));
  const result = runInit(repo, { build: false, global: false, home });
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(settings.model, 'user-choice');
  assert.equal(settings.statusLine.command, 'inert-user-bar');
  assert.deepEqual(settings.permissions.deny, ['Bash(inert-deny:*)']);
  assert.ok(settings.permissions.allow.includes('Bash(inert-allow:*)'));
  assert.deepEqual(settings.hooks.Stop[0], foreign);
  assert.ok(result.warnings.length);
  assert.deepEqual(readdirSync(home), []);
});

for (const apply of [undefined, false, true]) {
  test(`retract apply=${String(apply)} mutates only on explicit true`, () => {
    const repo = fresh();
    const home = fresh();
    const body = '<!-- graft:start -->\nowned guidance\n<!-- graft:end -->\n';
    const path = join(repo, 'AGENTS.md');
    writeFileSync(path, body);
    mkdirSync(join(home, '.codex'));
    const config = join(home, '.codex', 'config.toml');
    const toml = '[mcp_servers.graft]\ncommand = "inert-not-executed"\n';
    writeFileSync(config, toml);
    const opts = apply === undefined ? { home } : { home, apply };
    const reports = runRetract(repo, opts);
    assert.ok(reports.some((r) => r.path === path && r.action === 'deleted'));
    if (apply === true) {
      assert.equal(existsSync(path), false);
      assert.equal(existsSync(config), false);
    } else {
      assert.equal(readFileSync(path, 'utf8'), body);
      assert.equal(readFileSync(config, 'utf8'), toml);
    }
  });
}
