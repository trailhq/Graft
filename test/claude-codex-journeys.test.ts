/**
 * Phase 2 c7: the Codex legs of J04 and J10, model-free, through the real hooks (`main(event)`) on Codex payloads
 * and a rollout that grows as Codex writes it, with TRAIL_TIER_CODEX=A in the test home (4.18: the learning half on
 * Codex before the flip). Recording a Codex prompt's keyed hash is the prompt hook's own (c8). Made-up repo, prompts and output only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, box, cli, done, lastCli, offersLog, one, skillsKept, stateOf, type Box } from './claude-skills-journey-fixtures.js';
import { cxPrompt, cxReply, cxRuns, cxSession, cxStart, cxStop, type CxSession } from './codex-journey-fixtures.js';
import { CODEX_COPY } from '../src/hosts/codex-trust.js';

const ctxOf = (out: Record<string, any> | null): string => out?.hookSpecificOutput?.additionalContext ?? '';
const codexBox = (tag: string) => box(tag, { env: { TRAIL_TIER_CODEX: 'A' } });

/** A release that worked on Codex: build, publish (a failed one first on a costly day), and npm shows the version. */
async function release(s: CxSession, day: number, version: string, opts: { failedFirst?: boolean; ask?: string } = {}): Promise<void> {
  await cxPrompt(s, at(day, 0), opts.ask ?? `publish ${version}`);
  await cxRuns(s, at(day, 10), 'npm run build', () => ({ out: 'built in 2.1s' }));
  if (opts.failedFirst) await cxRuns(s, at(day, 15), `npm publish acme-cli-${version}.tgz`, () => ({ out: 'npm error code E403\nnpm error 403 Forbidden', code: 1 }));
  await cxRuns(s, at(day, 20), `npm publish acme-cli-${version}.tgz --access public`, () => ({ out: `+ acme-cli@${version}` }));
  await cxRuns(s, at(day, 30), 'npm view acme-cli version', () => ({ out: version }));
}

/** The agent's reply and Stop with it (Codex hands the reply over as last_assistant_message). */
async function finish(s: CxSession, day: number, said: string, sec = 40, active = false): Promise<Record<string, any> | null> {
  cxReply(s, at(day, sec), said);
  return one(await cxStop(s, at(day, sec + 1), said, active));
}

/** `trail skills add` as the agent's shell runs it on Codex: through PreToolUse's save gate, then the CLI half. */
const add = (s: CxSession, b: Box, iso: string, command: string) =>
  cxRuns(s, iso, command, () => {
    const r = cli(b, iso, command, { CODEX_HOME: b.env.CODEX_HOME!, TRAIL_TIER_CODEX: 'A', CLAUDE_CODE_ENTRYPOINT: '' })();
    return { out: r.out, code: r.failed ? 1 : 0 };
  });

test('J04 Codex leg: the 3rd day a release checks out, Stop offers once; "show me", then "yes", keeps it through the save gate; the next session gets the block', async () => {
  const b = codexBox('cx-j04');
  try {
    for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2']] as const) {
      const s = cxSession(b);
      await cxStart(s, at(day, 0));
      await release(s, day, v, { failedFirst: true });
      assert.equal(await finish(s, day, `Published ${v}: npm shows it.`), null, `day ${day}: no offer yet`);
    }
    const s = cxSession(b);
    await cxStart(s, at(27, 0));
    await release(s, 27, '1.4.3');
    const said = 'Published 1.4.3: npm shows it.';
    const blocked = await finish(s, 27, said);
    assert.equal(blocked?.decision, 'block', JSON.stringify(blocked));
    const offer = stateOf(s).pendingOffer!;
    assert.ok(offer, 'the offer is kept');
    const [l1, l2] = offer.lines;
    assert.match(l1!, /3rd day/);
    assert.ok(String(blocked!.reason).includes(`If they answer yes, run: trail skills add ${offer.name} --run ${offer.runId}`));
    assert.ok(String(blocked!.reason).endsWith(CODEX_COPY.sandbox), 'P36: the sandbox may ask the person');
    assert.deepEqual(Object.keys(blocked!).sort(), ['decision', 'reason'], "only what Codex's Stop output takes");

    // The continued turn (stop_hook_active): the reply ends with the 2 lines; no second block.
    assert.equal(await finish(s, 27, `${said}\n\n${l1}\n${l2}`, 45, true), null, 'one block per Stop chain (R26)');
    assert.deepEqual(offersLog(b).map((l) => l.event), ['shown']);

    const show = one(await cxPrompt(s, at(27, 60), 'show me'));
    assert.match(ctxOf(show), new RegExp(`They typed: "show me"\\. .* Run trail skills draft ${offer.runId} --print`));
    await cxRuns(s, at(27, 62), `trail skills draft ${offer.runId} --print`, () => ({ out: `# ${offer.name}\n1. npm run build\n2. npm publish acme-cli-{version}.tgz --access public` }));
    const ask = `Here it is:\n\n# ${offer.name}\n1. npm run build\n2. npm publish acme-cli-{version}.tgz --access public\n\nKeep it? (yes / no)`;
    assert.equal(await finish(s, 27, ask, 64), null, "the question is the agent's; Stop says nothing");

    const yes = one(await cxPrompt(s, at(27, 80), 'yes'));
    const directive = ctxOf(yes);
    assert.match(directive, new RegExp(`They typed: "yes"\\. .*To keep it as they said, run: trail skills add ${offer.name} --run ${offer.runId}\\.`));
    assert.ok(directive.endsWith(CODEX_COPY.sandbox), directive);
    const command = `trail skills add ${offer.name} --run ${offer.runId}`;
    const saved = await add(s, b, at(27, 82), command);
    assert.equal(saved.decision, null, 'the save gate lets the add run (no allow sent on Codex)');
    const receipt = JSON.parse(readFileSync(join(b.trail, 'receipts', `${s.sid}.json`), 'utf8'));
    assert.equal(receipt.host, 'codex');
    assert.equal(receipt.tier, 'A');
    assert.equal(receipt.stepsVerified, receipt.stepsTotal);
    assert.equal(lastCli()?.exit, 0, lastCli()?.lines.join('\n'));
    assert.equal(lastCli()?.saved?.from, 'repeated');
    assert.deepEqual(skillsKept(b), [offer.name]);

    const s2 = cxSession(b);
    assert.match(ctxOf(one(await cxStart(s2, at(28, 0)))), new RegExp(`Trail skills here: ${offer.name}`));
    const block = ctxOf(one(await cxPrompt(s2, at(28, 5), 'publish 1.4.4')));
    assert.match(block, new RegExp(`^\\[trail\\] Skill ${offer.name} fits`), block);
    assert.match(block, /npm publish acme-cli-1\.4\.4\.tgz --access public/);
    assert.match(block, /This session can't ask the person, so don't run step \d+ \(it can't be undone\)/, 'P37: Codex never asks');
    assert.doesNotMatch(block, /Claude Code/);
  } finally {
    done(b);
  }
});

test('J10 Codex leg: a short ask gets the run block once an epoch; the gated step is denied and printed; the use is read from the rollout', async () => {
  const b = codexBox('cx-j10');
  try {
    // release-npm kept on Oct 20 through "save this as a skill".
    const s0 = cxSession(b);
    await release(s0, 20, '1.4.0');
    await finish(s0, 20, 'Published 1.4.0.');
    const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctxOf(one(await cxPrompt(s0, at(20, 60), 'save this as a skill')))) ?? [];
    assert.ok(name && runId, 'the asked save names the command');
    await add(s0, b, at(20, 70), `trail skills add ${name} --run ${runId}`);
    assert.deepEqual(skillsKept(b), [name]);

    const s = cxSession(b);
    assert.match(ctxOf(one(await cxStart(s, at(22, 0)))), new RegExp(`Trail skills here: ${name}`));
    const first = ctxOf(one(await cxPrompt(s, at(22, 5), 'publish it')));
    assert.match(first, new RegExp(`^\\[trail\\] Skill ${name} fits`), first);
    assert.ok(first.length <= 1200 + CODEX_COPY.sandbox.length);
    await cxRuns(s, at(22, 10), 'npm run build', () => ({ out: 'built' }));
    const pub = await cxRuns(s, at(22, 20), 'npm publish acme-cli-1.5.0.tgz --access public', () => ({ out: '+ acme-cli@1.5.0' }));
    assert.equal(pub.decision?.hookSpecificOutput?.permissionDecision, 'deny', 'P37: denied, never asked');
    assert.match(pub.decision?.hookSpecificOutput?.permissionDecisionReason ?? '', /ask the person to run this command in their own terminal: npm publish acme-cli-1\.5\.0\.tgz --access public$/);
    // The person ran it themselves; the agent checks.
    await cxRuns(s, at(22, 30), 'npm view acme-cli version', () => ({ out: '1.5.0' }));
    await finish(s, 22, `The publish is yours to run: npm publish acme-cli-1.5.0.tgz --access public\nUsed skill ${name}`);
    // The block's use is read from the rollout as on Claude Code's deny path: step 1 ran, step 2 was handed to the
    // person to run (c8, D137: it counts as ran, its denied call no failure), the check ran.
    const credit = stateOf(s).credit.find((c) => c.skillId && c.runId);
    assert.ok(credit, 'the block is being credited');
    assert.deepEqual([credit!.stepsRan, credit!.failedStep, credit!.calls], [[1, 2], null, 3]);
    const same = ctxOf(one(await cxPrompt(s, at(22, 120), 'publish it')));
    assert.equal(same, `[trail] Same job as before: start from the steps of skill ${name} above.`);
  } finally {
    done(b);
  }
});

test('tier B (no switch): the same three Codex days fold but offer nothing', async () => {
  const b = box('cx-tierb');
  try {
    for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2'], [27, '1.4.3']] as const) {
      const s = cxSession(b);
      await cxStart(s, at(day, 0));
      await release(s, day, v, { failedFirst: day !== 27 });
      assert.equal(await finish(s, day, `Published ${v}: npm shows it.`), null, `day ${day}`);
      assert.ok(stateOf(s).runs.length >= 1, 'the fold runs on Codex (recall half)');
    }
    assert.deepEqual(offersLog(b), []);
  } finally {
    done(b);
  }
});
