/**
 * The shim's resolution behaviour, exercised by actually running it.
 *
 * This is the regression test for the "installed graft once, still on the old
 * version" report: the shim used to take the FIRST candidate that existed, and
 * the first candidate is the absolute path baked in at `graft init` time. So
 * `npm i -g @nanonets/graft@latest` upgraded a directory the shim never looked
 * at, and the user's hooks kept loading whatever version wired the repo. The
 * shim now takes the highest-versioned candidate instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hooksShim } from '../src/claude/shim-template.js';
import { tmpRepo } from './helpers.js';

/** A fake installed @nanonets/graft whose hooks entry records that it ran. */
function fakeInstall(root: string, name: string, version: string): string {
  const pkg = join(root, name);
  const distClaude = join(pkg, 'dist', 'claude');
  mkdirSync(distClaude, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@nanonets/graft', version }));
  // CJS on purpose: no "type" field, so `import()` hands back module.exports and
  // `m.main(...)` resolves — same shape the real dist has for the shim's call.
  writeFileSync(
    join(distClaude, 'hooks.js'),
    `module.exports.main = () => require('node:fs').writeFileSync(process.env.MARKER, ${JSON.stringify(version)});\n`,
  );
  return distClaude;
}

/** Runs the shim with the given baked dir and project dir; returns the version
 * of the install that actually got loaded (or null if none did). */
function runShim(root: string, bakedDir: string, projectDir: string): string | null {
  const shimPath = join(root, 'graft-hooks.cjs');
  const marker = join(root, 'loaded.txt');
  writeFileSync(shimPath, hooksShim(bakedDir));
  const res = spawnSync(process.execPath, [shimPath, 'session-start'], {
    encoding: 'utf8',
    env: { ...process.env, MARKER: marker, CLAUDE_PROJECT_DIR: projectDir },
  });
  assert.equal(res.status, 0, `shim exited ${res.status}: ${res.stderr}`);
  return existsSync(marker) ? readFileSync(marker, 'utf8') : null;
}

// The fakes' versions sit far above any real release ON PURPOSE: the shim's
// candidate list includes the node install the TEST RUNNER itself lives under
// (`process.execPath`/../lib), so on a machine with a real `npm i -g` graft
// (0.18.0 as of this comment) that real install joins the race and outranks
// 0.11/0.9 fakes — the shim correctly loads it, the fake marker never lands,
// and the test reports a resolution the fixture never contained. The fakes
// only model relative order against each other, so they claim versions no
// real install will carry and stay hermetic either way.
const WINNER = '99.0.0';
const LOSER = '0.9.1';

test('an upgraded global install wins over the stale baked path', () => {
  const root = tmpRepo('shim-upgrade');
  const stale = fakeInstall(root, 'old-node-install', LOSER);
  fakeInstall(join(root, 'project', 'node_modules', '@nanonets'), 'graft', WINNER);
  // BAKED points at the install that `graft init` ran from — still on disk (an
  // nvm switch leaves it there), still first in the candidate list, now stale.
  assert.equal(runShim(root, stale, join(root, 'project')), WINNER);
});

test('the baked path still wins when it is the newest', () => {
  const root = tmpRepo('shim-baked-newest');
  const baked = fakeInstall(root, 'current', WINNER);
  fakeInstall(join(root, 'project', 'node_modules', '@nanonets'), 'graft', LOSER);
  assert.equal(runShim(root, baked, join(root, 'project')), WINNER);
});

test('a single candidate is used whatever its version', () => {
  const root = tmpRepo('shim-single');
  const only = fakeInstall(root, 'only', WINNER);
  mkdirSync(join(root, 'project'), { recursive: true });
  assert.equal(runShim(root, only, join(root, 'project')), WINNER);
});

test('an install with an unreadable version loses to a known one', () => {
  const root = tmpRepo('shim-noversion');
  const broken = fakeInstall(root, 'broken', '0.0.0');
  writeFileSync(join(root, 'broken', 'package.json'), 'not json');
  fakeInstall(join(root, 'project', 'node_modules', '@nanonets'), 'graft', WINNER);
  assert.equal(runShim(root, broken, join(root, 'project')), WINNER);
});

test('no candidate at all exits quietly — a hook must never fail the session', () => {
  const root = tmpRepo('shim-none');
  mkdirSync(join(root, 'project'), { recursive: true });
  assert.equal(runShim(root, join(root, 'nowhere'), join(root, 'project')), null);
});
