/**
 * Phase 2 through the real hooks (c8): every hook goes through `main(event)`
 * with Claude Code's payloads, the CLI steps are the CLI halves the agent's
 * shell runs. Moment 5 (update), the retire proposal and the weekly value
 * line, with the telemetry each journey queues, in order. Made-up acme/shop
 * and acme-cli only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRuns, at, box, done, one, promptHook, reply, session, startHook, stateOf, stopHook,
} from './claude-skills-journey-fixtures.js';
import { type Box, type Session, blockOf, cliUpd, ctxOf, envOf, kept, offerLinesIn, publishOf, release5, skillsEvents, TELEMETRY_ENV, updateCommandIn } from './claude-journeys-2-fixtures.js';
import { listAllPersonal } from '../src/skills/store.js';
import { getSkillState, updateSkillState } from '../src/skills/state.js';
import { skillHash } from '../src/skills/skillmd.js';
import { listVersions } from '../src/skills/versions.js';
import { readLedger } from '../src/skills/ledger.js';

test('moment 5 (update): a checked release from the block that needed another publish gets the update offer at Stop; yes, then trail skills update writes v2', async () => {
  const b = box('c8-m5', { env: TELEMETRY_ENV });
  try {
    const name = await kept(b, 20, '1.4.0');
    const s = session(b);
    await release5(s, 22, '1.4.1', { publish: [{ cmd: publishOf('1.4.1'), fail: true }, { cmd: 'npm publish ./dist/acme-cli-1.4.1.tgz --access public' }] });
    assert.equal(stateOf(s).injected[0]?.name, name, 'the block came in for the ask');
    reply(s, at(22, 40), 'Published 1.4.1: npm shows it.');
    const block = blockOf(one(await stopHook(s, at(22, 41), 'Published 1.4.1: npm shows it.')));
    assert.match(block, /Change step 5 of release-npm to the command that worked\? 1 line changes\. \(yes \/ show me \/ no\)/, block);
    const lines = offerLinesIn(block);
    reply(s, at(22, 45), `Done.\n\n${lines[0]}\n${lines[1]}`);
    assert.equal(one(await stopHook(s, at(22, 46), `Done.\n\n${lines[0]}\n${lines[1]}`, true)), null, 'one block per Stop chain');
    const yes = ctxOf(one(await promptHook(s, at(22, 60), 'yes')));
    const command = updateCommandIn(yes);
    const out = { lines: [] as string[], code: -1 };
    const r = await agentRuns(s, at(22, 70), command, cliUpd(b, at(22, 70), command, out));
    assert.equal(r.decision, null, JSON.stringify(r.decision));
    assert.equal(out.code, 0, out.lines.join('\n'));
    assert.match(out.lines[0]!, /^✓ changed release-npm to v2 · step 5 is now 'npm publish \.\/dist\/acme-cli-\{version\}\.tgz --access public'$/);
    const env = envOf(b, at(22, 80));
    const ref = listAllPersonal(env)[0]!;
    assert.deepEqual(listVersions(ref), [1], 'v1 kept');
    assert.match(readFileSync(ref.file, 'utf8'), /npm publish \.\/dist\/acme-cli-\{version\}\.tgz --access public/);
    assert.equal(getSkillState(ref.id, env)!.status, 'candidate');
    assert.ok(readLedger(ref.id, env).some((l) => l.event === 'changed' && l.op === 'update' && l.from === 1 && l.to === 2));
    // Telemetry in order: the save, its use, the offer, the yes.
    assert.deepEqual(skillsEvents(b).filter((e) => !e.startsWith('skill_saved')), ['skill_used:checked', 'skill_offered:update', 'skill_answer:yes']);
  } finally {
    done(b);
  }
});

/* ---- J15: a needs-fix skill, a release that went another way, and the drift offer at Stop ---- */

/** release-npm kept on Oct 20, then needs-fix (J14a's two corrections stand in as the mark); `edit`: hand-edited first (box D). */
async function needsFixSkill(b: Box, edit = false): Promise<{ ref: ReturnType<typeof listAllPersonal>[number]; mine: string | null }> {
  await kept(b, 20, '1.4.0');
  const env = envOf(b, at(21, 0));
  const ref = listAllPersonal(env)[0]!;
  const mine = edit ? `${readFileSync(ref.file, 'utf8')}\nMy own line: the registry mirror is slow on Mondays.\n` : null;
  if (mine) writeFileSync(ref.file, mine);
  updateSkillState(ref.id, (st) => (st ? { ...st, status: 'needs-fix', prevStatus: 'candidate', statusWhy: 'step 5 failed on Oct 20 and Oct 21', ...(mine ? { fixHash: skillHash(mine) } : {}) } : st), env);
  return { ref, mine };
}

/** Oct 27: the release goes another way (no lint, the tarball from dist/), npm shows it; Stop's block, then the agent says the 2 lines. */
async function driftDay(b: Box): Promise<{ s: Session; block: string; lines: [string, string] }> {
  const s = session(b);
  await release5(s, 27, '1.4.4', { skip: ['npm run lint'], publish: [{ cmd: 'npm publish ./dist/acme-cli-1.4.4.tgz --access public' }] });
  assert.equal(stateOf(s).injected.length, 0, 'a needs-fix skill is never brought in');
  reply(s, at(27, 40), 'Published 1.4.4: npm shows it.');
  const block = blockOf(one(await stopHook(s, at(27, 41), 'Published 1.4.4: npm shows it.')));
  const lines = offerLinesIn(block);
  reply(s, at(27, 45), `Done.\n\n${lines[0]}\n${lines[1]}`);
  assert.equal(one(await stopHook(s, at(27, 46), `Done.\n\n${lines[0]}\n${lines[1]}`, true)), null);
  return { s, block, lines };
}

test('J15 A: replace writes the steps that just worked as v2, a candidate again, v1 kept', async () => {
  const b = box('c8-j15a', { env: TELEMETRY_ENV });
  try {
    const { ref } = await needsFixSkill(b);
    const { s, lines } = await driftDay(b);
    assert.match(lines[0], /release-npm needs a fix, and this release went another way: it skipped 'npm run lint' \(step 2\) and 'npm publish acme-cli-\{version\}\.tgz --access public' \(step 5\) and ran 'npm publish \.\/dist\/acme-cli-1\.4\.4\.tgz --access public'\./);
    assert.equal(lines[1], 'Replace release-npm with the 4 steps that just worked, retire it, or leave it? (replace / retire / leave it)');
    const yes = ctxOf(one(await promptHook(s, at(27, 60), 'replace')));
    const command = updateCommandIn(yes);
    const out = { lines: [] as string[], code: -1 };
    await agentRuns(s, at(27, 70), command, cliUpd(b, at(27, 70), command, out));
    assert.equal(out.code, 0, out.lines.join('\n'));
    assert.match(out.lines[0]!, /^✓ changed release-npm to v2 · the 4 steps that just worked replace the old ones$/);
    const env = envOf(b, at(27, 80));
    assert.deepEqual(listVersions(ref), [1]);
    const text = readFileSync(ref.file, 'utf8');
    assert.match(text, /npm publish \.\/dist\/acme-cli-\{version\}\.tgz --access public/);
    assert.doesNotMatch(text, /npm run lint/);
    const st = getSkillState(ref.id, env)!;
    assert.equal(st.status, 'candidate', 'failures cleared');
    assert.equal(st.fixHash, undefined);
    assert.deepEqual(skillsEvents(b).filter((e) => !e.startsWith('skill_saved')), ['skill_offered:drift', 'skill_answer:yes']);
  } finally {
    done(b);
  }
});

test('J15 B: retire moves the folder to .retired on the person\'s typed word, and the agent is told how to bring it back', async () => {
  const b = box('c8-j15b', { env: TELEMETRY_ENV });
  try {
    const { ref } = await needsFixSkill(b);
    const { s } = await driftDay(b);
    const said = ctxOf(one(await promptHook(s, at(27, 60), 'retire')));
    assert.match(said, /Trail retired release-npm\. Tell them in one line, with how to bring it back: trail skills restore release-npm\./, said);
    assert.equal(existsSync(ref.dir), false);
    assert.ok(existsSync(join(b.trail, 'skills', '.retired', 'release-npm-2026-10-27', 'SKILL.md')), 'moved, nothing deleted');
    assert.deepEqual(skillsEvents(b).filter((e) => !e.startsWith('skill_saved')), ['skill_offered:drift', 'skill_answer:retire', 'skill_changed:retire']);
  } finally {
    done(b);
  }
});

test('J15 B: "retire" after a reply that didn\'t end with the offer\'s line 2 moves nothing (D72, R1)', async () => {
  const b = box('c8-j15b2');
  try {
    const { ref } = await needsFixSkill(b);
    const s = session(b);
    await release5(s, 27, '1.4.4', { skip: ['npm run lint'], publish: [{ cmd: 'npm publish ./dist/acme-cli-1.4.4.tgz --access public' }] });
    reply(s, at(27, 40), 'Published 1.4.4: npm shows it.');
    assert.ok(blockOf(one(await stopHook(s, at(27, 41), 'Published 1.4.4: npm shows it.'))));
    reply(s, at(27, 45), 'Done. Anything else?');
    await stopHook(s, at(27, 46), 'Done. Anything else?', true);
    await promptHook(s, at(27, 60), 'retire');
    assert.ok(existsSync(ref.dir), 'the skill stays');
  } finally {
    done(b);
  }
});

test('J15 C: leave it keeps the skill needing a fix, and the drift offer never comes again for this version', async () => {
  const b = box('c8-j15c', { env: TELEMETRY_ENV });
  try {
    const { ref } = await needsFixSkill(b);
    const { s } = await driftDay(b);
    assert.match(ctxOf(one(await promptHook(s, at(27, 60), 'leave it'))), /OK, nothing changed\./);
    assert.equal(getSkillState(ref.id, envOf(b, at(27, 61)))!.status, 'needs-fix');
    const s2 = session(b);
    await release5(s2, 29, '1.4.5', { skip: ['npm run lint'], publish: [{ cmd: 'npm publish ./dist/acme-cli-1.4.5.tgz --access public' }] });
    reply(s2, at(29, 40), 'Published 1.4.5: npm shows it.');
    assert.equal(blockOf(one(await stopHook(s2, at(29, 41), 'Published 1.4.5: npm shows it.'))), '', 'never asked again for v1');
    assert.deepEqual(skillsEvents(b).filter((e) => !e.startsWith('skill_saved')), ['skill_offered:drift', 'skill_answer:no']);
  } finally {
    done(b);
  }
});

test('J15 D: a hand-edited skill gets only a proposal beside it, the diff and the cp line; the file and its status stay', async () => {
  const b = box('c8-j15d', { env: TELEMETRY_ENV });
  try {
    const { ref, mine } = await needsFixSkill(b, true);
    const { s, lines } = await driftDay(b);
    assert.equal(lines[1], 'Write the 4 steps that just worked beside your edited release-npm, retire it, or leave it? (replace / retire / leave it)');
    const command = updateCommandIn(ctxOf(one(await promptHook(s, at(27, 60), 'replace'))));
    const out = { lines: [] as string[], code: -1, proposal: undefined as boolean | undefined };
    await agentRuns(s, at(27, 70), command, cliUpd(b, at(27, 70), command, out));
    assert.equal(out.proposal, true, out.lines.join('\n'));
    assert.match(out.lines.at(-1)!, /^Tell the person: you changed release-npm by hand, so Trail left it alone and wrote the change beside it\. To use it, they run this in their own terminal: cp .*\/skills\/release-npm\/\.versions\/proposed-v2\/SKILL\.md .*\/skills\/release-npm\/SKILL\.md \(their edited file is kept in \.versions\/hand-2026-10-27\)$/);
    assert.equal(readFileSync(ref.file, 'utf8'), mine);
    assert.deepEqual(listVersions(ref), []);
    assert.equal(getSkillState(ref.id, envOf(b, at(27, 72)))!.status, 'needs-fix');
    // H14's model-free twin: the person runs the cp in their own terminal; the next session takes the file as Trail's own.
    const proposed = readFileSync(join(ref.dir, '.versions', 'proposed-v2', 'SKILL.md'), 'utf8');
    writeFileSync(ref.file, proposed);
    await startHook(session(b), at(28, 0));
    const st = getSkillState(ref.id, envOf(b, at(28, 1)))!;
    assert.equal(st.hash, skillHash(proposed), 'adopted');
    assert.equal(st.status, 'candidate');
    assert.deepEqual(skillsEvents(b).filter((e) => !e.startsWith('skill_saved')), ['skill_offered:drift', 'skill_answer:yes', 'skill_changed:adopted']);
  } finally {
    done(b);
  }
});

/* ---- the weekly value line (4.14, D134) ---- */

test('the value line: two uses from the block and a known error with its fix, then the next startup says the week once', async () => {
  const b = box('c8-value', { env: TELEMETRY_ENV });
  try {
    const name = await kept(b, 20, '1.4.0');
    for (const [day, v] of [[21, '1.4.1'], [22, '1.4.2']] as const) {
      const s = session(b);
      await release5(s, day, v);
      assert.equal(stateOf(s).injected[0]?.name, name);
      if (day === 22) {
        // A wall Trail knows: the fix reached the model on PostToolUseFailure (Claude Code reads it), so it counts.
        const fix = await agentRuns(s, at(day, 35), 'timeout 60 npm test', () => ({ out: 'Exit code 127\nzsh: command not found: timeout', failed: true }));
        assert.equal(fix.decision, null);
      }
      reply(s, at(day, 40), `Published ${v}: npm shows it.\nUsed skill ${name}`);
      await stopHook(s, at(day, 41), `Published ${v}: npm shows it.\nUsed skill ${name}`);
      await promptHook(s, at(day, 60), 'thanks');
    }
    const value = JSON.parse(readFileSync(join(b.trail, 'state', 'value.json'), 'utf8'));
    assert.deepEqual(value.repos['github.com/acme/shop'].days, { '2026-10-22': { g: 0, w: 1 } }, 'counts only');
    const s = session(b);
    const start = ctxOf(one(await startHook(s, at(23, 0))));
    assert.ok(start.includes('Its weekly count for this repo, for the person: "Last week in this repo, on this machine: release-npm ran 2 times, 1 failed command in all; 1 known error came with its fix."'), start);
    assert.ok(start.includes('Tell them once at the start of your first reply'));
    const again = ctxOf(one(await startHook(session(b), at(23, 60))));
    assert.ok(!again.includes('Its weekly count'), 'once in 7 days');
    assert.ok(!ctxOf(one(await startHook(s, at(23, 90), 'compact'))).includes('Its weekly count'));
    assert.deepEqual(skillsEvents(b).filter((e) => e.startsWith('skill_value')), ['skill_value:context']);
  } finally {
    done(b);
  }
});

test('D137 Claude Code in dontAsk: the publish is handed to the person; their next "publish" continues the run and the use counts step 5 as handed', async () => {
  const b = box('c8-handed-claude', { env: TELEMETRY_ENV });
  try {
    const name = await kept(b, 20, '1.4.0');
    const s = session(b, { mode: 'dontAsk' });
    await startHook(s, at(22, 0));
    assert.match(ctxOf(one(await promptHook(s, at(22, 1), 'publish 1.5.0'))), new RegExp(`Skill ${name} fits`));
    let t = 5;
    for (const p of ['npm ci', 'npm run lint', 'npm test', 'npm run build']) await agentRuns(s, at(22, (t += 2)), p, () => ({ out: 'ok' }));
    const pub = await agentRuns(s, at(22, 20), publishOf('1.5.0'), () => ({ out: 'not run' }));
    assert.equal(pub.decision?.hookSpecificOutput?.permissionDecision, 'deny');
    reply(s, at(22, 25), 'Trail stopped the publish: please run it in your terminal.');
    await stopHook(s, at(22, 26), 'Trail stopped the publish: please run it in your terminal.');
    assert.match(ctxOf(one(await promptHook(s, at(22, 600), 'publish 1.5.0'))), /Same job as before/);
    await agentRuns(s, at(22, 610), 'npm view acme-cli version', () => ({ out: '1.5.0' }));
    reply(s, at(22, 620), 'npm shows 1.5.0.');
    await stopHook(s, at(22, 621), 'npm shows 1.5.0.');
    const ref = listAllPersonal(envOf(b, at(22, 621))).find((r) => r.name === name)!;
    const u = readLedger(ref.id, envOf(b, at(22, 621))).filter((l) => l.event === 'use');
    assert.equal(u.length, 1, 'the first use reached the ledger');
    assert.deepEqual([u[0]!.stepsRan, (u[0] as any).handed, u[0]!.failedStep, u[0]!.check], [[1, 2, 3, 4, 5], [5], null, 'passed']);
    assert.ok(skillsEvents(b).includes('skill_used:checked'), skillsEvents(b).join(' '));
  } finally {
    done(b);
  }
});
