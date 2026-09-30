/**
 * The shared config-writer helpers. `readJsonObject` is the load-or-skip half of
 * every installer, so its three outcomes are pinned here: a missing file is a
 * fresh create, a plain object is merged into, and anything else is left exactly
 * as the user wrote it (never clobbered).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonObject, isGraftEntry, writeOwned } from '../src/hosts/config-write.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-config-write-')); }

test('readJsonObject: a missing file is a fresh create, not unparseable', () => {
  const r = readJsonObject(join(fresh(), 'nope.json'));
  assert.notEqual(r, 'unparseable');
  assert.deepEqual(r, { root: {}, existed: false });
});

test('readJsonObject: a plain object is returned for merging', () => {
  const p = join(fresh(), 'hooks.json');
  writeFileSync(p, JSON.stringify({ version: 1, hooks: {} }));
  const r = readJsonObject(p);
  assert.notEqual(r, 'unparseable');
  assert.deepEqual(r, { root: { version: 1, hooks: {} }, existed: true });
});

test('readJsonObject: invalid JSON is unparseable (distinct from missing, so a broken file is never overwritten)', () => {
  const p = join(fresh(), 'hooks.json');
  writeFileSync(p, '{ not json');
  assert.equal(readJsonObject(p), 'unparseable');
});

test('readJsonObject: a top-level array or primitive is unparseable — we only merge into an object', () => {
  const dir = fresh();
  const arr = join(dir, 'arr.json'); writeFileSync(arr, '[1,2,3]');
  const num = join(dir, 'num.json'); writeFileSync(num, '42');
  const nul = join(dir, 'nul.json'); writeFileSync(nul, 'null');
  assert.equal(readJsonObject(arr), 'unparseable');
  assert.equal(readJsonObject(num), 'unparseable');
  assert.equal(readJsonObject(nul), 'unparseable');
});

test('isGraftEntry matches graft-owned entries and tolerates undefined', () => {
  assert.ok(isGraftEntry({ command: 'node /x/graft-hooks.cjs post-edit' }));
  assert.ok(!isGraftEntry({ command: 'other-tool.sh' }));
  assert.doesNotThrow(() => isGraftEntry(undefined));
  assert.equal(isGraftEntry(undefined), false);
});

test('writeOwned is idempotent: created, then unchanged', () => {
  const p = join(fresh(), 'shim.cjs');
  assert.equal(writeOwned('x', p, 'hello').action, 'created');
  assert.equal(writeOwned('x', p, 'hello').action, 'unchanged');
  assert.equal(writeOwned('x', p, 'world').action, 'updated');
  assert.equal(readFileSync(p, 'utf8'), 'world');
});

test('writeOwned replaces the file instead of truncating it in place', () => {
  // A host config is written by one entry point while another reads it (project
  // hook / user-level hook / MCP boot all converge on `runInit` on a fresh
  // checkout). An in-place write hands that reader an empty file mid-save, which
  // its own reader then treats as "no settings". Asserting the inode moves is the
  // observable form of "the rename happened" — a truncate-in-place keeps it.
  const dir = fresh();
  const p = join(dir, 'settings.json');
  assert.equal(writeOwned('x', p, '{"a":1}').action, 'created');
  // The inode is the observable form of "the rename happened" — a truncate-in-place
  // keeps it. Not a property Windows reports reliably, so the identity check is
  // POSIX-only and the content assertions below cover every platform.
  const before = process.platform === 'win32' ? undefined : statSync(p);
  assert.equal(writeOwned('x', p, '{"a":2}').action, 'updated');
  if (before) assert.notEqual(statSync(p).ino, before.ino, 'the target was replaced, not truncated');
  assert.equal(readFileSync(p, 'utf8'), '{"a":2}');
  // And the scratch file is not left behind for something to clean up later.
  assert.deepEqual(readdirSync(dir), ['settings.json']);
});

test('writeOwned creates missing parent directories before staging the scratch file', () => {
  const p = join(fresh(), 'nested', 'deeper', 'settings.json');
  assert.equal(writeOwned('x', p, '{"a":1}').action, 'created');
  assert.equal(readFileSync(p, 'utf8'), '{"a":1}');
});
