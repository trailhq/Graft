/**
 * Phase 2 through the real hooks (c8), continued: the retire proposal on 5 seeded firings and a live sixth, and the
 * fold after J07 (a lesson kept on the skill, then the use that ran it, extended into the skill). Every hook goes
 * through `main(event)` with Claude Code's payloads; the telemetry each journey queues is checked in order. Made-up
 * acme/shop and acme-cli only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentRuns, at, box, done, finish, one, promptHook, reply, sayOfferLines, session, stateOf, stopHook, testsJob } from './claude-skills-journey-fixtures.js';
import { blockOf, ctxOf, envOf, kept, offerLinesIn, PREP, publishOf, skillsEvents, TELEMETRY_ENV, updateCommandIn, type Session } from './claude-journeys-2-fixtures.js';
import { keepLessonCli } from '../src/skills/lesson-gate.js';
import { offerLinesOf } from '../src/skills/offer-lines.js';
import { readLedger } from '../src/skills/ledger.js';
import { updateCommand } from '../src/skills/cli-skills-2.js';
import { listAllPersonal } from '../src/skills/store.js';
import { getSkillState, updateSkillState } from '../src/skills/state.js';

test('the retire proposal: 5 firings seeded, 1 followed; a sixth not followed at Stop proposes retiring it; "retire" moves it to .retired', async () => {
  const b = box('c8-retire', { env: TELEMETRY_ENV });
  try {
    const name = await kept(b, 20, '1.4.0');
    const env = envOf(b, at(21, 0));
    const ref = listAllPersonal(env).find((r) => r.name === name)!;
    const seeded = [21, 22, 23, 24, 25].map((d, k) => ({ at: at(d, 3600), followed: k === 0 }));
    updateSkillState(ref.id, (s) => (s ? { ...s, firings: seeded } : s), env);
    const before = skillsEvents(b).length;

    // Oct 26: the ask brings the block in; the agent does something else; the next ask closes that run in the prompt
    // hook, whose settle writes the sixth firing, and the Stop after that job proposes the retire.
    const s = session(b);
    assert.match(ctxOf(one(await promptHook(s, at(26, 0), 'publish 1.4.5'))), new RegExp(`Skill ${name} fits`));
    reply(s, at(26, 10), 'The changelog has nothing new since 1.4.4, so I left the release alone.');
    assert.equal(one(await stopHook(s, at(26, 11), 'The changelog has nothing new since 1.4.4, so I left the release alone.')), null);
    await testsJob(s, 26, { sec: 70 });
    reply(s, at(26, 110), 'Tests: 12 passed.');
    const block = blockOf(one(await stopHook(s, at(26, 111), 'Tests: 12 passed.')));
    const lines = offerLinesIn(block);
    assert.equal(lines[0], `Trail brought in skill ${name} 6 times lately, and its steps ran in 1 of them.`);
    assert.equal(lines[1], `Retire it? trail skills restore ${name} brings it back. (retire / keep it)`);
    const firings = getSkillState(ref.id, env)?.firings ?? [];
    assert.deepEqual([firings.length, firings.filter((f) => f.followed).length], [6, 1]);

    reply(s, at(26, 115), `Done.\n\n${lines[0]}\n${lines[1]}`);
    assert.equal(one(await stopHook(s, at(26, 116), `Done.\n\n${lines[0]}\n${lines[1]}`, true)), null);
    const said = ctxOf(one(await promptHook(s, at(26, 120), 'retire')));
    assert.match(said, new RegExp(`Trail retired ${name}\\.`), said);
    assert.equal(existsSync(ref.dir), false);
    assert.ok(existsSync(join(b.trail, 'skills', '.retired', `${name}-2026-10-26`, 'SKILL.md')), 'moved, nothing deleted');
    assert.deepEqual(skillsEvents(b).slice(before), ['skill_offered:retire', 'skill_answer:retire', 'skill_changed:retire']);
  } finally {
    done(b);
  }
});

test('the retire proposal comes once, ever: "keep it" keeps the skill, and later unfollowed firings bring no second one', async () => {
  const b = box('c8-retire-keep', { env: TELEMETRY_ENV });
  try {
    const name = await kept(b, 20, '1.4.0');
    const env = envOf(b, at(21, 0));
    const ref = listAllPersonal(env).find((r) => r.name === name)!;
    updateSkillState(ref.id, (s) => (s ? { ...s, firings: [21, 22, 23, 24, 25].map((d) => ({ at: at(d, 3600), followed: false })) } : s), env);
    for (const day of [26, 27]) {
      const s = session(b);
      await promptHook(s, at(day, 0), 'publish 1.4.5');
      reply(s, at(day, 10), 'Nothing to release today.');
      await stopHook(s, at(day, 11), 'Nothing to release today.');
      // The ask's line lands after the hook ran (Claude Code sometimes writes it so): the Stop's own settle writes the firing.
      await promptHook(s, at(day, 60), 'run the test suite', { lineFirst: false });
      await agentRuns(s, at(day, 80), 'npm test', () => ({ out: 'Tests: 12 passed, 12 total' }));
      reply(s, at(day, 110), 'Tests: 12 passed.');
      const out = one(await stopHook(s, at(day, 111), 'Tests: 12 passed.'));
      if (day === 26) {
        const lines = offerLinesIn(blockOf(out));
        reply(s, at(day, 115), `Done.\n\n${lines[0]}\n${lines[1]}`);
        await stopHook(s, at(day, 116), `Done.\n\n${lines[0]}\n${lines[1]}`, true);
        await promptHook(s, at(day, 120), 'keep it');
        assert.ok(existsSync(ref.file), 'kept');
      } else assert.equal(blockOf(out), '', 'no second proposal');
    }
    assert.deepEqual(skillsEvents(b).filter((e) => /retire|answer/.test(e)), ['skill_offered:retire', 'skill_answer:no']);
  } finally {
    done(b);
  }
});


const STAMP = (v: string) => `node scripts/stamp-cli.mjs ${v}`;
/** A release from the block: the prep steps, `extra` right after the build, the publish, and npm shows it. */
async function releaseWith(s: Session, day: number, v: string, extra: string[] = []): Promise<void> {
  await promptHook(s, at(day, 0), `publish ${v}`);
  let t = 5;
  for (const p of PREP) {
    await agentRuns(s, at(day, (t += 2)), p, () => ({ out: 'ok' }));
    if (p === 'npm run build') for (const e of extra) await agentRuns(s, at(day, (t += 2)), e, () => ({ out: `stamped ${v}` }));
  }
  await agentRuns(s, at(day, (t += 2)), publishOf(v), () => ({ out: `+ acme-cli@${v}` }));
  await agentRuns(s, at(day, 30), 'npm view acme-cli version', () => ({ out: v }));
}

test('J07 then the fold: the lesson the person kept on Oct 22 runs on Oct 24, and its yes folds it into the skill as v2 (story 4)', async () => {
  const b = box('c8-j07-fold', { env: TELEMETRY_ENV });
  try {
    const name = await kept(b, 20, '1.4.0');
    const before = skillsEvents(b).length;
    // Oct 22 (J07): the release from the block, the person's correction, the fix, the lesson offer, yes, trail skills lesson.
    const s = session(b);
    await releaseWith(s, 22, '1.4.1');
    await finish(s, 22, `Published 1.4.1.\nUsed skill ${name}`);
    await promptHook(s, at(22, 60), "no, it didn't stamp the build");
    await agentRuns(s, at(22, 70), STAMP('1.4.1'), () => ({ out: 'stamped 1.4.1' }));
    const stop = await finish(s, 22, 'Stamped the build.', 80);
    assert.equal(stop?.decision, 'block', JSON.stringify(stop));
    const offer = stateOf(s).pendingOffer!;
    assert.equal(offer.moment, 'correction');
    const lines = offerLinesOf(offer, s.tx, envOf(b, at(22, 81)))!;
    assert.match(lines[1]!, /^Add a learning to it, just for you: "stamp the build too: node scripts\/stamp-cli\.mjs \{version\}"\? \(yes \/ no\)$/, lines[1]);
    await sayOfferLines(s, 22, lines, 85);
    await promptHook(s, at(22, 100), 'yes');
    const lessonCmd = `trail skills lesson ${name} --offer ${offer.offerId}`;
    const keptLesson = await agentRuns(s, at(22, 110), lessonCmd, () => {
      const r = keepLessonCli(name, offer.offerId, envOf(b, at(22, 111)), new Date(at(22, 111)));
      return { out: r.line, failed: r.code !== 0 };
    });
    assert.match(keptLesson.out, new RegExp(`^✓ learning added to ${name}`), keptLesson.out);

    // Oct 24: the block ends with the lesson; the agent runs it after the build; Stop offers to fold it in.
    const s2 = session(b);
    await releaseWith(s2, 24, '1.4.2', [STAMP('1.4.2')]);
    reply(s2, at(24, 40), 'Published 1.4.2: npm shows it.');
    const block = blockOf(one(await stopHook(s2, at(24, 41), 'Published 1.4.2: npm shows it.')));
    const [l1, l2] = offerLinesIn(block);
    assert.match(l2, new RegExp(`^Fold your Oct 22 learning into ${name} as step 5\\? 1 line changes\\. \\(yes / show me / no\\)$`), l2);
    await sayOfferLines(s2, 24, [l1, l2], 45);
    const update = updateCommandIn(ctxOf(one(await promptHook(s2, at(24, 60), 'yes'))));
    // The agent's shell runs the CLI: `updateCommand` prints what cliUpdate returns and sends skill_changed itself.
    const printed: string[] = [];
    const cliEvents: string[] = [];
    let code = -1;
    await agentRuns(s2, at(24, 70), update, () => {
      const offerId = /--offer (\S+)/.exec(update)![1]!;
      code = updateCommand(name, { offer: offerId }, {
        env: envOf(b, at(24, 70)), now: () => new Date(at(24, 71)), person: () => ({ ok: false }) as never,
        track: (e, p) => cliEvents.push(`${e}:${p.op}`), out: (l) => printed.push(l), err: (l) => printed.push(l),
      });
      return { out: printed.join('\n'), failed: code !== 0 };
    });
    assert.equal(code, 0, printed.join('\n'));
    assert.match(printed[0]!, new RegExp(`^✓ changed ${name} to v2 · `));
    assert.deepEqual(cliEvents, ['skill_changed:extend']);
    const env = envOf(b, at(24, 80));
    const ref = listAllPersonal(env).find((r) => r.name === name)!;
    assert.match(readFileSync(ref.file, 'utf8'), /node scripts\/stamp-cli\.mjs \{version\}/);
    const changed = readLedger(ref.id, env).filter((l) => l.event === 'changed');
    assert.deepEqual(changed.map((l: any) => [l.op, l.from, l.to, (l.lessonIds ?? []).length]), [['extend', 1, 2, 1]]);
    // The hooks' events in order (a kept lesson sends none: skill_saved is for skills).
    assert.deepEqual(skillsEvents(b).slice(before).filter((e) => !e.startsWith('skill_used')),
      ['skill_offered:correction', 'skill_answer:yes', 'skill_offered:update', 'skill_answer:yes']);
    assert.deepEqual(skillsEvents(b).slice(before).filter((e) => e.startsWith('skill_used')), ['skill_used:checked', 'skill_used:checked']);
  } finally {
    done(b);
  }
});
