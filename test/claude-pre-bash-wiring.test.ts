/**
 * PreToolUse on Bash, as each install writes it: graft's repo
 * `.claude/settings.json`; under trail (#619) the `~/.claude/settings.json`
 * copy, or `.claude/settings.local.json` under `--no-global`, never the shared
 * file, which runs only session start; and Codex's `~/.codex/hooks.json`. Each
 * one is written once however often init runs, goes again with uninstall, and
 * never takes a PreToolUse hook the person wrote themselves with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pin the MCP launch command to the npx form so init never probes the machine's own install.
process.env.GRAFT_MCP_NPX = '1';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeGraftHooks, mergeGraftSettings, mergeTrailLocal, mergeTrailShared } from '../src/claude/settings-merge.js';
import { runInit } from '../src/claude/init.js';
import { globalHelpersDir, installClaudeGlobal } from '../src/hosts/claude-global.js';
import { installCodexHooks } from '../src/hosts/codex-hooks.js';
import { runRetract } from '../src/hosts/retract.js';
import { globalCopyCovers } from '../src/claude/hook-layers.js';
import { toPosixPath } from '../src/util/paths.js';
import { tmpRepo } from './helpers.js';

/** A PreToolUse hook the person wrote: it must outlive every init and uninstall. */
const THEIRS = { matcher: 'Bash', hooks: [{ type: 'command', command: '/home/dev/bin/guard.sh' }] };

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const preBashEntries = (hooks: any) => (hooks?.PreToolUse ?? []).filter((e: any) => /((graft|trail)-hooks|\/\.trail\/hook)\.cjs" pre-bash \|\| exit 0$/.test(e?.hooks?.[0]?.command ?? ''));
const failEntries = (hooks: any) => (hooks?.PostToolUseFailure ?? []).filter((e: any) => /\.cjs" post-bash-fail \|\| exit 0$/.test(e?.hooks?.[0]?.command ?? ''));

test('the repo install runs pre-bash before every Bash call, under either name', () => {
  for (const name of ['graft', 'trail'] as const) {
    const { merged } = mergeGraftSettings({}, { name });
    assert.deepEqual(merged.hooks.PreToolUse, [
      { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/${name}-hooks.cjs" pre-edit || exit 0`, timeout: 5 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/${name}-hooks.cjs" pre-bash || exit 0`, timeout: 5 }] },
    ]);
  }
});

test("under trail the shared settings run only session start; the personal file carries pre-bash and the failed-call hook", () => {
  assert.deepEqual(Object.keys(mergeTrailShared({}).hooks), ['SessionStart']);
  const local = mergeTrailLocal({}, { hooks: true }).merged;
  assert.deepEqual(local.hooks.PreToolUse, [
    { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.trail/hook.cjs" pre-edit || exit 0', timeout: 5 }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.trail/hook.cjs" pre-bash || exit 0', timeout: 5 }] },
  ]);
  assert.deepEqual(local.hooks.PostToolUseFailure, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.trail/hook.cjs" post-bash-fail || exit 0', timeout: 5 }] },
  ]);
  // A person's own PreToolUse in their personal file stays first, and a second merge changes nothing.
  const mine = mergeTrailLocal({ hooks: { PreToolUse: [THEIRS] } }, { hooks: true }).merged;
  assert.deepEqual(mine.hooks.PreToolUse[0], THEIRS);
  assert.deepEqual(mergeTrailLocal(mine, { hooks: true }).merged, mine);
});

test('re-running the repo merge keeps one pre-bash entry, after the person\'s own', () => {
  const once = mergeGraftSettings({ hooks: { PreToolUse: [THEIRS] } }, { name: 'trail' }).merged;
  const twice = mergeGraftSettings(once, { name: 'trail' }).merged;
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.PreToolUse.length, 3, "theirs, then the file's learnings before an edit, then pre-bash");
  assert.deepEqual(twice.hooks.PreToolUse[0], THEIRS);
  assert.equal(preBashEntries(twice.hooks).length, 1);
});

test('the user-level merge names the shim by absolute path, and converges', () => {
  const helpers = '/home/dev/.claude/helpers';
  const once = mergeGraftHooks({ hooks: { PreToolUse: [THEIRS] } }, helpers).merged;
  assert.deepEqual(once.hooks.PreToolUse, [
    THEIRS,
    { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node "${helpers}/graft-hooks.cjs" pre-edit || exit 0`, timeout: 5 }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${helpers}/graft-hooks.cjs" pre-bash || exit 0`, timeout: 5 }] },
  ]);
  assert.deepEqual(mergeGraftHooks(once, helpers).merged, once);
});

test('trail init wires PreToolUse once, in ~/.claude, never in the shared settings, and uninstall takes only ours', () => {
  const repo = tmpRepo('pre-bash-wire-repo');
  const home = tmpRepo('pre-bash-wire-home');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [THEIRS] } }));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [THEIRS] } }));

  runInit(repo, { build: false, home, brand: 'trail' });
  runInit(repo, { build: false, home, brand: 'trail' });
  const repoHooks = readJson(join(repo, '.claude', 'settings.json')).hooks;
  const userHooks = readJson(join(home, '.claude', 'settings.json')).hooks;
  assert.deepEqual(repoHooks.PreToolUse, [THEIRS], "the team's own hook, and none of ours in the shared file");
  assert.equal(readJson(join(repo, '.claude', 'settings.local.json')).hooks, undefined, '~/.claude carries them, so the personal file has none');
  assert.deepEqual(userHooks.PreToolUse[0], THEIRS);
  assert.equal(preBashEntries(userHooks).length, 1, 'one in ~/.claude');
  assert.equal(failEntries(userHooks).length, 1, 'and one failed-call hook');
  assert.equal(preBashEntries(userHooks)[0].hooks[0].command, `node "${toPosixPath(globalHelpersDir(home))}/graft-hooks.cjs" pre-bash || exit 0`);

  // A repo set up before 0.23 still had the repo copy too: it stands down, so a decision is sent once.
  assert.equal(globalCopyCovers('pre-bash', join(repo, '.trail', 'hook.cjs'), home, {}), true);

  runRetract(repo, { home, apply: true });
  assert.deepEqual(readJson(join(repo, '.claude', 'settings.json')).hooks.PreToolUse, [THEIRS]);
  assert.deepEqual(readJson(join(home, '.claude', 'settings.json')).hooks.PreToolUse, [THEIRS]);
});

test('trail init --no-global wires pre-bash and the failed-call hook once, in the personal file, and uninstall takes them', () => {
  const repo = tmpRepo('pre-bash-wire-local');
  const home = tmpRepo('pre-bash-wire-local-home');
  runInit(repo, { build: false, home, global: false, brand: 'trail' });
  runInit(repo, { build: false, home, global: false, brand: 'trail' });
  const local = readJson(join(repo, '.claude', 'settings.local.json')).hooks;
  assert.equal(preBashEntries(local).length, 1);
  assert.equal(failEntries(local).length, 1);
  assert.equal(preBashEntries(readJson(join(repo, '.claude', 'settings.json')).hooks).length, 0, 'never in the shared file');
  // Nothing in ~/.claude answers, so the repo's copy does.
  assert.equal(globalCopyCovers('pre-bash', join(repo, '.trail', 'hook.cjs'), home, {}), false);

  runRetract(repo, { home, apply: true, global: false });
  for (const f of ['settings.json', 'settings.local.json']) assert.equal(existsSync(join(repo, '.claude', f)), false, f);
});

test('Codex gets pre-bash on Bash once, keeps its own PreToolUse hooks, and loses ours on uninstall', () => {
  const home = tmpRepo('pre-bash-wire-codex');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const cfg = join(home, '.codex', 'hooks.json');
  writeFileSync(cfg, JSON.stringify({ hooks: { PreToolUse: [THEIRS] } }));

  installCodexHooks(home);
  const shim = join(home, '.codex', 'hooks', 'graft', 'graft-hooks.cjs');
  assert.deepEqual(readJson(cfg).hooks.PreToolUse, [
    THEIRS,
    { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${shim}" pre-bash || exit 0`, timeout: 5 }] },
  ]);
  assert.deepEqual(installCodexHooks(home).map((w) => w.action), ['unchanged', 'unchanged'], 'idempotent');

  runRetract(tmpRepo('pre-bash-wire-codex-repo'), { home, apply: true, global: true });
  assert.deepEqual(readJson(cfg).hooks.PreToolUse, [THEIRS]);
});

test('installClaudeGlobal alone wires pre-bash too', () => {
  const home = tmpRepo('pre-bash-wire-global');
  installClaudeGlobal(home);
  assert.equal(preBashEntries(readJson(join(home, '.claude', 'settings.json')).hooks).length, 1);
});

test('a repo settings.json that is not plain JSON is left as it was, and init says so', () => {
  for (const text of ['{\n  // the person\'s guard\n  "hooks": {}\n}\n', '{ "hooks": { "PreToolUse": [] }, }\n', '[]\n']) {
    const repo = tmpRepo('pre-bash-wire-jsonc');
    const home = tmpRepo('pre-bash-wire-jsonc-home');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), text);
    const r = runInit(repo, { build: false, home, brand: 'trail' });
    assert.equal(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'), text, 'untouched');
    assert.ok(r.warnings.some((w) => w.includes('.claude/settings.json')), r.warnings.join('\n'));
    assert.equal(preBashEntries(readJson(join(home, '.claude', 'settings.json')).hooks).length, 1, 'the ~/.claude copy still covers it');
  }
  // An empty file is a new one: it gets the shared session-start entry.
  const repo = tmpRepo('pre-bash-wire-empty');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), '\n');
  runInit(repo, { build: false, home: tmpRepo('pre-bash-wire-empty-home'), brand: 'trail' });
  assert.deepEqual(Object.keys(readJson(join(repo, '.claude', 'settings.json')).hooks), ['SessionStart']);
});

test('a settings.json left as it was keeps the old shims it still runs', () => {
  const repo = tmpRepo('pre-bash-wire-jsonc-old');
  const home = tmpRepo('pre-bash-wire-jsonc-old-home');
  mkdirSync(join(repo, '.claude', 'helpers'), { recursive: true });
  const text = '{\n  // ours\n  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "node \\"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/trail-hooks.cjs\\" stop" }] }] }\n}\n';
  writeFileSync(join(repo, '.claude', 'settings.json'), text);
  writeFileSync(join(repo, '.claude', 'helpers', 'trail-hooks.cjs'), 'old');
  runInit(repo, { build: false, home, brand: 'trail' });
  assert.equal(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'), text);
  assert.ok(existsSync(join(repo, '.claude', 'helpers', 'trail-hooks.cjs')), 'the shim its hooks name is still there');
});
