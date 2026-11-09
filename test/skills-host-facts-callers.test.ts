/**
 * Phase 2 c7 (design 1.0, 2.10; c0's open item): every place the skills code asks for host facts names the host the
 * payload came from, so a Codex hook gets Codex's facts (no ask, no notices, no PostToolUse context until their host
 * checks pass) and never Claude Code's. Synthetic data only.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerDirective } from '../src/skills/offer-words.js';
import { forgetNoticeAtStop } from '../src/skills/forget-notice.js';
import type { PendingOffer } from '../src/trace/types.js';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('every hostFacts call in src names a host', () => {
  const bare: string[] = [];
  for (const f of files(join(import.meta.dirname, '..', 'src'))) {
    if (f.endsWith(join('skills', 'host-facts.ts'))) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bhostFacts\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      if (!m[1]!.includes(',')) bare.push(`${f.split('/src/')[1]}: hostFacts(${m[1]})`);
    }
  }
  assert.deepEqual(bare, []);
});

function testHome(facts: unknown): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'c7-facts-'));
  made.push(root);
  const trail = join(root, 'trail-home');
  mkdirSync(join(trail, 'state'), { recursive: true });
  return { HOME: root, TRAIL_HOME: trail, TRAIL_HOST_FACTS: JSON.stringify(facts) };
}

const offer = { moment: 'repeated', name: 'release-npm', runId: 'r-1027-0a1b2c3d', channel: 'stop' } as unknown as PendingOffer;

test("a no on Codex is answered by Codex's promptBlockShown, never Claude Code's", () => {
  const codexOn = testHome({ codex: { promptBlockShown: true } });
  assert.ok(answerDirective('no', offer, { paused: false, firstNo: true }, codexOn, 'no', 'codex').block);
  assert.equal(answerDirective('no', offer, { paused: false, firstNo: true }, codexOn, 'no', 'claude').block, undefined);
  const flat = testHome({ promptBlockShown: true });
  assert.equal(answerDirective('no', offer, { paused: false, firstNo: true }, flat, 'no', 'codex').block, undefined);
  assert.ok(answerDirective('no', offer, { paused: false, firstNo: true }, flat, 'no').block, 'no host: Claude Code\'s, as before');
});

test("the forget notice at Stop follows the host's stopNotice", () => {
  const env = testHome({ codex: { stopNotice: true } });
  const line = () => writeFileSync(join(env.TRAIL_HOME!, 'state', 'forgot.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), what: 'skill', name: 'release-npm', back: 'trail skills restore release-npm' })}\n`);
  line();
  const codex = forgetNoticeAtStop({}, env, 'codex');
  assert.match(codex.notice ?? '', /release-npm/, JSON.stringify(codex));
  assert.equal(codex.block, undefined);
  line();
  const claude = forgetNoticeAtStop({}, env, 'claude');
  assert.equal(claude.notice, undefined, "Claude Code's stopNotice is off: the agent says it");
  assert.match(claude.block ?? '', /release-npm/);
});
