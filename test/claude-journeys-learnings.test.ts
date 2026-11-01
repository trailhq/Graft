/**
 * Part 7 through the real hooks: learnings and skills never repeat or
 * contradict each other in what the agent hears. A preference that only
 * repeats a step is said once, in the run block (the schema example's
 * "don't edit _schema.py by hand, run scripts/gen_schema.py"); one that
 * goes against a step wins at the offer, at the save and at recall, where
 * the update offer then proposes the change. Made-up repo and prompts only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderNote } from '../src/notes/notes.js';
import {
  agentRuns, at, box, cli, done, finish, hook, lastCli, one, promptHook, sayOfferLines, session, skillsKept, stateOf, testsJob, type Box, type Session,
} from './claude-skills-journey-fixtures.js';

const ctxOf = (out: Record<string, any> | null): string => out?.hookSpecificOutput?.additionalContext ?? '';
const count = (text: string, part: string) => text.split(part).length - 1;

/** A learning of the person's own for acme/shop, as `trail note --personal` or init's keep writes one. */
function learning(b: Box, file: string, title: string, kind: 'preference' | 'decision', id: string, touches: string[] = []): void {
  const dir = join(b.trail, 'repos', 'github.com', 'acme', 'shop', 'notes');
  mkdirSync(dir, { recursive: true });
  // One that lists a file comes on that file's open; a standing one is left to the session-start list.
  writeFileSync(join(dir, file), renderNote({ title, body: title, author: '', date: '2026-10-15', touches, id, kind, applies: 'github.com/acme/shop', ...(touches.length ? {} : { standing: true }) }));
}

/** The agent opens `file` in the checkout: PostToolUse on a Read, where on-touch learnings come. */
const opens = async (s: Session, iso: string, file: string) =>
  ctxOf(one(await hook(s, 'tool-savings', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(s.b.repo, file) }, tool_response: 'x' }, iso)));

const skillFile = (b: Box, name: string) => readFileSync(join(b.trail, 'skills', name, 'SKILL.md'), 'utf8');

/** The schema is generated, then the suite runs: the schema example's job. */
async function schemaTests(s: Session, day: number): Promise<void> {
  await promptHook(s, at(day, 0), 'run the test suite');
  await agentRuns(s, at(day, 10), 'python scripts/gen_schema.py', () => ({ out: 'wrote src/_schema.py' }));
  await agentRuns(s, at(day, 20), 'pytest -q', () => ({ out: 'Exit code 1\n1 failed, 11 passed in 0.41s', failed: true }));
  await agentRuns(s, at(day, 30), 'pytest -q', () => ({ out: '12 passed in 0.40s' }));
}

/** Kept because the person asked: "save this as a skill" after the job. */
async function askedSave(s: Session, day: number, said: string): Promise<string> {
  await finish(s, day, said);
  const ctx = ctxOf(one(await promptHook(s, at(day, 60), 'save this as a skill')));
  const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctx) ?? [];
  assert.ok(name, ctx);
  const command = `trail skills add ${name} --run ${runId}`;
  await agentRuns(s, at(day, 70), command, cli(s.b, at(day, 70), command));
  assert.equal(lastCli()?.exit, 0, lastCli()?.lines.join('\n'));
  return name!;
}

test('the schema example: the preference and the skill step that runs gen_schema are said once, in the run block', async () => {
  const b = box('p7-once');
  // The prompt hook's learnings are read for the checkout the session is in, under trail.
  Object.assign(b.env, { CLAUDE_PROJECT_DIR: b.repo, TRAIL_INVOKED_AS: 'trail' });
  try {
    const pref = "don't edit _schema.py by hand, run scripts/gen_schema.py";
    learning(b, '2026-10-15-schema.md', pref, 'preference', 'l-5c4e3a21');
    const s1 = session(b);
    await schemaTests(s1, 20);
    const name = await askedSave(s1, 20, 'All 12 tests pass.');
    assert.match(skillFile(b, name), /python scripts\/gen_schema\.py/, 'a repeat changes nothing at the save');
    assert.doesNotMatch(lastCli()!.lines.join('\n'), /follow/, 'and the save line has nothing to say about it');

    const s = session(b);
    const ctx = ctxOf(one(await promptHook(s, at(22, 5), 'run the test suite, I touched the _schema file')));
    assert.match(ctx, new RegExp(`\\[trail\\] Skill ${name} fits`), ctx);
    assert.equal(count(ctx, pref), 1, `one mention, not two:\n${ctx}`);
    assert.match(ctx, /\n {2}Step 1 follows your learning: "don't edit _schema\.py by hand, run scripts\/gen_schema\.py"\.\n/);
    assert.doesNotMatch(ctx, /learnings earlier sessions left on this/, 'no learnings lines repeat it');

    // Without the skill the same prompt still brings the preference as a learning: the dedupe is the block's, not a loss.
    const b2 = box('p7-once-b');
    Object.assign(b2.env, { CLAUDE_PROJECT_DIR: b2.repo, TRAIL_INVOKED_AS: 'trail' });
    try {
      learning(b2, '2026-10-15-schema.md', pref, 'preference', 'l-5c4e3a21');
      const alone = ctxOf(one(await promptHook(session(b2), at(22, 5), 'run the test suite, I touched the _schema file')));
      assert.equal(count(alone, pref), 1, alone);
      assert.match(alone, /learnings earlier sessions left on this/);
    } finally {
      done(b2);
    }
  } finally {
    done(b);
  }
});

test('the schema example with a learning on file open: whichever comes first, the other does not say it again', async () => {
  const b = box('p7-touch');
  Object.assign(b.env, { CLAUDE_PROJECT_DIR: b.repo, TRAIL_INVOKED_AS: 'trail' });
  try {
    const pref = "don't edit _schema.py by hand, run scripts/gen_schema.py";
    learning(b, '2026-10-15-schema.md', pref, 'preference', 'l-5c4e3a21', ['src/_schema.py']);
    const s1 = session(b);
    await schemaTests(s1, 20);
    const name = await askedSave(s1, 20, 'All 12 tests pass.');

    // The block says it first: opening the file later brings nothing more.
    const s = session(b);
    const ctx = ctxOf(one(await promptHook(s, at(22, 5), 'run the test suite, I touched the _schema file')));
    assert.match(ctx, new RegExp(`\\[trail\\] Skill ${name} fits`), ctx);
    assert.equal(count(ctx, pref), 1, ctx);
    assert.match(ctx, /Step 1 follows your learning/);
    assert.doesNotMatch(await opens(s, at(22, 20), 'src/_schema.py'), /_schema\.py by hand/, 'the block already said it');

    // The file is opened first: the block keeps its steps and drops the follows line.
    const t = session(b);
    assert.match(await opens(t, at(23, 0), 'src/_schema.py'), /_schema\.py by hand/, 'on-touch shows it, as before');
    const later = ctxOf(one(await promptHook(t, at(23, 10), 'run the test suite')));
    assert.match(later, new RegExp(`\\[trail\\] Skill ${name} fits`), later);
    assert.match(later, /python scripts\/gen_schema\.py/);
    assert.equal(count(later, pref), 0, `already shown on file open:\n${later}`);
  } finally {
    done(b);
  }
});

test('pnpm vs npm: the offer names it in one line, the yes keeps the steps the preference\'s way', async () => {
  const b = box('p7-offer');
  try {
    learning(b, '2026-10-15-pnpm.md', 'use pnpm, not npm', 'preference', 'l-7d2f9a10');
    for (const day of [28, 29]) {
      const t = session(b);
      await testsJob(t, day, { failedFirst: true });
      assert.equal(await finish(t, day, 'All 12 tests pass.'), null, `day ${day}: no offer yet`);
    }
    const t = session(b);
    await testsJob(t, 30, { failedFirst: true });
    const blocked = await finish(t, 30, 'All 12 tests pass.');
    assert.equal(blocked?.decision, 'block', JSON.stringify(blocked));
    const offer = stateOf(t).pendingOffer!;
    assert.match(offer.lines[0]!, / Steps 1, 2 and 3 follow your learning "use pnpm, not npm" rather than this run's commands\.$/, offer.lines[0]);
    assert.match(offer.lines[1]!, /^Keep the 3 that worked as a skill/);
    assert.ok(offer.lines[0]!.length <= 400);
    assert.ok(blocked!.reason.includes(offer.lines[0]!), 'the agent says the line as Trail wrote it');

    await sayOfferLines(t, 30, offer.lines);
    const yes = ctxOf(one(await promptHook(t, at(30, 80), 'yes')));
    const command = `trail skills add ${offer.name} --run ${offer.runId}`;
    assert.ok(yes.includes(command), yes);
    await agentRuns(t, at(30, 82), command, cli(b, at(30, 82), command));
    assert.equal(lastCli()?.exit, 0, lastCli()?.lines.join('\n'));
    assert.deepEqual(skillsKept(b), [offer.name]);
    const file = skillFile(b, offer.name);
    assert.match(file, /pnpm install --frozen-lockfile/);
    assert.match(file, /pnpm run build/);
    assert.match(file, /pnpm test/);
    assert.doesNotMatch(file, /(?:^|[\s`(])npm (?:ci|test|run)\b/m, file);
    assert.match(lastCli()!.lines[1]!, /Steps 1, 2 and 3 follow your learning "use pnpm, not npm" rather than this run's commands\./);
  } finally {
    done(b);
  }
});

test('pnpm vs npm at recall: the preference wins in the block, and the update offer proposes the change', async () => {
  const b = box('p7-recall');
  try {
    // Kept on Oct 20 with npm, before the person said they use pnpm.
    const s1 = session(b);
    await testsJob(s1, 20, { failedFirst: true });
    const name = await askedSave(s1, 20, 'All 12 tests pass.');
    assert.match(skillFile(b, name), /npm test/);
    learning(b, '2026-10-21-pnpm.md', 'use pnpm, not npm', 'preference', 'l-7d2f9a10');

    const s = session(b);
    const ctx = ctxOf(one(await promptHook(s, at(22, 0), 'run the test suite')));
    assert.match(ctx, new RegExp(`^\\[trail\\] Skill ${name} fits`), ctx);
    assert.match(ctx, /\n {2}1 pnpm install --frozen-lockfile \(your learning's way; the skill has npm ci\)\n/, ctx);
    assert.match(ctx, /\n {2}3 pnpm test \(your learning's way; the skill has npm test\)\n/);
    assert.match(ctx, /\n {2}Your learning wins over the skill: "use pnpm, not npm"\. Steps 1, 2 and 3 are written its way; run them as shown\.\n/);
    const inj = stateOf(s).injected.at(-1)!;
    assert.deepEqual(inj.steps, ['pnpm install --frozen-lockfile', 'pnpm run build', 'pnpm test'], 'credit reads the steps as the block showed them');
    assert.equal(inj.check, 'pnpm test');

    // The agent runs them as shown; the suite passes.
    await agentRuns(s, at(22, 10), 'pnpm install --frozen-lockfile', () => ({ out: 'Done in 3.1s' }));
    await agentRuns(s, at(22, 15), 'pnpm run build', () => ({ out: 'built in 2.1s' }));
    await agentRuns(s, at(22, 30), 'pnpm test', () => ({ out: 'Tests: 12 passed, 12 total' }));
    const stop = await finish(s, 22, `All 12 tests pass.\nUsed skill ${name}`);
    assert.equal(stop?.decision, 'block', JSON.stringify(stop));
    const offer = stateOf(s).pendingOffer!;
    assert.equal(offer.moment, 'update');
    assert.equal(offer.fold?.op, 'update');
    assert.deepEqual(offer.lines, [
      `Tests pass (12 passed). This time steps 1, 2 and 3 of ${name} ran as 'pnpm install --frozen-lockfile', 'pnpm run build' and 1 more, the way your learning says.`,
      `Change steps 1, 2 and 3 of ${name} to match? 3 line changes. (yes / show me / no)`,
    ]);
    assert.match(offer.fold!.proposalSha, /^[0-9a-f]{16}$/, 'pinned to the text a yes would write, as every update offer is');
    assert.match(skillFile(b, name), /npm test/, 'nothing changes before the yes');
  } finally {
    done(b);
  }
});
