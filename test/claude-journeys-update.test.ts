/**
 * J15 box D through the real hooks (phase 2 design 4.6, the c2 row): a
 * skill the person edited by hand goes needs-fix (D65: `fixHash` is the
 * edited file), a release goes another way, and drift's yes writes only a
 * proposal beside the person's file. SessionStart, UserPromptSubmit,
 * PreToolUse, PostToolUse and Stop run through `main(event)`; the CLI step
 * is `cliUpdate`, as `trail skills update` runs it. c3's drift offer at Stop
 * is stood in for (its moment 6 is built beside this one); J14a's two
 * corrections are stood in for by the needs-fix mark. Synthetic data only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRuns, at, box, cli, done, lastCli, one, promptHook, release, reply, sayOfferLines, session, startHook, stateOf, stopHook, SHOP, type Box, type Session,
} from './claude-skills-journey-fixtures.js';
import { sessionPath } from '../src/trace/gate-file.js';
import { skillHash } from '../src/skills/skillmd.js';
import { getSkillState, updateSkillState } from '../src/skills/state.js';
import { listAllPersonal } from '../src/skills/store.js';
import { driftOfferKey, newOfferId, recordShown } from '../src/skills/offers.js';
import { cliUpdate, replan } from '../src/skills/update-gate.js';
import { listVersions } from '../src/skills/versions.js';
import type { PendingOffer } from '../src/trace/types.js';

const envOf = (b: Box, nowIso: string) => ({ PATH: process.env.PATH, HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: nowIso });

/** c3's moment 6 at Stop, stood in for: the drift offer for the run Stop just closed, pinned by the replan. */
function driftOffer(s: Session, shownAt: string): PendingOffer {
  const env = envOf(s.b, shownAt);
  const file = sessionPath(s.sid, '.json', { TRAIL_HOME: s.b.trail });
  const all = JSON.parse(readFileSync(file, 'utf8'));
  const run = all.skills.runs.at(-1);
  assert.equal(run?.sheet, 'checked', 'Stop wrote the run\'s checked sheet');
  const skillId = listAllPersonal(env)[0]!.id;
  const plan = replan(skillId, run.id, 'replace', env, { st: all.skills });
  assert.ok(plan, 'the replace plans from the run sheet');
  const version = Number(plan!.base.meta.version);
  const offer: PendingOffer = {
    offerId: newOfferId(), moment: 'drift', runId: run.id, name: 'release-npm', key: driftOfferKey(skillId, version),
    lines: ['Published 1.4.4: npm shows it. release-npm needs a fix, and this release went another way.',
      `Replace release-npm with the ${plan!.next.steps.length} steps that just worked, retire it, or leave it? (replace / retire / leave it)`],
    channel: 'stop', shownAt, showMe: false, yes: null, typedAfter: [], repo: SHOP,
    fold: { op: 'replace', skillId, baseHash: plan!.baseHash, proposalSha: plan!.proposalSha, handEdited: plan!.handEdited, version },
    retire: { skillId, name: 'release-npm' },
  };
  all.skills.pendingOffer = offer;
  all.skills.offerUsed = true;
  all.skills.offerUsedBy = 'offer';
  writeFileSync(file, JSON.stringify(all));
  recordShown(offer, SHOP, env, new Date(shownAt));
  return offer;
}

test('J15 D: a hand-edited skill that needs a fix gets only a proposal beside it, the diff and the cp line; the file and its status stay', async () => {
  const b = box('j15d');
  try {
    // Oct 25: a release that worked, kept as release-npm (v1) because the person asked.
    const s1 = session(b);
    await startHook(s1, at(25, 0));
    await release(s1, 25, '1.4.3');
    reply(s1, at(25, 40), 'Published 1.4.3: npm shows it.');
    await stopHook(s1, at(25, 41), 'Published 1.4.3: npm shows it.');
    const asked = one(await promptHook(s1, at(25, 60), 'save this as a skill'));
    const [, name, runId] = /run: trail skills add ([a-z0-9-]+) --run (r-\d{4}-[0-9a-f]+)\./.exec(asked?.hookSpecificOutput?.additionalContext ?? '')!;
    const add = `trail skills add ${name} --run ${runId}`;
    await agentRuns(s1, at(25, 70), add, cli(b, at(25, 70), add));
    assert.equal(lastCli()?.exit, 0, lastCli()?.lines.join('\n'));
    assert.equal(name, 'release-npm');

    // The person edits it by hand, then it goes needs-fix (J14a's two corrections) with fixHash the edited file.
    const ref = listAllPersonal(envOf(b, at(26, 0)))[0]!;
    const mine = `${readFileSync(ref.file, 'utf8')}\nMy own line: the registry mirror is slow on Mondays.\n`;
    writeFileSync(ref.file, mine);
    updateSkillState(ref.id, (st) => (st ? { ...st, status: 'needs-fix', prevStatus: 'active', statusWhy: 'step 4 failed on Oct 25 and Oct 26', fixHash: skillHash(mine) } : st), envOf(b, at(26, 0)));

    // Oct 27: the release goes another way (the tarball from dist/), and npm shows it.
    const s2 = session(b);
    await startHook(s2, at(27, 0));
    await promptHook(s2, at(27, 5), 'publish 1.4.4');
    await agentRuns(s2, at(27, 10), 'npm run build', () => ({ out: 'built in 2.1s' }));
    await agentRuns(s2, at(27, 20), 'npm publish ./dist/acme-cli-1.4.4.tgz --access public', () => ({ out: '+ acme-cli@1.4.4' }));
    await agentRuns(s2, at(27, 30), 'npm view acme-cli version', () => ({ out: '1.4.4' }));
    reply(s2, at(27, 40), 'Published 1.4.4: npm shows it.');
    await stopHook(s2, at(27, 41), 'Published 1.4.4: npm shows it.');
    const offer = driftOffer(s2, at(27, 41));
    assert.equal(offer.fold!.handEdited, true, 'its hash is not state.hash');
    assert.equal(await sayOfferLines(s2, 27, offer.lines!), null);
    await promptHook(s2, at(27, 60), 'yes');
    assert.ok(stateOf(s2).pendingOffer?.yes, 'the prompt hook kept the yes');

    // The agent runs the update: PreToolUse lets it through with a receipt, the CLI re-decides and writes beside the file.
    const cmd = `trail skills update release-npm --offer ${offer.offerId}`;
    let lines: string[] = [];
    let proposal: boolean | undefined;
    const r = await agentRuns(s2, at(27, 70), cmd, () => {
      const c = cliUpdate('release-npm', offer.offerId, envOf(b, at(27, 71)), new Date(at(27, 71)));
      lines = c.lines;
      proposal = c.proposal;
      return { out: c.lines.join('\n'), failed: c.code !== 0 };
    });
    assert.equal(r.decision, null, JSON.stringify(r.decision));
    assert.equal(proposal, true, lines.join('\n'));
    assert.match(lines[0]!, /^--- release-npm\/SKILL\.md \(yours\)$/);
    // Trail's home is outside HOME here, so the cp line names it in full.
    // In forward slashes, which every Windows shell takes.
    const fwd = b.trail.replace(/\\/g, '/');
    assert.equal(lines.at(-1), `Tell the person: you changed release-npm by hand, so Trail left it alone and wrote the change beside it. To use it, they run this in their own terminal: cp ${fwd}/skills/release-npm/.versions/proposed-v2/SKILL.md ${fwd}/skills/release-npm/SKILL.md (their edited file is kept in .versions/hand-2026-10-27)`);
    assert.equal(readFileSync(ref.file, 'utf8'), mine, 'the person\'s file is never written');
    assert.ok(existsSync(join(b.trail, 'skills', 'release-npm', '.versions', 'proposed-v2', 'SKILL.md')));
    assert.deepEqual(listVersions(ref), [], 'no version written');
    assert.equal(getSkillState(ref.id, envOf(b, at(27, 72)))!.status, 'needs-fix', 'it stays needs-fix until the person copies it');
    const receipt = JSON.parse(readFileSync(join(b.trail, 'receipts', `${s2.sid}.update.json`), 'utf8'));
    assert.notEqual(receipt.usedAt, null, 'the receipt is used once');

    // The same command again is refused: the offer and its receipt are spent.
    const again = await agentRuns(s2, at(27, 80), cmd, () => ({ out: 'not run' }));
    assert.equal(again.decision?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    done(b);
  }
});
