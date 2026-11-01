/**
 * D134: the value line's copy. A skill that ran once keeps "(the run it came from had {f0})" beside its own count;
 * with more runs the line says the sum as a sum ("ran 3 times, 6 failed commands in all") and drops the one run's
 * count, which read as worse than it was. Pure: valueWords on made-up counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueWords, type SkillWeek } from '../src/skills/value-line.js';

const week = (uses: number, failed: number, f0: number | null): SkillWeek =>
  ({ id: 's-7f3a2c', name: 'release-npm', uses, checked: uses, failed, before: f0 === null ? null : { commands: 9, failed: f0 } });
const line = (s: SkillWeek, g = 0, w = 0) => valueWords({ skills: [s], guardrailStops: g, wallFixes: w });

test('one run: its failed commands, beside the run it came from', () => {
  assert.equal(line(week(1, 0, 4)), 'Last week in this repo, on this machine: release-npm ran 1 time with 0 failed commands (the run it came from had 4).');
  assert.equal(line(week(1, 1, 0)), 'Last week in this repo, on this machine: release-npm ran 1 time with 1 failed command.');
});

test('more runs: the sum said as a sum, and no single run beside it', () => {
  assert.equal(line(week(3, 6, 4)), 'Last week in this repo, on this machine: release-npm ran 3 times, 6 failed commands in all.');
  assert.equal(line(week(2, 1, 4), 9, 1), 'Last week in this repo, on this machine: release-npm ran 2 times, 1 failed command in all; the timeout learning stopped 9 commands; 1 known error came with its fix.');
  assert.equal(line(week(2, 0, null)), 'Last week in this repo, on this machine: release-npm ran 2 times, 0 failed commands in all.');
});
