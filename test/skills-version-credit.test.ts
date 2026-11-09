/**
 * D106: credit for a version check (4.8). A block whose check shows a
 * `{version}` filled with a literal version (`checkVersion`) passes its check
 * only when the check call worked and showed that version, whatever the fold
 * could tell from the run's facts (a publish behind a wrapper names none; a
 * publish makes any version shown look new). With no literal version, the
 * fold's reading decides, as before. Synthetic: the made-up acme-cli.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditRun } from '../src/skills/ledger.js';
import { at, injection, runCall } from './trace-run-fixtures.js';

const PKG_VERSION = `$(node -p "require('./package.json').version")`;
const STEPS = ['npm run build', 'npm version patch', 'npm publish --access public'];
let n = 0;
const ran = () => STEPS.map((cmd, i) => runCall({ id: `toolu_v${++n}`, cmd, at: at(110 + i * 10) }));
/** The check call as the fold read it: `passed` is what the fold could tell from the run's facts. */
const viewCall = (shown: string, passed: boolean) => runCall({
  id: `toolu_v${++n}`, cmd: 'npm view acme-cli version', at: at(200), kind: 'look', tail: shown,
  check: { family: 'npm-view', passed, facts: passed ? { version: shown, pkg: 'acme-cli' } : { pkg: 'acme-cli' } },
});
const block = (checkVersion?: string) => injection({
  at: at(100), params: { version: checkVersion ?? PKG_VERSION }, steps: STEPS, gated: [{ step: 3, kind: 'publish' }],
  ...(checkVersion ? { checkVersion } : {}),
});

test('credit: a version check passes on the filled-in version it shows, whatever the fold could tell', () => {
  // The publish ran behind a wrapper, so the fold knew no version: the check showing the asked version still passes.
  assert.equal(creditRun(block('0.3.3'), [...ran(), viewCall('0.3.3', false)]).check, 'passed');
  assert.equal(creditRun(block('0.3.3'), [...ran(), viewCall('v0.3.3', false)]).check, 'passed');
  // The registry still shows the old version: not a pass, though the fold took any version after a publish.
  assert.equal(creditRun(block('0.3.3'), [...ran(), viewCall('0.3.2', true)]).check, 'failed');
  assert.equal(creditRun(block('0.3.3'), [...ran(), viewCall('0.3.30', true)]).check, 'failed');
  // A failed check call never passes.
  assert.equal(creditRun(block('0.3.3'), [...ran(), { ...viewCall('0.3.3', false), failed: true }]).check, 'failed');
});

test('credit: with no literal version filled in, the fold\'s reading decides, as before', () => {
  assert.equal(creditRun(block(), [...ran(), viewCall('0.3.2', true)]).check, 'passed');
  assert.equal(creditRun(block(), [...ran(), viewCall('0.3.2', false)]).check, 'failed');
});
