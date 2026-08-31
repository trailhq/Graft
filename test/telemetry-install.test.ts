/**
 * The `install` event — the top of the funnel, and the one event recorded from
 * outside a command.
 *
 * The regression these tests exist for is subtle and expensive: the postinstall
 * hook mints the install id before any command runs, which used to be exactly
 * the condition `first_run` fired on. Get it wrong and every install still
 * counts while `first_run` silently drops to zero, so the funnel looks like
 * nobody who installs graft ever runs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { patchState, readState } from '../src/telemetry/identity.js';
import { peek } from '../src/telemetry/queue.js';
import { trackFirstRunIfNew, trackInstallIfNew } from '../src/telemetry/track.js';
import { tmpRepo } from './helpers.js';

const OPEN: NodeJS.ProcessEnv = {};

function sandbox(tag: string): string {
  const home = tmpRepo(tag);
  mkdirSync(join(home, '.graft'), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  return home;
}

function names(home: string): string[] {
  return peek(home).map((e) => (e as { event: string }).event);
}

test('install fires once per version, not once per npm install', () => {
  const home = sandbox('tel-install-once');
  trackInstallIfNew({ home, env: OPEN });
  trackInstallIfNew({ home, env: OPEN });
  assert.deepEqual(names(home), ['install']);
});

test('an upgrade counts as a new install', () => {
  const home = sandbox('tel-install-upgrade');
  trackInstallIfNew({ home, env: OPEN });
  // What an upgrade looks like from here: the recorded version is no longer the
  // running one.
  assert.ok(readState(home)?.installedVersion);
  patchState({ installedVersion: '0.0.1-old' }, home);
  trackInstallIfNew({ home, env: OPEN });
  assert.deepEqual(names(home), ['install', 'install']);
});

test('first_run still fires after the postinstall hook minted the install id', () => {
  const home = sandbox('tel-install-then-first-run');
  trackInstallIfNew({ home, env: OPEN });
  trackFirstRunIfNew({ home, env: OPEN });
  assert.deepEqual(names(home), ['install', 'first_run']);
  // And still exactly once.
  trackFirstRunIfNew({ home, env: OPEN });
  assert.deepEqual(names(home), ['install', 'first_run']);
});

test('the global flag is the only property, and it is a string', () => {
  const home = sandbox('tel-install-global');
  trackInstallIfNew({ home, env: OPEN, global: true });
  const ev = peek(home)[0] as { properties: Record<string, string> };
  assert.equal(ev.properties.global, 'true');
});

test('every gate closes the install event', () => {
  const off = sandbox('tel-install-gated');
  trackInstallIfNew({ home: off, env: { DO_NOT_TRACK: '1' } });
  assert.deepEqual(names(off), []);
  const ci = sandbox('tel-install-ci');
  trackInstallIfNew({ home: ci, env: { CI: 'true' } });
  assert.deepEqual(names(ci), []);
});
