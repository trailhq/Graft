/**
 * The four gates. Each one is tested alone, because the value of the design is
 * that any single one of them is sufficient to stop everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { doNotTrack, explainOff, inCi, offReason, telemetryOn } from '../src/telemetry/gate.js';
import { track } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import { tmpRepo } from './helpers.js';

const KEY = 'phc_test_key';

function home(tag: string, state?: Record<string, unknown>): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, '.graft'), { recursive: true });
  if (state) writeFileSync(join(dir, '.graft', 'telemetry.json'), JSON.stringify(state));
  return dir;
}

test('no key: a fork or a local build can never send, whatever the settings say', () => {
  const h = home('gate-nokey', { installId: 'x', enabled: true });
  delete process.env.GRAFT_POSTHOG_KEY;
  assert.equal(offReason(h, {}), 'no-key');
  assert.equal(track('first_run', {}, { home: h, env: {} }), null);
  assert.deepEqual(peek(h), []);
});

test('DO_NOT_TRACK outranks our own setting', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-dnt', { installId: 'x', enabled: true });
  assert.equal(offReason(h, { DO_NOT_TRACK: '1' }), 'do-not-track');
  assert.equal(track('first_run', {}, { home: h, env: { DO_NOT_TRACK: '1' } }), null);
});

test('DO_NOT_TRACK=0 and an empty value mean "not set"', () => {
  assert.equal(doNotTrack({ DO_NOT_TRACK: '0' }), false);
  assert.equal(doNotTrack({ DO_NOT_TRACK: '' }), false);
  assert.equal(doNotTrack({}), false);
  assert.equal(doNotTrack({ DO_NOT_TRACK: 'true' }), true);
});

test('CI is never counted as a user', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-ci', { installId: 'x' });
  assert.equal(offReason(h, { CI: 'true' }), 'ci');
  assert.equal(offReason(h, { GITHUB_ACTIONS: 'true' }), 'ci');
  assert.equal(inCi({ CI: 'false' }), false, 'CI=false is not CI');
  assert.equal(inCi({ CI: '0' }), false);
});

test('the user switch turns everything off', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-disabled', { installId: 'x', enabled: false });
  assert.equal(offReason(h, {}), 'disabled');
  assert.equal(track('query', { command: 'ask' }, { home: h, env: {} }), null);
  assert.deepEqual(peek(h), []);
});

test('all four open: the event is recorded', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-open', { installId: 'x', enabled: true });
  assert.equal(offReason(h, {}), null);
  assert.equal(telemetryOn(h, {}), true);
  assert.ok(track('query', { command: 'ask', surface: 'cli' }, { home: h, env: {} }));
  assert.equal(peek(h).length, 1);
});

test('never chosen means on — the documented default', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-default', { installId: 'x' }); // no `enabled` field
  assert.equal(offReason(h, {}), null);
});

test('every reason has a sentence naming the switch that is closed', () => {
  for (const r of ['no-key', 'do-not-track', 'ci', 'disabled'] as const) {
    assert.match(explainOff(r), /^off — \S/);
  }
  assert.match(explainOff('do-not-track'), /DO_NOT_TRACK/);
  assert.match(explainOff('disabled'), /graft telemetry enable/);
});
