/**
 * SessionStart's 1b steps (design 3.1 steps 8 to 10, J14b, J14e, R38, J02
 * leg C): the index marks a skill with a gone anchor and leaves out one
 * unused for 60 days, each said once in telemetry; a compaction brings back
 * the fixes of the walls hit in the epoch it closed, and fills that epoch's
 * repairs relative to the checkout; and an init list still waiting is handed
 * over once, then dropped. Made-up repos, skills and commands only.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionStartSkillsRun } from '../src/claude/start-skills.js';
import { noteWalls } from '../src/trace/wall-state.js';
import { readInitRecord, updateInitRecord } from '../src/init/init-record.js';
import { wallFixText } from '../src/trace/walls.js';
import { guardrailCandidate, skillCandidate } from './init-screen-fixtures.js';
import { releaseSkill, shipSkill, WEBSHOP } from './skills-recall-fixtures.js';
import { box as makeBox, CWD, gateFor, grow, ranIn, save, SID, startPayload, stateOf, typedIn, withNow, type Box } from './skills-prompt-fixtures.js';

/** Each box's folder, removed when the file is done. */
const made: Box[] = [];
const box = (tag: string) => { const b = makeBox(tag); made.push(b); return b; };
after(() => { for (const b of made) rmSync(b.home, { recursive: true, force: true }); });
import { createHash } from 'node:crypto';
import { allowedValue, EVENTS } from '../src/telemetry/contract.js';

const start = (b: Box, source: string, env = b.env, extra: Record<string, unknown> = {}) =>
  sessionStartSkillsRun(startPayload(b, source, extra), CWD, env, { gate: gateFor(b) });
const SH = createHash('sha256').update(SID).digest('hex').slice(0, 12);

/** Telemetry carries only the contract's keys and values (counts only, R16). */
function contractOnly(sent: Array<[string, Record<string, string>]>): void {
  for (const [event, props] of sent) {
    const keys = EVENTS[event];
    assert.ok(keys, `not a contract event: ${event}`);
    for (const [k, v] of Object.entries(props)) {
      assert.ok(keys.has(k), `${event}.${k} is not in the contract`);
      assert.ok(allowedValue(event, k, String(v)), `${event}.${k}=${v} is not a contract value`);
    }
  }
}

test('J14b: a skill whose branch is gone on a fetched remote reads (may be out of date) in the index, and skill_stale{missing} goes once a day', () => {
  const b = box('s1b-gone');
  save(b, shipSkill());
  const fresh = start(b, 'startup');
  assert.doesNotMatch(fresh.out.context ?? '', /may be out of date/, 'a remote never fetched says nothing');
  // origin fetched once, with no beta branch.
  mkdirSync(join(b.repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  writeFileSync(join(b.repo, '.git', 'refs', 'remotes', 'origin', 'main'), '4e1c9a2'.padEnd(40, '0') + '\n');
  const r = start(b, 'startup');
  assert.match(r.out.context ?? '', /ship-beta-then-prod \([^)]*\)[^·]*\(may be out of date\)/);
  assert.deepEqual(r.sent, [['skill_stale', { reason: 'missing' }]]);
  contractOnly(r.sent as Array<[string, Record<string, string>]>);
  assert.deepEqual(start(b, 'startup').sent, [], 'once a day');
});

test('J14e: a skill unused for 60 days leaves the index (its cue still fires), and skill_stale{unused} goes once', () => {
  const b = box('s1b-unused');
  save(b, releaseSkill({ applies: WEBSHOP, trail: 's-7f3a2c' }));
  assert.match(start(b, 'startup').out.context ?? '', /release-npm/);
  const later = withNow(b, '2026-12-20T10:00:00.000Z');
  const r = start(b, 'startup', later);
  assert.doesNotMatch(r.out.context ?? '', /Trail skills here/);
  assert.deepEqual(r.sent, [['skill_stale', { reason: 'unused' }]]);
  contractOnly(r.sent as Array<[string, Record<string, string>]>);
  assert.deepEqual(start(b, 'startup', later).sent, [], 'said once');
});

test('R38: after a compaction the fixes of the walls hit in the epoch it closed come back, at most 2', () => {
  const b = box('s1b-compact');
  grow(b, [typedIn(b, 'run the integration tests', 0), ...ranIn(b, 'go test -tags integration ./...', 'panic: rootless Docker not found', 5, { isError: true })]);
  // Stop recorded the epoch's hits (another class from walls.json, as a Stop would have written it).
  noteWalls({ seen: [{ cls: 'enospc', d: '2026-10-20', sh: SH, epoch: 0, repo: WEBSHOP, program: 'go' }, { cls: 'zsh-no-match', d: '2026-10-20', sh: SH, epoch: 0, repo: WEBSHOP, program: 'rm' }] }, b.env);
  start(b, 'startup');
  const r = start(b, 'compact');
  const ctx = r.out.context ?? '';
  const ctxFor = { hasProgram: () => false, remoteSsh: null };
  assert.ok(ctx.includes(wallFixText('docker-rootless', ctxFor)) || ctx.includes(wallFixText('enospc', ctxFor)), ctx);
  const lines = ctx.split('\n').filter((l) => l.startsWith('[trail] Trail, the tool this person installed, recognizes this error'));
  assert.equal(lines.length, 2, 'at most 2');
  assert.doesNotMatch(start(b, 'startup').out.context ?? '', /recognizes this error/, 'only after a compaction');
});

test('a compaction closes the runs with their repairs read against the checkout (./) and the home ($HOME) (b2 open issue 1)', () => {
  const b = box('s1b-compact-root');
  const cmd = 'go test -tags integration ./...';
  grow(b, [
    typedIn(b, 'run the integration tests', 0),
    ...ranIn(b, cmd, 'panic: rootless Docker not found', 5, { isError: true }),
    ...ranIn(b, `TMPDIR=${b.repo}/tmp ${cmd}`, 'ok  \tacme/webshop/orders\t0.5s', 10),
  ]);
  start(b, 'startup');
  start(b, 'compact');
  const repairs = stateOf(b).runs.flatMap((r) => r.repairs ?? []);
  assert.equal(repairs.length, 1, JSON.stringify(stateOf(b).runs.map((r) => r.repairs)));
  assert.equal(repairs[0]!.delta[0]!.text, 'TMPDIR=./tmp');
});

test('J02 leg C: an unanswered init list is handed over once at the next session start, with its transcript offset; the session after drops it', () => {
  const b = box('s1b-handover');
  const items = [
    { ...skillCandidate(), applies: WEBSHOP, n: 1, title: 'release-npm', description: '' },
    { ...guardrailCandidate(), n: 2, title: 'no-timeout', description: '' },
  ];
  updateInitRecord(WEBSHOP, (r) => {
    r.pending = items.map((i) => ({ ...i }));
    r.pendingFrom = 'ir-5d0e';
    r.shownAt = '2026-10-19T10:00:00.000Z';
  }, b.env);
  grow(b, [typedIn(b, 'hello', 0)]);
  const size = statSync(b.transcript).size;
  const first = start(b, 'startup').out.context ?? '';
  assert.match(first, /trail init found 2 items in this person's past sessions that they haven't answered yet/);
  assert.match(first, /\n1\. release-npm/);
  assert.match(first, /\n2\. no-timeout/);
  const rec = readInitRecord(WEBSHOP, b.env);
  assert.deepEqual(rec.handover, { session: SID, offset: size });
  assert.equal(start(b, 'compact').out.context?.includes('trail init found'), false, 'the same session: once');
  const other = startPayload(b, 'startup', { session_id: 'c0ffee00-1111-4222-8333-444455556666' });
  const later = sessionStartSkillsRun(other, CWD, b.env, { gate: gateFor(b) }).out.context ?? '';
  assert.doesNotMatch(later, /trail init found/);
  assert.deepEqual(readInitRecord(WEBSHOP, b.env).pending, [], 'dropped: never shown again (P10)');
});
