/**
 * Every PreToolUse command Trail writes fails open at the shell, not only in
 * Node. Copilot CLI reads the repo's `.claude/settings.json` and denies the
 * tool call when a PreToolUse hook exits non-zero, so a command whose script
 * can't be found (started in a subfolder without CLAUDE_PROJECT_DIR, the shim
 * gone after an uninstall, no node on PATH) would deny every shell command.
 * These tests run the exact command strings the installs write, through the
 * shell a host runs them in (sh, or Git Bash for Claude Code on Windows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mergeGraftHooks, mergeGraftSettings } from '../src/claude/settings-merge.js';
import { installCodexHooks } from '../src/hosts/codex-hooks.js';
import { globalCopyCovers } from '../src/claude/hook-layers.js';
import { hooksShim } from '../src/claude/shim-template.js';
import { toPosixPath } from '../src/util/paths.js';
import { hookShell, tmpRepo } from './helpers.js';

const PAYLOAD = JSON.stringify({ session_id: 's1', cwd: '/tmp/x', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });

const preBashCommand = (hooks: any): string => hooks.PreToolUse.at(-1).hooks[0].command;

/** The repo's PreToolUse command, the user-level one and Codex's, as each install writes it. */
function commands(home: string): Record<string, string> {
  mkdirSync(join(home, '.codex'), { recursive: true });
  installCodexHooks(home);
  return {
    'repo (trail)': preBashCommand(mergeGraftSettings({}, { name: 'trail' }).merged.hooks),
    'repo (graft)': preBashCommand(mergeGraftSettings({}, { name: 'graft' }).merged.hooks),
    '~/.claude': preBashCommand(mergeGraftHooks({}, toPosixPath(join(home, '.claude', 'helpers'))).merged.hooks),
    codex: preBashCommand(JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks),
  };
}

const SHELL = hookShell();
const NO_SHELL = SHELL === null && 'no Git Bash on this Windows machine, the shell Claude Code runs hooks in';

/** Runs `command` through the shell hosts run hooks in (sh, or Git Bash on Windows: cmd can't expand `${CLAUDE_PROJECT_DIR:-.}`). */
function run(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(command, { shell: SHELL ?? true, cwd, input: PAYLOAD, encoding: 'utf8', timeout: 20000, env });
}

/** The environment of a host started somewhere CLAUDE_PROJECT_DIR isn't set. */
function hostEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, '.trail'), ...extra };
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

test('every PreToolUse command Trail writes ends in a shell-level fail-open', () => {
  for (const [where, command] of Object.entries(commands(tmpRepo('fail-open-forms')))) {
    assert.match(command, /^node "[^"]+-hooks\.cjs" pre-bash \|\| exit 0$/, where);
  }
});

test('a PreToolUse command whose script is missing exits 0 and prints nothing on stdout', { skip: NO_SHELL }, () => {
  const home = tmpRepo('fail-open-missing');
  // A subfolder of a project with no .claude/ of its own, as when a host
  // starts there without CLAUDE_PROJECT_DIR; every shim path is missing.
  const sub = join(home, 'project', 'packages', 'api');
  mkdirSync(sub, { recursive: true });
  for (const [where, command] of Object.entries(commands(home))) {
    rmSync(join(home, '.codex', 'hooks', 'graft', 'graft-hooks.cjs'), { force: true });
    const r = run(command, sub, hostEnv(home));
    assert.equal(r.status, 0, `${where}: ${command}\n${r.stderr}`);
    assert.equal(r.stdout, '', where);
  }
});

test('a PreToolUse command exits 0 with no output when node is not on PATH', { skip: process.platform === 'win32' ? 'sh only' : false }, () => {
  const home = tmpRepo('fail-open-no-node');
  const emptyBin = join(home, 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });
  for (const [where, command] of Object.entries(commands(home))) {
    const r = run(command, home, hostEnv(home, { PATH: emptyBin }));
    assert.equal(r.status, 0, `${where}: ${r.stderr}`);
    assert.equal(r.stdout, '', where);
  }
});

test('the fail-open form still runs the shim with the event, and its answer reaches the host', { skip: NO_SHELL }, () => {
  const project = tmpRepo('fail-open-present');
  const helpers = join(project, '.claude', 'helpers');
  mkdirSync(helpers, { recursive: true });
  const ran = join(project, 'ran.txt');
  // A stand-in shim: records its event and answers, then exits non-zero,
  // which the command must still turn into 0.
  writeFileSync(join(helpers, 'trail-hooks.cjs'), `require('fs').writeFileSync(${JSON.stringify(ran)}, process.argv[2]);\nprocess.stdout.write('{"ok":1}');\nprocess.exit(3);\n`);
  const command = preBashCommand(mergeGraftSettings({}, { name: 'trail' }).merged.hooks);
  const r = run(command, project, { ...hostEnv(project), CLAUDE_PROJECT_DIR: project });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '{"ok":1}');
  assert.equal(readFileSync(ran, 'utf8'), 'pre-bash');
});

test('the repo copy still stands down for the ~/.claude PreToolUse command in its fail-open form', () => {
  const home = tmpRepo('fail-open-layers');
  const helpers = join(home, '.claude', 'helpers');
  mkdirSync(helpers, { recursive: true });
  writeFileSync(join(helpers, 'graft-hooks.cjs'), hooksShim());
  const { merged } = mergeGraftHooks({}, toPosixPath(helpers));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(merged));
  const repoShim = join(tmpRepo('fail-open-layers-repo'), '.claude', 'helpers', 'trail-hooks.cjs');
  assert.equal(globalCopyCovers('pre-bash', repoShim, home, {}), true, 'pre-bash');
  assert.equal(globalCopyCovers('prompt', repoShim, home, {}), true, 'the other events are unchanged');
});
