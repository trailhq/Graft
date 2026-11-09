/**
 * Phase 2 c8 (4.17, D137, Q3): `trail status` says, when Trail's Codex hooks are there, how to trust them (until a
 * trust record is on for each) and, while Codex is tier B, that Trail keeps nothing new there yet. `trail init`
 * prints the trust line after it wires Codex. Temp homes only; the real ~/.codex is never read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodexHooks } from '../src/hosts/codex-hooks.js';
import { CODEX_COPY, codexStatusLines } from '../src/hosts/codex-trust.js';

function homes(withCodex: boolean): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'c8-status-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  if (withCodex) {
    mkdirSync(join(home, '.codex'), { recursive: true });
    installCodexHooks(home);
  }
  return { root, env: { HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), TRAIL_HOME: join(root, 'trail') } };
}

test('codexStatusLines: the trust line and the tier B line with Trail\'s Codex hooks; nothing without them', () => {
  const a = homes(true);
  const b = homes(false);
  try {
    assert.deepEqual(codexStatusLines(a.env), [CODEX_COPY.trust, CODEX_COPY.notTierA]);
    assert.deepEqual(codexStatusLines(b.env), []);
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});

test('trail status prints the Codex lines under a codex row', () => {
  const h = homes(true);
  try {
    const repo = join(h.root, 'repo');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'src', 'bin', 'trail.ts'), 'status', repo], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...h.env, DO_NOT_TRACK: '1', CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_CLOUD: undefined, TRAIL_TIER_CODEX: undefined },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`codex       ${CODEX_COPY.trust}`), r.stdout);
    assert.ok(r.stdout.includes(`codex       ${CODEX_COPY.notTierA}`), r.stdout);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('trail init tells a Codex user to trust the hooks in /hooks, in its short output too', () => {
  const h = homes(false);
  mkdirSync(join(h.env.HOME!, '.codex'), { recursive: true });
  try {
    const repo = join(h.root, 'repo');
    mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    for (const extra of [[], ['--verbose']]) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'src', 'bin', 'trail.ts'), 'init', repo, '--agents', 'agents', '--no-build', ...extra], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, ...h.env, DO_NOT_TRACK: '1', TRAIL_NO_LOOK_BACK: '1', TRAIL_NO_FETCH: '1', CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_CLOUD: undefined },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(`${r.stdout}${r.stderr}`.includes(CODEX_COPY.trust), `${extra.join(' ') || 'short'}:\n${r.stderr}`);
    }
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
