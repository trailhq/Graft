/**
 * D138 (3): the Codex typed-line key (P30, R7) is its own file,
 * `~/.trail/state/typed-key`, never `~/.trail/key` (that file belongs to
 * another feature and may predate skills). Synthetic homes only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexTypedSha, noteCodexPrompt } from '../src/trace/codex.js';
import type { SkillSessionState } from '../src/trace/types.js';

function home(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'c8-key-'));
  const trail = join(root, 'trail');
  mkdirSync(trail, { recursive: true });
  return { root, env: { HOME: join(root, 'home'), TRAIL_HOME: trail } };
}

test('the prompt hook makes state/typed-key (0600, 64 hex) and never reads or writes ~/.trail/key', () => {
  const h = home();
  try {
    const other = 'a'.repeat(64);
    writeFileSync(join(h.env.TRAIL_HOME!, 'key'), `${other}\n`, { mode: 0o600 });
    const st = { codex: { meta: null, typedShas: [] } } as unknown as SkillSessionState;
    noteCodexPrompt(st, 'ship it', h.env);
    const file = join(h.env.TRAIL_HOME!, 'state', 'typed-key');
    assert.ok(existsSync(file), 'the key is made where D138 puts it');
    if (process.platform !== 'win32') assert.equal(lstatSync(file).mode & 0o777, 0o600);
    const key = readFileSync(file, 'utf8').trim();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(h.env.TRAIL_HOME!, 'key'), 'utf8'), `${other}\n`, 'the other file is untouched');
    const withOther = createHmac('sha256', Buffer.from(other, 'hex')).update('ship it').digest('hex').slice(0, 16);
    const withOwn = createHmac('sha256', Buffer.from(key, 'hex')).update('ship it').digest('hex').slice(0, 16);
    assert.deepEqual(st.codex!.typedShas, [withOwn]);
    assert.notEqual(withOwn, withOther, 'never keyed by ~/.trail/key');
    assert.equal(codexTypedSha('ship it', h.env), withOwn);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('a linked state folder gives no key, so nothing on Codex counts as typed (fails closed)', () => {
  const h = home();
  try {
    const elsewhere = join(h.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(h.env.TRAIL_HOME!, 'state'));
    const st = { codex: { meta: null, typedShas: [] } } as unknown as SkillSessionState;
    noteCodexPrompt(st, 'ship it', h.env);
    assert.deepEqual(st.codex!.typedShas, []);
    assert.equal(existsSync(join(elsewhere, 'typed-key')), false, 'nothing written through the link');
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
