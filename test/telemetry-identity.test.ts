/**
 * The identifiers. The claim being tested is narrow and important: both ids are
 * random, both are stable, and neither is derived from anything about the user,
 * the machine, or the repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { installId, patchState, readState, repoId, statePath } from '../src/telemetry/identity.js';
import { tmpRepo } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the install id is a random uuid, minted once and then stable', () => {
  const home = tmpRepo('id-install');
  const first = installId(home);
  assert.match(first.id, UUID);
  assert.equal(first.firstRun, true);
  const second = installId(home);
  assert.equal(second.id, first.id);
  assert.equal(second.firstRun, false, 'first_run fires exactly once per machine');
});

test('two machines get unrelated ids — nothing is derived from the environment', () => {
  const a = installId(tmpRepo('id-a')).id;
  const b = installId(tmpRepo('id-b')).id;
  assert.notEqual(a, b);
});

test('the repo id is random, not a hash of the git remote', () => {
  const repo = tmpRepo('id-repo');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/secret-repo.git'], { cwd: repo });
  const id = repoId(repo);
  assert.match(id, UUID);
  assert.equal(id, repoId(repo), 'stable across calls');
  // The whole point of random-over-hashed: we could not confirm a guess at the
  // remote even if we tried, because the id has no relationship to it.
  const stored = readFileSync(join(repo, 'graft', '.cache', 'telemetry-repo-id.json'), 'utf8');
  assert.equal(stored.includes('acme'), false);
  assert.equal(stored.includes('secret-repo'), false);
});

test('two checkouts of the same repo look like two repos', () => {
  const a = repoId(tmpRepo('id-clone-a'));
  const b = repoId(tmpRepo('id-clone-b'));
  assert.notEqual(a, b);
});

test('minting the repo id does not touch .gitignore or any tracked file', () => {
  const repo = tmpRepo('id-no-gitignore');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  repoId(repo);
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), 'node_modules\n');
});

test('an unwritable home yields an ephemeral id rather than throwing', () => {
  // A "home" that is actually a file: every write beneath it must fail.
  const dir = tmpRepo('id-unwritable');
  const blocked = join(dir, 'blocker');
  writeFileSync(blocked, 'x');
  const r = installId(blocked);
  assert.match(r.id, UUID);
  assert.equal(r.firstRun, false, 'a machine that cannot persist must not re-send first_run forever');
});

test('patchState merges rather than replacing', () => {
  const home = tmpRepo('id-patch');
  mkdirSync(join(home, '.graft'), { recursive: true });
  installId(home);
  patchState({ enabled: false }, home);
  patchState({ noticeShownAt: '2026-01-01T00:00:00Z' }, home);
  const st = readState(home);
  assert.equal(st?.enabled, false);
  assert.equal(st?.noticeShownAt, '2026-01-01T00:00:00Z');
  assert.match(st?.installId ?? '', UUID, 'the id survives every patch');
});

test('state lives in ~/.graft, beside the update-check cache', () => {
  assert.equal(statePath('/home/x'), join('/home/x', '.graft', 'telemetry.json'));
});
