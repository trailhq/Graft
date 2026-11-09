/**
 * fix-lab5, item 6, reshaped to #663 (D184): with skills on, the only save ask Stop writes is #663's, raised by a
 * sign in the transcript (here a check that failed, then passed after an edit), once per sign. When a skill offer
 * is due at the same Stop, the offer is the one answer; the sign stays unasked, so #663's ask comes at a later Stop.
 * Made-up repo, prompts and commands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { ensureRepoHome } from '../src/notes/home.js';
import { agentRuns, at, box, done, finish, release, sayOfferLines, session, startHook, stateOf, stopHook, typedLine, type Box, type Session } from './claude-skills-journey-fixtures.js';

const SAVE_ASK = /save (?:a|one|the) learning|save it|trail note|graft note|took real digging|commit the learning/i;
/** #663's first line for the fix below. */
const FIXED_ASK = /^\[trail\] npm test failed once, then passed after your change to src\/client\.ts\./;

/** A box on trail whose project keeps learnings and has the code the fix edits, so #663's ask can fire there. */
function trailBox(tag: string): Box {
  const b = box(tag);
  ensureRepoHome(b.project, { ...process.env, TRAIL_HOME: b.trail });
  mkdirSync(join(b.project, 'src'), { recursive: true });
  writeFileSync(join(b.project, 'src', 'client.ts'), 'export const retries = 4;\n');
  return b;
}

async function withTrail<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env[BRAND_ENV];
  process.env[BRAND_ENV] = 'trail';
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[BRAND_ENV];
    else process.env[BRAND_ENV] = before;
  }
}

/** Reading and passing checks only: tool calls alone are no sign. */
async function dig(s: Session, day: number, from: number): Promise<void> {
  typedLine(s, at(day, from), 'why does the retry loop hang on the second request');
  for (const [k, c] of ['grep -rn retry src', 'sed -n 1,80p src/client.ts', 'npm test -- client', 'git log --oneline -5 src/client.ts', 'npm test'].entries())
    await agentRuns(s, at(day, from + 1 + k), c, () => ({ out: 'ok' }));
}

/** Reading only, no check: a later turn that raises no new sign. */
async function read(s: Session, day: number, from: number): Promise<void> {
  typedLine(s, at(day, from), 'where else is the retry count read');
  for (const [k, c] of ['grep -rn retries src', 'sed -n 1,20p src/client.ts'].entries()) await agentRuns(s, at(day, from + 1 + k), c, () => ({ out: 'ok' }));
}

/** #663's `fixed` sign: npm test fails, the code is changed, npm test passes. */
async function fix(s: Session, day: number, from: number): Promise<void> {
  typedLine(s, at(day, from), 'the retry test fails, fix it');
  await agentRuns(s, at(day, from + 1), 'npm test', () => ({ out: 'Exit code 1\nTests: 1 failed, 11 passed, 12 total', failed: true }));
  await agentRuns(s, at(day, from + 2), `sed -i '' 's/4/6/' ${join(s.b.project, 'src', 'client.ts')}`, () => ({ out: '' }));
  await agentRuns(s, at(day, from + 3), 'npm test', () => ({ out: 'Tests: 12 passed, 12 total' }));
}

test("with skills on, Stop's only save ask is #663's, on a sign, once per sign; digging alone asks nothing", () =>
  withTrail(async () => {
    const b = trailBox('stop-no-save');
    try {
      const s = session(b);
      await startHook(s, at(10, 0));
      await dig(s, 10, 1);
      const quiet = await finish(s, 10, 'The retry hangs because the timer is never cleared.');
      assert.ok(!SAVE_ASK.test(JSON.stringify(quiet ?? {})), 'tool calls alone are no sign');
      await fix(s, 10, 50);
      const out = await finish(s, 10, 'Fixed: the retry count was wrong.', 60);
      assert.equal(out?.decision, 'block');
      assert.match(out?.reason, FIXED_ASK);
      assert.equal(await stopHook(s, at(10, 70), 'Saved it.', true), '', 'nothing on a continued Stop');
      await read(s, 10, 100);
      assert.equal(await finish(s, 10, 'Nothing else hangs.', 140), null, 'each sign once');
    } finally {
      done(b);
    }
  }));

test('when an offer and #663 ask are both due, the offer is the one answer and the ask comes at a later Stop', () =>
  withTrail(async () => {
    const b = trailBox('stop-offer-first');
    try {
      let offers = 0;
      for (const day of [3, 5, 7]) {
        const s = session(b);
        await startHook(s, at(day, 0));
        // Day 7: a fix earlier in the session makes #663's ask due; then the release, which is offered.
        if (day === 7) await fix(s, day, -30);
        await release(s, day, `1.4.${day}`, { failedFirst: true });
        if (day < 7) {
          const out = await finish(s, day, 'Published.');
          assert.ok(!SAVE_ASK.test(JSON.stringify(out ?? {})), `day ${day}: a release with no sign asks nothing`);
          continue;
        }
        const out = await finish(s, day, 'Published.');
        const text = JSON.stringify(out);
        assert.ok(!SAVE_ASK.test(text), text);
        assert.match(text, /\(yes \/ (?:show me \/ )?no\)/, 'the person is asked about the skill');
        offers++;
        // The agent says the offer's 2 lines; that continued Stop says nothing.
        assert.equal(await sayOfferLines(s, day, stateOf(s).pendingOffer!.lines!), null);
        // A later Stop in the same session: the sign was left unasked, so now #663's ask is the answer.
        await read(s, day, 100);
        const later = await finish(s, day, 'The retry hangs because the timer is never cleared.', 140);
        assert.equal(later?.decision, 'block');
        assert.match(later?.reason, FIXED_ASK);
      }
      assert.equal(offers, 1, 'the third day offers the release once');
    } finally {
      done(b);
    }
  }));
