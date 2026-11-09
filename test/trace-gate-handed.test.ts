/**
 * D137 (c8): the gate file's hand-offs (a gated step denied and printed for the person to run) and credit's reading
 * of them. Temp homes and made-up acme-cli steps only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markHanded, readGateFile, readHanded, writeGateFile } from '../src/trace/gate-file.js';
import { creditRun } from '../src/skills/ledger.js';
import { at, injection, runCall } from './trace-run-fixtures.js';
import type { SkillSessionState } from '../src/trace/types.js';

const stateWith = (inj: ReturnType<typeof injection>) => ({ epoch: 0, injected: [inj] }) as unknown as SkillSessionState;

test('markHanded records the step once, readHanded lists it, and a rewrite keeps it only while the block\'s steps stay', () => {
  const root = mkdtempSync(join(tmpdir(), 'c8-handed-'));
  try {
    const env = { HOME: root, TRAIL_HOME: join(root, 'trail') };
    const inj = injection({ live: true });
    writeGateFile('sess-1', stateWith(inj), env);
    markHanded('sess-1', inj.injId, 4, new Date('2026-10-01T10:02:00.000Z'), env);
    markHanded('sess-1', inj.injId, 4, new Date('2026-10-01T10:03:00.000Z'), env);
    markHanded('sess-1', inj.injId, 9, new Date('2026-10-01T10:03:00.000Z'), env);
    markHanded('sess-1', 'i-ffffff', 4, new Date('2026-10-01T10:03:00.000Z'), env);
    assert.deepEqual(readHanded('sess-1', env), [{ n: 4, at: '2026-10-01T10:03:00.000Z', injId: inj.injId }]);
    writeGateFile('sess-1', stateWith(inj), env);
    assert.equal(readHanded('sess-1', env).length, 1, 'kept across a rewrite of the same block');
    writeGateFile('sess-1', stateWith({ ...inj, steps: inj.steps.map((s) => s.replace('1.4.3', '1.4.4')) }), env);
    assert.deepEqual(readHanded('sess-1', env), [], 'new values: a new block, nothing handed');
    assert.ok(readGateFile('sess-1', env));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('creditRun: a handed step ran (its denied call no failure), and a check after it counts', () => {
  const calls = [
    runCall({ id: 'toolu_h1', cmd: 'npm run build', at: at(110) }),
    runCall({ id: 'toolu_h2', cmd: 'npm version 1.4.3 --no-git-tag-version', at: at(120) }),
    runCall({ id: 'toolu_h3', cmd: 'npm pack', at: at(130) }),
    runCall({ id: 'toolu_h4', cmd: 'npm publish acme-cli-1.4.3.tgz --access public', at: at(140), failed: true, isError: true }),
    runCall({ id: 'toolu_h5', cmd: 'npm view acme-cli version', at: at(400), kind: 'look', check: { family: 'npm-view', passed: true, facts: {} } }),
  ];
  const inj = injection({ at: at(100), steps: injection().steps.slice(0, 4), gated: [{ step: 4, kind: 'publish' }] });
  assert.deepEqual(creditRun(inj, calls).failedStep, 4, 'without the hand-off: a failed step');
  const c = creditRun({ ...inj, handed: [{ n: 4, at: at(140) }] }, calls);
  assert.deepEqual([c.stepsRan, c.failedStep, c.check], [[1, 2, 3, 4], null, 'passed']);
});
