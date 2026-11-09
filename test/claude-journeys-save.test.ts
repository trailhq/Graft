/**
 * Journeys J05, J04, J08 and J09 through the real hooks (design 5,
 * g7-wiring): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and
 * Stop all run through `main(event)`, the transcript grows between them,
 * and the CLI step is g5's `cliAdd`, as `trail skills add` runs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRuns, at, box, cli, done, lastCli, offersLog, one, promptHook, release, reply, session, skillsKept, startHook, stateOf, stopHook,
} from './claude-skills-journey-fixtures.js';
import { SKILLS_INTRO } from '../src/claude/start-skills.js';

test('J05: "save this as a skill" after a release that worked keeps it, and the next session\'s "publish 1.4.4" gets the run block', async () => {
  const b = box('j05');
  try {
    const s = session(b);
    assert.equal(one(await startHook(s, at(27, 0)))?.hookSpecificOutput?.additionalContext, SKILLS_INTRO.join('\n'), 'no skills yet: only the intro lines on what Trail keeps');
    await release(s, 27, '1.4.3');
    const done1 = 'Published 1.4.3: npm shows it.';
    reply(s, at(27, 40), done1);
    assert.equal(one(await stopHook(s, at(27, 41), done1)), null, 'the 1st day of a job: no offer');

    const asked = one(await promptHook(s, at(27, 60), 'save this as a skill'));
    const directive = asked?.hookSpecificOutput?.additionalContext ?? '';
    const m = /^\[trail\] From Trail, the tool this person installed to keep commands that worked as skills\. They typed: "save this as a skill"\. The last job here worked, so to keep it as they asked, run: trail skills add ([a-z0-9-]+) --run (r-\d{4}-[0-9a-f]+)\. Trail checks their words in this session before it keeps anything\. Then tell them the line it prints\.$/.exec(directive);
    assert.ok(m, directive);
    const [, name, runId] = m!;
    assert.equal(asked?.systemMessage, undefined);

    const add = await agentRuns(s, at(27, 70), `trail skills add ${name} --run ${runId}`, cli(b, at(27, 70), `trail skills add ${name} --run ${runId}`));
    assert.equal(add.decision, null, 'the save gate lets the add run');
    const receipt = JSON.parse(readFileSync(join(b.trail, 'receipts', `${s.sid}.json`), 'utf8'));
    assert.equal(receipt.typedSave, true);
    assert.equal(receipt.stepsVerified, receipt.stepsTotal);
    assert.equal(lastCli()?.exit, 0, lastCli()?.lines.join('\n'));
    assert.deepEqual(lastCli()?.saved, { from: 'asked', scope: 'personal' });
    assert.match(lastCli()!.lines[1]!, new RegExp(`^Tell the person what Trail kept: Saved ${name}, just for you in this repo: \\d+ steps? and its check, each one ran here at \\d\\d:\\d\\d today\\. `));
    assert.deepEqual(skillsKept(b), [name]);
    const skill = readFileSync(join(b.trail, 'skills', name!, 'SKILL.md'), 'utf8');
    assert.match(skill, /npm publish acme-cli-\{version\}\.tgz --access public/);
    assert.doesNotMatch(skill, /trail skills add/, 'Trail\'s own command is never a step');

    // A new session, the next day.
    const s2 = session(b);
    const start = one(await startHook(s2, at(28, 0)));
    assert.match(start?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`Trail skills here: ${name}`), 'the index line names it');
    const block = one(await promptHook(s2, at(28, 5), 'publish 1.4.4'));
    const ctx = block?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(ctx, new RegExp(`^\\[trail\\] Skill ${name} fits \\(yours, v1, last worked Oct 27\\)\\. Start from these exact steps, in order:`), ctx);
    assert.match(ctx, /npm publish acme-cli-1\.4\.4\.tgz --access public/, '{version} is 1.4.4, from the ask');
    assert.match(ctx, /Claude Code will ask the person before step \d+ \(it can't be undone\); wait for that\./, 'the publish is the gated step');
    assert.equal(block?.systemMessage, `trail: using skill ${name} (v1, worked Oct 27)`);
    assert.equal(name, 'release-npm');
  } finally {
    done(b);
  }
});

test('J04: the 3rd day a release checks out, Stop blocks once with the offer; "show me", then "yes", keeps it; the next session gets the run block', async () => {
  const b = box('j04');
  try {
    // Two earlier days, each with a publish that failed first (costly days).
    for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2']] as const) {
      const s = session(b);
      await startHook(s, at(day, 0));
      await release(s, day, v, { failedFirst: true });
      const said = `Published ${v}: npm shows it.`;
      reply(s, at(day, 40), said);
      assert.equal(one(await stopHook(s, at(day, 41), said)), null, `day ${day}: no offer yet`);
    }
    const s = session(b);
    await startHook(s, at(27, 0));
    await release(s, 27, '1.4.3');
    const said = 'Published 1.4.3: npm shows it.';
    reply(s, at(27, 40), said);
    const blocked = one(await stopHook(s, at(27, 41), said));
    assert.equal(Object.keys(blocked ?? {}).length, 2, JSON.stringify(blocked));
    assert.equal(blocked?.decision, 'block');
    const offer = stateOf(s).pendingOffer!;
    assert.ok(offer, 'the offer is kept');
    assert.ok(offer.skillSha, 'kept exactly as offerDue returns it');
    assert.equal(offer.shownAt, at(27, 41));
    const [l1, l2] = offer.lines;
    assert.equal(blocked?.reason,
      `[trail] From Trail, the tool this person installed to keep commands that worked as skills. Trail noticed this job worked out on 3 days; it offers once to keep it. `
      + `If the job is done, end your reply with these 2 lines, so the person can answer (Trail reads their answer to the last line, so keep it as it is):\n${l1}\n${l2}\n`
      + `If they answer yes, run: trail skills add ${offer.name} --run ${offer.runId} (Trail checks their yes in this session before it keeps anything), then tell them the line it prints. `
      + `If they say show me, run trail skills draft ${offer.runId} --print, paste what it prints, and ask "Keep it? (yes / no)". `
      + 'If they say no, Trail keeps nothing.');
    assert.match(l1!, /3rd day/);

    // The continued turn: the reply ends with the 2 lines; no second block.
    const cont = `${said}\n\n${l1}\n${l2}`;
    reply(s, at(27, 45), cont);
    assert.equal(one(await stopHook(s, at(27, 46), cont, true)), null, 'never a block twice in a turn');
    assert.ok(stateOf(s).pendingOffer, 'shown: still pending');
    assert.deepEqual(offersLog(b).map((l) => l.event), ['shown'], 'shown once, and not taken back');

    // "show me": the draft, then the agent's own question.
    const show = one(await promptHook(s, at(27, 60), 'show me'));
    assert.match(show?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`^\\[trail\\] From Trail, .* They typed: "show me"\\. .* Run trail skills draft ${offer.runId} --print`));
    await agentRuns(s, at(27, 62), `trail skills draft ${offer.runId} --print`, () => ({ out: `# ${offer.name}\n1. npm run build\n2. npm publish acme-cli-{version}.tgz --access public` }));
    const ask = `Here it is:\n\n# ${offer.name}\n1. npm run build\n2. npm publish acme-cli-{version}.tgz --access public\n\nKeep it? (yes / no)`;
    reply(s, at(27, 64), ask);
    assert.equal(one(await stopHook(s, at(27, 65), ask)), null, 'the question is the agent\'s; Stop says nothing');

    // "yes": the add, through the save gate.
    const yes = one(await promptHook(s, at(27, 80), 'yes'));
    const directive = yes?.hookSpecificOutput?.additionalContext ?? '';
    assert.equal(directive, `[trail] From Trail, the tool this person installed to keep commands that worked as skills. They typed: "yes". Trail offered to keep the last job as a skill, and this is their answer. To keep it as they said, run: trail skills add ${offer.name} --run ${offer.runId}. Trail checks their yes in this session before it keeps anything. Then tell them the line it prints.`);
    const command = `trail skills add ${offer.name} --run ${offer.runId}`;
    const add = await agentRuns(s, at(27, 82), command, cli(b, at(27, 82), command));
    assert.equal(add.decision, null);
    assert.equal(lastCli()?.exit, 0, lastCli()?.lines.join('\n'));
    assert.equal(lastCli()?.saved?.from, 'repeated', 'saved from the repeated-job offer');
    assert.deepEqual(skillsKept(b), [offer.name]);

    const s2 = session(b);
    await startHook(s2, at(28, 0));
    const block = one(await promptHook(s2, at(28, 5), 'publish 1.4.4'));
    assert.match(block?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`^\\[trail\\] Skill ${offer.name} fits`));
    assert.match(block?.hookSpecificOutput?.additionalContext ?? '', /npm publish acme-cli-1\.4\.4\.tgz --access public/);
  } finally {
    done(b);
  }
});
