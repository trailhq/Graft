/**
 * Journeys J10, J11 and J12 through the real hooks (design 5, g7-wiring):
 * a kept skill comes back as a run block for a short ask, once an epoch and
 * again after a compaction; a status question gets only the check line; a
 * history question gets no skill text. And the PostToolUseFailure mark a
 * failed call leaves reaches the fold before its transcript result does.
 * The box has no `graft/INDEX.md`: recall never needs one. Made-up repo and
 * prompts only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { compactBoundary, compactSummary } from './trace-fixtures.js';
import { join } from 'node:path';
import {
  agentRuns, at, box, calling, cli, done, finish, grow, one, postBashFailHook, preBashHook, promptHook, release, resultOf, session, skillsKept, startHook, stateOf, stopHook,
  type Box,
} from './claude-skills-journey-fixtures.js';

const ctxOf = (out: Record<string, any> | null): string => out?.hookSpecificOutput?.additionalContext ?? '';

/** release-npm kept through "save this as a skill" on Oct 20. */
async function kept(b: Box): Promise<string> {
  const s = session(b);
  await release(s, 20, '1.4.0');
  await finish(s, 20, 'Published 1.4.0.');
  const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctxOf(one(await promptHook(s, at(20, 60), 'save this as a skill')))) ?? [];
  const command = `trail skills add ${name} --run ${runId}`;
  await agentRuns(s, at(20, 70), command, cli(b, at(20, 70), command));
  assert.deepEqual(skillsKept(b), [name]);
  return name!;
}

/** A session that ships from the block on `day`: build, the publish (asked once, approved), the check. */
async function usedOnce(b: Box, name: string, day: number): Promise<void> {
  const s = session(b);
  assert.match(ctxOf(one(await promptHook(s, at(day, 0), 'publish 1.4.1'))), new RegExp(`^\\[trail\\] Skill ${name} fits`));
  await agentRuns(s, at(day, 10), 'npm run build', () => ({ out: 'built' }));
  await agentRuns(s, at(day, 20), 'npm publish acme-cli-1.4.1.tgz --access public', () => ({ out: '+ acme-cli@1.4.1' }));
  await agentRuns(s, at(day, 30), 'npm view acme-cli version', () => ({ out: '1.4.1' }));
  await finish(s, day, `Published 1.4.1.\nUsed skill ${name}`);
  await promptHook(s, at(day, 60), 'thanks');
}

const poolOf = (b: Box) => {
  const p = join(b.trail, 'repos', 'github.com', 'acme', 'shop', 'pool.json');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

test('J10: a short ask gets the run block, once an epoch, and again after a compaction', async () => {
  const b = box('j10');
  try {
    const name = await kept(b);
    const s = session(b);
    assert.match(ctxOf(one(await startHook(s, at(22, 0)))), new RegExp(`Trail skills here: ${name}`));
    const short = 'publish it';
    assert.ok(short.length < 12, 'under the old 12-character floor');
    const first = ctxOf(one(await promptHook(s, at(22, 5), short)));
    assert.match(first, new RegExp(`^\\[trail\\] Skill ${name} fits`), first);
    assert.match(first, /npm publish acme-cli-\{version\}\.tgz --access public/, 'no version in the ask: the step keeps its blank');
    assert.ok(first.length <= 1200, `${first.length} characters`);
    assert.doesNotMatch(first, /you must/i);

    // The agent ships from the block: the gated step asks once.
    await agentRuns(s, at(22, 10), 'npm run build', () => ({ out: 'built' }));
    const pub = await agentRuns(s, at(22, 20), 'npm publish acme-cli-1.5.0.tgz --access public', () => ({ out: '+ acme-cli@1.5.0' }));
    assert.equal(pub.decision?.hookSpecificOutput?.permissionDecision, 'ask');
    assert.match(pub.decision?.hookSpecificOutput?.permissionDecisionReason ?? '', new RegExp(`^trail: this .+ and can't be undone \\(${name}, step 2\\)\\.$`));
    await agentRuns(s, at(22, 30), 'npm view acme-cli version', () => ({ out: '1.5.0' }));
    await finish(s, 22, `Published 1.5.0.\nUsed skill ${name}`);

    // Later, the same epoch, the same job again: no second block, a pointer back to the first.
    const same = ctxOf(one(await promptHook(s, at(22, 120), 'publish it')));
    assert.doesNotMatch(same, /\[trail\] Skill /);
    assert.equal(same, `[trail] Same job as before: start from the steps of skill ${name} above.`);
    // A compaction starts a new epoch: the block is back on the next ask.
    await startHook(s, at(22, 200), 'compact');
    const again = ctxOf(one(await promptHook(s, at(22, 210), 'publish 1.5.2')));
    assert.match(again, new RegExp(`^\\[trail\\] Skill ${name} fits`));
    assert.match(again, /npm publish acme-cli-1\.5\.2\.tgz --access public/, '{version} filled from the ask');
  } finally {
    done(b);
  }
});

test('J11: "is it published?" gets only the check line of the skill used here; no job day, no offer', async () => {
  const b = box('j11');
  try {
    const name = await kept(b);
    await usedOnce(b, name, 21);
    const s = session(b);
    const pool = poolOf(b);
    const out = one(await promptHook(s, at(21, 600), 'is it published?'));
    const ctx = ctxOf(out);
    assert.doesNotMatch(ctx, /\[trail\] Skill .* fits/, 'never the run block');
    assert.doesNotMatch(ctx, /npm publish/);
    assert.match(ctx, /npm view acme-cli version/, ctx);
    assert.equal(ctx.split('\n').filter((l) => l.startsWith('[trail]')).length, 1, ctx);
    assert.equal(await finish(s, 21, 'Yes: npm shows 1.4.1.', 640), null, 'no offer');
    assert.equal(poolOf(b), pool, 'not counted as a job day');
    assert.ok(name);
  } finally {
    done(b);
  }
});

test('J12: a history question gets no skill text at all', async () => {
  const b = box('j12');
  try {
    await kept(b);
    const s = session(b);
    const pool = poolOf(b);
    for (const ask of ['how did we publish the last release', 'Keep improving and testing till we get the best on the benchmarks']) {
      const out = one(await promptHook(s, at(22, 5), ask));
      assert.doesNotMatch(ctxOf(out), /\[trail\] Skill|npm view|npm publish/, ask);
      assert.equal(out?.systemMessage, undefined, ask);
    }
    assert.equal(await finish(s, 22, 'We ran the build, then published.'), null);
    assert.equal(poolOf(b), pool);
  } finally {
    done(b);
  }
});

test('a failed call\'s PostToolUseFailure mark reaches the fold before its result does; the transcript\'s result then wins', async () => {
  const b = box('mark');
  try {
    const s = session(b);
    await promptHook(s, at(22, 0), 'run the test suite');
    await agentRuns(s, at(22, 5), 'npm ci', () => ({ out: 'added 212 packages' }));
    const id = calling(s, at(22, 10), 'npm test');
    assert.equal(one(await preBashHook(s, at(22, 10), 'npm test', id)), null);
    await postBashFailHook(s, at(22, 12), 'npm test', id, 'Exit code 1\nTests: 1 failed, 11 passed, 12 total');
    // Stop before the result line is written: the fold reads the mark.
    await stopHook(s, at(22, 13), 'One test fails; looking.');
    const call = stateOf(s).runs.flatMap((r) => r.calls).find((c) => c.id === id);
    assert.ok(call, 'the call is in the run');
    assert.equal(call!.fromMark, true);
    assert.equal(call!.failed, true);
    assert.equal(call!.check?.family, 'tests');
    assert.equal(call!.check?.passed, false);
    // The result line arrives: it replaces the mark.
    resultOf(s, at(22, 14), id, 'Exit code 1\nTests: 1 failed, 11 passed, 12 total', true);
    await promptHook(s, at(22, 30), 'fix it');
    const after = stateOf(s).runs.flatMap((r) => r.calls).find((c) => c.id === id);
    assert.equal(after?.fromMark, undefined);
    assert.equal(after?.failed, true);
  } finally {
    done(b);
  }
});

test('a compaction partway through a skill\'s run brings its steps back at SessionStart (compact)', async () => {
  const b = box('reinject');
  try {
    const name = await kept(b);
    const s = session(b);
    assert.match(ctxOf(one(await promptHook(s, at(22, 0), 'publish 1.4.4'))), new RegExp(`^\\[trail\\] Skill ${name} fits`));
    await agentRuns(s, at(22, 10), 'npm run build', () => ({ out: 'built' }));
    grow(s, [compactBoundary({ timestamp: at(22, 20), sessionId: s.sid }), compactSummary({ timestamp: at(22, 21), sessionId: s.sid })]);
    const start = ctxOf(one(await startHook(s, at(22, 22), 'compact')));
    assert.match(start, new RegExp(`\\[trail\\] You were partway through skill ${name} when the conversation was compacted\\. Its steps`), start);
    assert.match(start, /npm publish acme-cli-1\.4\.4\.tgz --access public/, 'with the values the block had');
    // The publish after the compaction is still the gated step of a live block.
    const pub = await agentRuns(s, at(22, 30), 'npm publish acme-cli-1.4.4.tgz --access public', () => ({ out: '+ acme-cli@1.4.4' }));
    assert.equal(pub.decision?.hookSpecificOutput?.permissionDecision, 'ask');
  } finally {
    done(b);
  }
});
