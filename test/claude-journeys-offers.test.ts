/**
 * Journeys J08 and J09 through the real hooks (design 5, g7-wiring): a no
 * is said once and the job is never offered again, a 2nd no in a row
 * quiets the repo for 2 weeks, and offers turned off stay off while recall
 * keeps working. Made-up repo and prompts only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setOffers } from '../src/skills/settings.js';
import {
  agentRuns, at, box, cli, done, finish, offersLog, one, promptHook, release, sayOfferLines, session, skillsKept, startHook, stateOf, testsJob, type Box,
} from './claude-skills-journey-fixtures.js';

const settingsOf = (b: Box) => JSON.parse(readFileSync(join(b.trail, 'settings.json'), 'utf8'));
const shown = (b: Box) => offersLog(b).filter((l) => l.event === 'shown');

/** What the prompt hook tells the agent to say: a block's reason or the context's quoted line. */
function toSay(out: Record<string, any> | null): string {
  if (out?.decision === 'block') return out.reason;
  return out?.hookSpecificOutput?.additionalContext ?? '';
}

/** Releases on days 25 and 26 (each costly), then day 27's: the 3rd day's Stop offers. */
async function releaseOffered(b: Box): Promise<{ s: ReturnType<typeof session>; lines: string[] }> {
  for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2']] as const) {
    const s = session(b);
    await release(s, day, v, { failedFirst: true });
    assert.equal(await finish(s, day, `Published ${v}.`), null);
  }
  const s = session(b);
  await release(s, 27, '1.4.3');
  const blocked = await finish(s, 27, 'Published 1.4.3.');
  assert.equal(blocked?.decision, 'block', JSON.stringify(blocked));
  const lines = stateOf(s).pendingOffer!.lines;
  assert.equal(await sayOfferLines(s, 27, lines), null);
  return { s, lines };
}

test('J08: a no is said once, the job is never offered again, and the 2nd no in a row quiets the repo for 2 weeks', async () => {
  const b = box('j08');
  try {
    const { s } = await releaseOffered(b);
    const no1 = one(await promptHook(s, at(27, 60), 'no'));
    assert.match(toSay(no1), /OK, not saved\. \(To stop these offers: trail skills offers off\)/, 'the first no ever says how to stop offers');
    assert.equal(stateOf(s).pendingOffer, null);
    assert.deepEqual(settingsOf(b).lastNine, ['no']);

    // The test suite, 3 costly days in a new session each; the 3rd is offered and gets the 2nd no.
    for (const day of [28, 29]) {
      const t = session(b);
      await testsJob(t, day, { failedFirst: true });
      assert.equal(await finish(t, day, 'All 12 tests pass.'), null, `tests day ${day}: no offer yet`);
    }
    const t = session(b);
    await testsJob(t, 30, { failedFirst: true });
    const blocked = await finish(t, 30, 'All 12 tests pass.');
    assert.equal(blocked?.decision, 'block', JSON.stringify(blocked));
    assert.match(stateOf(t).pendingOffer!.key, /\|job:tests$/);
    await sayOfferLines(t, 30, stateOf(t).pendingOffer!.lines);
    const no2 = one(await promptHook(t, at(30, 60), 'no'));
    assert.match(toSay(no2), /OK, not saved\. I won't offer skills in this repo for 2 weeks\./, 'the 2nd no in a row: the quiet line');
    const settings = settingsOf(b);
    assert.deepEqual(settings.lastNine, ['no', 'no']);
    assert.ok(Object.values(settings.pausedUntil ?? {}).some((d) => typeof d === 'string' && d >= '2026-11-13'), JSON.stringify(settings.pausedUntil));

    // Day 31 and day 36 the release checks out again, from scratch: no offer, and no quiet line again.
    for (const [day, v] of [[31, '1.4.4'], [36, '1.4.5']] as const) {
      const r = session(b);
      await release(r, day, v, { failedFirst: true });
      assert.equal(await finish(r, day, `Published ${v}.`), null, `day ${day}: never offered again`);
      assert.equal(stateOf(r).pendingOffer, null);
    }
    assert.equal(shown(b).length, 2, JSON.stringify(offersLog(b)));
    assert.deepEqual(skillsKept(b), []);
  } finally {
    done(b);
  }
});

test('J09: with offers off, the 3rd day offers nothing, a kept skill still comes back, and Trail never writes the setting back', async () => {
  const b = box('j09');
  try {
    // A kept skill first: "save this as a skill" after a release.
    const s = session(b);
    await release(s, 20, '1.4.0');
    await finish(s, 20, 'Published 1.4.0.');
    const asked = toSay(one(await promptHook(s, at(20, 60), 'save this as a skill')));
    const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(asked)!;
    const command = `trail skills add ${name} --run ${runId}`;
    await agentRuns(s, at(20, 70), command, cli(b, at(20, 70), command));
    assert.deepEqual(skillsKept(b), [name]);

    setOffers(false, null, { TRAIL_HOME: b.trail }, new Date(at(21)));
    const before = readFileSync(join(b.trail, 'settings.json'), 'utf8');
    assert.equal(JSON.parse(before).offers, 'off');

    // The test suite reaches its 3rd costly day: nothing offered.
    for (const day of [22, 23, 24]) {
      const t = session(b);
      await startHook(t, at(day, 0));
      await testsJob(t, day, { failedFirst: true, sec: 1 });
      assert.equal(await finish(t, day, 'All 12 tests pass.'), null, `day ${day}: offers are off`);
      assert.equal(stateOf(t).pendingOffer, null);
    }
    // Off stops offers, not recall.
    const r = session(b);
    const block = one(await promptHook(r, at(25, 0), 'publish 1.4.6'));
    assert.match(block?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`^\\[trail\\] Skill ${name} fits`));
    assert.equal(shown(b).length, 0, JSON.stringify(offersLog(b)));
    assert.equal(readFileSync(join(b.trail, 'settings.json'), 'utf8'), before, 'the hooks never write offers back');
  } finally {
    done(b);
  }
});
