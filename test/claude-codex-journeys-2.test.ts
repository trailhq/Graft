/**
 * Phase 2 c8: the Codex legs end to end through the real hooks (`main(event)`) on Codex payloads, with
 * TRAIL_TIER_CODEX=A in the test home (4.18). The prompt hook itself records each prompt's keyed hash (P30), a
 * prompt that is Trail's own Stop reason is never read as the person's, and J13's leg: a gated step of a live
 * block is denied and printed in every permission mode, never asked and never allowed. Made-up repo and prompts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, box, cli, done, one, skillsKept, stateOf, type Box } from './claude-skills-journey-fixtures.js';
import { cxPrompt, cxReply, cxRuns, cxSession, cxStart, cxStop, type CxSession } from './codex-journey-fixtures.js';

const ctxOf = (out: Record<string, any> | null): string => out?.hookSpecificOutput?.additionalContext ?? '';
const codexBox = (tag: string) => box(tag, { env: { TRAIL_TIER_CODEX: 'A' } });

async function release(s: CxSession, day: number, version: string, failedFirst = false): Promise<void> {
  await cxPrompt(s, at(day, 0), `publish ${version}`);
  await cxRuns(s, at(day, 10), 'npm run build', () => ({ out: 'built in 2.1s' }));
  if (failedFirst) await cxRuns(s, at(day, 15), `npm publish acme-cli-${version}.tgz`, () => ({ out: 'npm error code E403', code: 1 }));
  await cxRuns(s, at(day, 20), `npm publish acme-cli-${version}.tgz --access public`, () => ({ out: `+ acme-cli@${version}` }));
  await cxRuns(s, at(day, 30), 'npm view acme-cli version', () => ({ out: version }));
}
async function finish(s: CxSession, day: number, said: string, sec = 40, active = false): Promise<Record<string, any> | null> {
  cxReply(s, at(day, sec), said);
  return one(await cxStop(s, at(day, sec + 1), said, active));
}
const add = (s: CxSession, b: Box, iso: string, command: string) =>
  cxRuns(s, iso, command, () => {
    const r = cli(b, iso, command, { CODEX_HOME: b.env.CODEX_HOME!, TRAIL_TIER_CODEX: 'A', CLAUDE_CODE_ENTRYPOINT: '' })();
    return { out: r.out, code: r.failed ? 1 : 0 };
  });

test('the prompt hook hashes each Codex prompt itself (P30): the typed lines count, so the offer and its yes work with no stand-in', async () => {
  const b = codexBox('cx8-typed');
  try {
    const s = cxSession(b);
    await cxStart(s, at(20, 0));
    await cxPrompt(s, at(20, 1), 'publish 1.4.0');
    const shas = stateOf(s).codex?.typedShas ?? [];
    assert.equal(shas.length, 1, 'one keyed hash for the one prompt');
    assert.match(shas[0]!, /^[0-9a-f]{16}$/);
    assert.ok(stateOf(s).runs.some((r) => r.job === 'release'), 'the typed line started the release run');
  } finally {
    done(b);
  }
});

test("a prompt that is Trail's own Stop reason is never the person's: no hash, no answer, the offer stays (4.16, HC3)", async () => {
  const b = codexBox('cx8-own');
  try {
    for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2']] as const) {
      const s = cxSession(b);
      await cxStart(s, at(day, 0));
      await release(s, day, v, true);
      await finish(s, day, `Published ${v}: npm shows it.`);
    }
    const s = cxSession(b);
    await cxStart(s, at(27, 0));
    await release(s, 27, '1.4.3');
    const blocked = await finish(s, 27, 'Published 1.4.3: npm shows it.');
    assert.equal(blocked?.decision, 'block');
    const before = stateOf(s);
    const reason = String(blocked!.reason).replace(/ ?Trail keeps skills in ~\/\.trail[^]*$/, '');
    assert.equal(await cxPrompt(s, at(27, 50), reason), '', 'nothing out');
    const after = stateOf(s);
    assert.equal(after.pendingOffer?.offerId, before.pendingOffer!.offerId, 'the offer is not answered by it');
    assert.equal(after.pendingOffer?.typedAfter.length, 0);
    assert.deepEqual(after.codex?.typedShas, before.codex?.typedShas, 'its hash is never recorded');
  } finally {
    done(b);
  }
});

test('J13 Codex leg: a live block\'s gated step is denied and printed in every permission mode; never ask, never allow', async () => {
  const b = codexBox('cx8-j13');
  try {
    const s0 = cxSession(b);
    await release(s0, 20, '1.4.0');
    await finish(s0, 20, 'Published 1.4.0.');
    const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctxOf(one(await cxPrompt(s0, at(20, 60), 'save this as a skill')))) ?? [];
    await add(s0, b, at(20, 70), `trail skills add ${name} --run ${runId}`);
    assert.deepEqual(skillsKept(b), [name]);
    let day = 21;
    for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']) {
      const s = cxSession(b, { mode });
      await cxStart(s, at(day, 0));
      assert.match(ctxOf(one(await cxPrompt(s, at(day, 5), 'publish it'))), new RegExp(`^\\[trail\\] Skill ${name} fits`), mode);
      await cxRuns(s, at(day, 10), 'npm run build', () => ({ out: 'built' }));
      let ran = false;
      const pub = await cxRuns(s, at(day, 20), 'npm publish acme-cli-1.5.0.tgz --access public', () => ((ran = true), { out: '+ acme-cli@1.5.0' }));
      const out = pub.decision?.hookSpecificOutput;
      assert.equal(out?.permissionDecision, 'deny', mode);
      assert.match(out?.permissionDecisionReason ?? '', /in their own terminal: npm publish acme-cli-1\.5\.0\.tgz --access public$/, mode);
      assert.deepEqual(Object.keys(out).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'], 'the deny only');
      assert.equal(ran, false, `${mode}: the step never ran`);
      day++;
    }
  } finally {
    done(b);
  }
});

/* D137: a gated step denied and handed to the person; their next ask of the job continues the run, and the use counts. */

function uses(b: Box): Array<Record<string, any>> {
  const dir = join(b.trail, 'ledger');
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).filter((l) => l.event === 'use');
}

async function keptOnCodex(b: Box): Promise<string> {
  const s0 = cxSession(b);
  await release(s0, 20, '1.4.0');
  await finish(s0, 20, 'Published 1.4.0.');
  const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctxOf(one(await cxPrompt(s0, at(20, 60), 'save this as a skill')))) ?? [];
  await add(s0, b, at(20, 70), `trail skills add ${name} --run ${runId}`);
  assert.deepEqual(skillsKept(b), [name]);
  return name!;
}

for (const [label, later] of [['3 minutes', 180], ['45 minutes, past the 30-minute gap', 2700]] as const) {
  test(`D137 Codex: the publish is handed to the person; "publish 1.5.0" ${label} later continues the run, and the use reaches the ledger with step 2 handed`, async () => {
    const b = codexBox(`cx8-handed-${later}`);
    try {
      await keptOnCodex(b);
      const s = cxSession(b);
      await cxStart(s, at(21, 0));
      assert.match(ctxOf(one(await cxPrompt(s, at(21, 5), 'publish 1.5.0'))), /Skill release-npm fits/);
      await cxRuns(s, at(21, 10), 'npm run build', () => ({ out: 'built in 2.1s' }));
      const pub = await cxRuns(s, at(21, 20), 'npm publish acme-cli-1.5.0.tgz --access public', () => ({ out: 'not run' }));
      assert.equal(pub.decision?.hookSpecificOutput?.permissionDecision, 'deny');
      await finish(s, 21, 'Trail stopped the publish: please run npm publish acme-cli-1.5.0.tgz --access public in your terminal.', 30);
      assert.deepEqual(uses(b), [], 'nothing settled yet: the person has the step');
      const runId = stateOf(s).runs.at(-1)!.id;
      assert.match(ctxOf(one(await cxPrompt(s, at(21, later), 'publish 1.5.0'))), /Same job as before/);
      await cxRuns(s, at(21, later + 10), 'npm view acme-cli version', () => ({ out: '1.5.0' }));
      await finish(s, 21, 'npm shows 1.5.0.', later + 20);
      assert.equal(stateOf(s).runs.at(-1)!.id, runId, 'the same run, not a new one');
      const [u] = uses(b);
      assert.ok(u, 'the first use reached the ledger');
      assert.deepEqual([u!.stepsRan, u!.handed, u!.failedStep, u!.check, u!.host], [[1, 2], [2], null, 'passed', 'codex']);
    } finally {
      done(b);
    }
  });
}

test('D137: a different job after the hand-off starts its own run; the handed block is no use of it', async () => {
  const b = codexBox('cx8-handed-other');
  try {
    await keptOnCodex(b);
    const s = cxSession(b);
    await cxStart(s, at(21, 0));
    await cxPrompt(s, at(21, 5), 'publish 1.5.0');
    await cxRuns(s, at(21, 10), 'npm run build', () => ({ out: 'built in 2.1s' }));
    await cxRuns(s, at(21, 20), 'npm publish acme-cli-1.5.0.tgz --access public', () => ({ out: 'not run' }));
    await finish(s, 21, 'Trail stopped the publish.', 30);
    const runId = stateOf(s).runs.at(-1)!.id;
    await cxPrompt(s, at(21, 2700), 'run the test suite');
    await cxRuns(s, at(21, 2710), 'npm test', () => ({ out: 'Tests: 12 passed, 12 total' }));
    await finish(s, 21, 'Tests pass.', 2720);
    assert.notEqual(stateOf(s).runs.at(-1)!.id, runId);
    assert.ok(uses(b).every((u) => u.check !== 'passed'), JSON.stringify(uses(b)));
  } finally {
    done(b);
  }
});

test('D137: past the 2-hour wait the same ask starts a new run, and the re-armed block carries no hand-off into it', async () => {
  const b = codexBox('cx8-handed-late');
  try {
    await keptOnCodex(b);
    const s = cxSession(b);
    await cxStart(s, at(21, 0));
    await cxPrompt(s, at(21, 5), 'publish 1.5.0');
    await cxRuns(s, at(21, 10), 'npm run build', () => ({ out: 'built in 2.1s' }));
    await cxRuns(s, at(21, 20), 'npm publish acme-cli-1.5.0.tgz --access public', () => ({ out: 'not run' }));
    await finish(s, 21, 'Trail stopped the publish: please run it in your terminal.', 30);
    const runId = stateOf(s).runs.at(-1)!.id;
    // 3 hours later: the same words, so the same block is re-armed, for a new run.
    assert.match(ctxOf(one(await cxPrompt(s, at(21, 3 * 3600), 'publish 1.5.0'))), /Same job as before/);
    await cxRuns(s, at(21, 3 * 3600 + 10), 'npm view acme-cli version', () => ({ out: '1.4.0' }));
    await finish(s, 21, 'npm still shows 1.4.0.', 3 * 3600 + 20);
    const late = stateOf(s).runs.at(-1)!;
    assert.notEqual(late.id, runId, 'a new run');
    const inj = stateOf(s).injected.find((i) => i.runId === late.id);
    assert.ok(inj, 'the block is re-armed for the new run');
    assert.ok(Date.parse(inj!.at) >= Date.parse(at(21, 3 * 3600)), `the new run's window starts at its own ask: ${inj!.at}`);
    assert.deepEqual(inj!.handed ?? [], [], 'the old hand-off stays with the old run');
    assert.ok(uses(b).filter((u) => Array.isArray(u.handed)).length <= 1, JSON.stringify(uses(b)));
  } finally {
    done(b);
  }
});
