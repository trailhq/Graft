/**
 * D138 (2): credit doesn't count a step as ran when the agent's call made it do less: a `--dry-run`, `-n` or
 * `--no-...` flag the step lacked, or a trailing `; exit 0`, `|| true` or `|| :` that hides its failure. Fidelity
 * agrees (never a step done another way, never an extra step to fold). Made-up acme-cli calls only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditRun, ranAs } from '../src/skills/ledger.js';
import { doesLess } from '../src/skills/ran-less.js';
import { fidelityOf } from '../src/skills/fidelity.js';
import { at, injection, runCall } from './trace-run-fixtures.js';

let n = 0;
const call = (cmd: string, sec: number, extra: Record<string, unknown> = {}) => runCall({ id: `toolu_l${++n}`, cmd, at: at(sec), ...extra });
const inj = () => injection({ at: at(100), runId: 'r-1001-3f9a' });

test('doesLess: a dry-run, -n or --no- flag the step lacked, or a trailing exit 0 / || true / || :', () => {
  for (const ran of ['npm run build --dry-run', 'npm run build -n', 'npm run build -qn', 'npm run build --no-verify', 'npm run build --dry-run=true',
    'npm run build; exit 0', 'npm run build || true', 'npm run build || :', 'npm run build 2>/dev/null || true', 'npm run build || exit 0']) {
    assert.equal(doesLess('npm run build', ran), true, ran);
  }
  for (const ran of ['npm run build', 'npm run build --verbose', 'npm run build | tail -n 20', 'npm run build --no-color', 'npm ci --no-audit && npm run build', 'npm ci --no-optional && npm run build']) {
    assert.equal(doesLess('npm run build', ran), false, ran);
  }
  assert.equal(doesLess('npm version {version} --no-git-tag-version', 'npm version 1.4.3 --no-git-tag-version'), false, 'the step has it');
  assert.equal(doesLess('npm test || true', 'npm test || true'), false, 'the step hides it too');
  assert.equal(doesLess('npm ci && npm run build', 'npm ci && npm run build --dry-run'), true, 'a step of two commands reads both');
});

test('ranAs: a step done with less is not the step', () => {
  assert.equal(ranAs('npm run build', 'npm run build', {}), true);
  assert.equal(ranAs('npm run build', 'npm run build || true', {}), false);
  assert.equal(ranAs('npm publish acme-cli-{version}.tgz --access public', 'npm publish acme-cli-1.4.3.tgz --access public', { version: '1.4.3' }), true);
  assert.equal(ranAs('npm publish acme-cli-{version}.tgz --access public', 'npm publish acme-cli-1.4.3.tgz --access public --dry-run', { version: '1.4.3' }), false);
});

test('creditRun and fidelity: a dry-run publish and a masked build never count as ran, nor as a step done another way', () => {
  const calls = [
    call('npm run build || true', 110), call('npm version 1.4.3 --no-git-tag-version', 120), call('npm pack', 130),
    call('npm publish acme-cli-1.4.3.tgz --access public --dry-run', 140),
  ];
  const c = creditRun(inj(), calls);
  assert.deepEqual(c.stepsRan, [2, 3], JSON.stringify(c));
  const withFail = [call('npm run build', 105, { failed: true }), ...calls];
  const steps = inj().steps.map((cmd, k) => ({ n: k + 1, cmd }));
  const f = fidelityOf({ steps, check: null, params: [] } as never, inj(), withFail);
  assert.deepEqual(f.changed, [], 'the masked build is not the failed build done another way');
  assert.deepEqual(f.extra, [], 'nor an extra step a fold could add');
  assert.deepEqual(f.ran, [2, 3], 'the same set credit gives');
});
