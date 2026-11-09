/**
 * Phase 2 c8 (4.17, R21): a save Codex's agent runs inside its sandbox. When `~/.trail/skills` or `state` can't be
 * written, `trail skills add`, `lesson` and `update` change nothing, leave the receipt unused, and say how the person
 * can run the same command in their own terminal; run there, the same receipt and transcript decide. Temp homes and
 * made-up acme-cli releases only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { at, box, cli, done, one, skillsKept } from './claude-skills-journey-fixtures.js';
import { cxPrompt, cxReply, cxRuns, cxSession, cxStop } from './codex-journey-fixtures.js';
import { cliAdd } from '../src/skills/save-gate.js';
import { cliUpdate } from '../src/skills/update-gate.js';
import { keepLessonCli } from '../src/skills/lesson-gate.js';
import { sandboxLine, trailWritable } from '../src/skills/codex-sandbox.js';
import { chmodDenialUnavailable } from './helpers.js';

const ctxOf = (out: Record<string, any> | null): string => out?.hookSpecificOutput?.additionalContext ?? '';

/** A refused write is made with chmod, which refuses nothing on Windows (or for root): those tests say so and skip. */
const NO_DENIAL = chmodDenialUnavailable() ?? false;

/** Makes each folder read-only for the call, then puts it back (so the temp home can be removed). */
function readOnly<T>(dirs: string[], fn: () => T): T {
  for (const d of dirs) chmodSync(d, 0o555);
  try {
    return fn();
  } finally {
    for (const d of dirs) chmodSync(d, 0o700);
  }
}

test('sandboxLine is the 4.17 words; trailWritable probes skills and state (or the folder above one not made yet)', { skip: NO_DENIAL }, () => {
  assert.equal(sandboxLine('trail skills add release-npm --run r-1'),
    "trail · couldn't write ~/.trail from Codex's sandbox. The person can run the same command in their own terminal within 30 minutes: trail skills add release-npm --run r-1");
  const root = mkdtempSync(join(tmpdir(), 'c8-sbx-'));
  try {
    const env = { HOME: root, TRAIL_HOME: join(root, 'trail') };
    assert.equal(trailWritable(env), true, 'nothing there yet: the folder above takes a file');
    mkdirSync(join(root, 'trail', 'state'), { recursive: true });
    assert.equal(readOnly([join(root, 'trail', 'state')], () => trailWritable(env)), false, 'state refused');
    assert.equal(readOnly([join(root, 'trail')], () => trailWritable(env)), false, 'skills not made yet, and its folder refused');
    mkdirSync(join(root, 'trail', 'skills'));
    assert.equal(trailWritable(env), true);
    assert.deepEqual(readdirSync(join(root, 'trail', 'skills')), [], 'the probe leaves nothing behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trail skills add from Codex with ~/.trail refused: nothing kept, the receipt unused; the same command in the person\'s terminal keeps it', { skip: NO_DENIAL }, async () => {
  const b = box('c8-sbx-add', { env: { TRAIL_TIER_CODEX: 'A' } });
  try {
    const s = cxSession(b);
    await cxPrompt(s, at(20, 0), 'publish 1.4.0');
    await cxRuns(s, at(20, 10), 'npm run build', () => ({ out: 'built in 2.1s' }));
    await cxRuns(s, at(20, 20), 'npm publish acme-cli-1.4.0.tgz --access public', () => ({ out: '+ acme-cli@1.4.0' }));
    await cxRuns(s, at(20, 30), 'npm view acme-cli version', () => ({ out: '1.4.0' }));
    cxReply(s, at(20, 40), 'Published 1.4.0.');
    await cxStop(s, at(20, 41), 'Published 1.4.0.');
    const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctxOf(one(await cxPrompt(s, at(20, 60), 'save this as a skill')))) ?? [];
    const command = `trail skills add ${name} --run ${runId}`;
    const env = { CODEX_HOME: b.env.CODEX_HOME!, TRAIL_TIER_CODEX: 'A', CLAUDE_CODE_ENTRYPOINT: '' };
    let first: { out: string; code: number } | undefined;
    const state = join(b.trail, 'state');
    const receipts = () => readdirSync(join(b.trail, 'receipts')).filter((f) => !f.includes('.lock')).map((f) => readFileSync(join(b.trail, 'receipts', f), 'utf8'));
    await cxRuns(s, at(20, 70), command, () => {
      const r = readOnly([state, ...(existsSync(join(b.trail, 'skills')) ? [join(b.trail, 'skills')] : [b.trail])],
        () => cli(b, at(20, 70), command, env)());
      first = { out: r.out, code: r.failed ? 1 : 0 };
      return first;
    });
    assert.deepEqual(first, { out: sandboxLine(command), code: 1 });
    assert.deepEqual(skillsKept(b), [], 'nothing kept');
    assert.ok(receipts().every((t) => JSON.parse(t).usedAt === null), 'the receipt is unused');
    // The person runs the same command in their own terminal, minutes later: the same receipt and transcript decide.
    const r = cli(b, at(20, 75), command, env)();
    assert.equal(r.failed, false, r.out);
    assert.deepEqual(skillsKept(b), [name]);
  } finally {
    done(b);
  }
});

test('trail skills update and lesson from Codex with ~/.trail refused say the same, with their own command; other hosts are as they were', { skip: NO_DENIAL }, () => {
  const root = mkdtempSync(join(tmpdir(), 'c8-sbx-rc-'));
  try {
    const home = join(root, 'home');
    const env = { HOME: home, TRAIL_HOME: join(root, 'trail'), CODEX_HOME: join(home, '.codex'), TRAIL_TEST_NOW: '2026-10-20T12:00:00.000Z' };
    const now = new Date('2026-10-20T12:01:00.000Z');
    const dir = join(root, 'trail', 'receipts');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'trail', 'state'), { recursive: true });
    mkdirSync(join(root, 'trail', 'skills'), { recursive: true });
    writeFileSync(join(root, 'trail', 'settings.json'), JSON.stringify({ v: 1, skills: 'on', onSince: '2026-08-01T00:00:00.000Z' }));
    const tx = join(home, '.codex', 'sessions', '2026', '10', '20', 'rollout-2026-10-20T12-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl');
    mkdirSync(join(tx, '..'), { recursive: true });
    writeFileSync(tx, '');
    const base = { v: 1, session: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', transcriptPath: tx, toolUseId: 'call_1', offerId: 'o-1a2b3c', at: '2026-10-20T12:00:30.000Z', typed: { offset: 0, lineSha: 'aa' }, usedAt: null };
    writeFileSync(join(dir, 's1.update.json'), JSON.stringify({ ...base, kind: 'update', host: 'codex', skillId: 's-7f3a2c', name: 'release-npm', runId: 'r-1', op: 'update', baseHash: 'sha256:00', proposalSha: '0'.repeat(16) }));
    writeFileSync(join(dir, 's1.lesson.json'), JSON.stringify({ ...base, kind: 'lesson', skill: 'release-npm', lessonSha: 'bb', verdict: 'live' }));
    const ro = [join(root, 'trail', 'state'), join(root, 'trail', 'skills')];
    const u = readOnly(ro, () => cliUpdate('release-npm', 'o-1a2b3c', env, now));
    assert.deepEqual(u, { code: 1, lines: [sandboxLine('trail skills update release-npm --offer o-1a2b3c')] });
    const l = readOnly(ro, () => keepLessonCli('release-npm', 'o-1a2b3c', env, now));
    assert.deepEqual(l, { code: 1, line: sandboxLine('trail skills lesson release-npm --offer o-1a2b3c') });
    for (const f of ['s1.update.json', 's1.lesson.json']) assert.equal(JSON.parse(readFileSync(join(dir, f), 'utf8')).usedAt, null, `${f} unused`);
    // A Claude Code receipt never gets the Codex line (its own refusals say what happened).
    writeFileSync(join(dir, 's1.update.json'), JSON.stringify({ ...base, kind: 'update', host: 'claude', transcriptPath: join(home, 'x.jsonl'), skillId: 's-7f3a2c', name: 'release-npm', runId: 'r-1', op: 'update', baseHash: 'sha256:00', proposalSha: '0'.repeat(16) }));
    const c = readOnly(ro, () => cliUpdate('release-npm', 'o-1a2b3c', env, now));
    assert.ok(!c.lines.join('\n').includes("Codex's sandbox"), c.lines.join('\n'));
    assert.equal(cliAdd('release-npm', 'r-none', env, now).lines.join('\n').includes("Codex's sandbox"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
