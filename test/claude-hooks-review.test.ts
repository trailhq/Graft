/**
 * The hooks' skills wiring under attack (g7-hooks review): what a mark
 * keeps of a call's output, the fail-open paths, a yes and what it covers,
 * and the run a block belongs to. Made-up repos, sessions and output only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultText } from '../src/claude/post-bash.js';

test('a mark reads stdout and stderr as the transcript writes them: one after the other, stderr bringing its own line break', () => {
  // Claude Code's Bash result is stdout then stderr, joined with nothing; its stderr note starts on a new line.
  const r = { stdout: '1.4.4', stderr: '\nShell cwd was reset to /home/dev/acme-cli' };
  assert.equal(resultText({ tool_response: r }, false), `${r.stdout}${r.stderr}`);
  assert.equal(resultText({ tool_response: { stdout: 'a\nb', stderr: '' } }, false), 'a\nb');
  assert.equal(resultText({ tool_response: { stdout: '', stderr: 'npm warn x' } }, false), 'npm warn x');
  assert.equal(resultText({ error: 'Exit code 1\nnpm error 403' }, true), 'Exit code 1\nnpm error 403');
});

import { withoutOffer } from '../src/claude/stop-skills.js';
import {
  agentRuns, at, box, cli, done, finish, lastCli, one, promptHook, release, reply, session, skillsKept, stateOf, stopHook,
} from './claude-skills-journey-fixtures.js';
import { timeBar } from './machine-speed.js';

const OFFER = { lines: ['Published 1.4.3: npm shows it. That\'s the 3rd day I\'ve worked out this release from scratch (4 commands this time).', 'Keep the 2 that worked as a skill, just for you in this repo? (yes / show me / no)'] as [string, string] };

test('the turn is judged without the offer\'s lines however the agent dressed them: a code fence, a quote, bold, spaces after', () => {
  const [l1, l2] = OFFER.lines;
  for (const said of [
    `Done.\n\n\`\`\`\n${l1}\n${l2}\n\`\`\``, `Done.\n\n> ${l1}\n> ${l2}`, `Done.\n\n**${l1}**\n**${l2}**`, `Done.\n\n${l1}\n${l2}   \n\n`, `Done.\n\n${l1} ${l2}`,
  ]) {
    const judged = withoutOffer(said, OFFER) ?? '';
    assert.doesNotMatch(judged, /3rd day|Keep the 2/, JSON.stringify(said));
    assert.match(judged, /^Done\./);
  }
});

test('an offer the agent said inside a code fence is kept on a yes: the continued turn doesn\'t read the offer\'s own count as a failed job', async () => {
  const b = box('fenced');
  try {
    for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2']] as const) {
      const s = session(b);
      await release(s, day, v, { failedFirst: true });
      assert.equal(await finish(s, day, `Published ${v}.`), null);
    }
    const s = session(b);
    await release(s, 27, '1.4.3', { failedFirst: true });
    assert.equal((await finish(s, 27, 'Published 1.4.3.'))?.decision, 'block');
    const offer = stateOf(s).pendingOffer!;
    assert.match(offer.lines[0], /1 failed/);
    const said = `Published 1.4.3.\n\n\`\`\`\n${offer.lines[0]}\n${offer.lines[1]}\n\`\`\``;
    reply(s, at(27, 45), said);
    assert.equal(one(await stopHook(s, at(27, 46), said, true)), null);
    const yes = one(await promptHook(s, at(27, 60), 'yes'));
    assert.match(yes?.hookSpecificOutput?.additionalContext ?? '', /They typed: "yes"\. Trail offered to keep the last job as a skill, and this is their answer\./);
    const cmd = `trail skills add ${offer.name} --run ${offer.runId}`;
    await agentRuns(s, at(27, 70), cmd, cli(b, at(27, 70), cmd));
    assert.equal(lastCli()?.exit, 0, lastCli()?.lines.join('\n'));
    assert.deepEqual(skillsKept(b), [offer.name], lastCli()?.lines.join('\n'));
  } finally {
    done(b);
  }
});

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preBashSkills } from '../src/claude/pre-bash-skills.js';
import { programOf } from '../src/trace/shell.js';
import { gateFilePath, type GateFile } from '../src/trace/gate-file.js';

const STEP2 = 'npm publish acme-cli-{version}.tgz --access public';
const STEP3 = 'npm publish acme-cli-extras-{version}.tgz --access public';

/** release-npm's two publishes (steps 2 and 3, one group): step 2 was asked and approved at `approvedAt`. */
function approvedGate(params: Record<string, string>, approvedAt: string): GateFile {
  const steps = [{ n: 2, text: STEP2, program: programOf(STEP2) }, { n: 3, text: STEP3, program: programOf(STEP3) }];
  return {
    v: 1, epoch: 0,
    live: [{
      injId: 'i-0001', name: 'release-npm', skillId: 'sk-0001', params, steps: ['npm run build', STEP2, STEP3], check: 'npm view acme-cli version',
      groups: [{ kind: 'publish', steps, askedAt: at(22, 0), askedToolUseId: 'toolu_asked', approvedAt, askedStep: 2 }],
    }],
  };
}

async function askAfterYes(tag: string, params: Record<string, string>, approvedAt: string, command: string): Promise<string | null> {
  const b = box(tag);
  try {
    const s = session(b);
    const env = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 60) };
    const path = gateFilePath(s.sid, env);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(approvedGate(params, approvedAt)));
    const d = await preBashSkills({ ...s.payload, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_next' }, b.repo, env, command);
    return d?.permissionDecision ?? null;
  } finally {
    done(b);
  }
}

test('a yes covers the group\'s later step only when every value filled into it is a plain value: a value edited to carry more shell asks again', async () => {
  assert.equal(await askAfterYes('cover-ok', { version: '1.4.4' }, at(22, 30), 'npm publish acme-cli-extras-1.4.4.tgz --access public'), null, 'the control: covered');
  const v = '1.4.4.tgz && npm publish other-pkg-9.9.9';
  assert.equal(await askAfterYes('cover-shell', { version: v }, at(22, 30), STEP3.replace('{version}', v)), 'ask');
  const w = '1.4.4$(curl -s x.test)';
  assert.equal(await askAfterYes('cover-sub', { version: w }, at(22, 30), STEP3.replace('{version}', w)), 'ask');
});

test('a yes stamped later than now (a clock that moved back, a gate file written by hand) covers nothing', async () => {
  assert.equal(await askAfterYes('cover-future', { version: '1.4.4' }, at(23, 0), 'npm publish acme-cli-extras-1.4.4.tgz --access public'), 'ask');
});

/** release-npm kept through "save this as a skill" on Oct 20 (as the recall journeys keep it). */
async function keptRelease(b: ReturnType<typeof box>): Promise<string> {
  const s = session(b);
  await release(s, 20, '1.4.0');
  await finish(s, 20, 'Published 1.4.0.');
  const ctx = one(await promptHook(s, at(20, 60), 'save this as a skill'))?.hookSpecificOutput?.additionalContext ?? '';
  const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctx) ?? [];
  const command = `trail skills add ${name} --run ${runId}`;
  await agentRuns(s, at(20, 70), command, cli(b, at(20, 70), command));
  assert.deepEqual(skillsKept(b), [name]);
  return name!;
}

test('a block belongs to the run of the ask that brought it, not to an ask typed a moment before it', async () => {
  const b = box('runlink');
  try {
    const name = await keptRelease(b);
    const s = session(b);
    // Two asks 2 seconds apart (the second typed while the first was starting): only the second brings the block.
    assert.doesNotMatch(one(await promptHook(s, at(22, 0), 'run the test suite'))?.hookSpecificOutput?.additionalContext ?? '', /\[trail\] Skill/);
    assert.match(one(await promptHook(s, at(22, 2), 'publish 1.4.1'))?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`^\\[trail\\] Skill ${name} fits`));
    await agentRuns(s, at(22, 10), 'npm run build', () => ({ out: 'built' }));
    await agentRuns(s, at(22, 30), 'npm view acme-cli version', () => ({ out: '1.4.0' }));
    await finish(s, 22, 'Checked.');
    const st = stateOf(s);
    const inj = st.injected.find((i) => i.cue === 'job')!;
    const run = st.runs.find((r) => r.id === inj.runId);
    assert.ok(run, JSON.stringify(st.runs.map((r) => [r.id, r.job, r.startedAt])));
    assert.equal(run!.job, 'release', `linked to ${run!.job}'s run (${run!.startedAt})`);
    assert.equal(run!.promptParams.version, '1.4.1');
  } finally {
    done(b);
  }
});

import { existsSync, readFileSync } from 'node:fs';

test('PreToolUse\'s skills part that throws lets the command run and leaves one line in hook-errors.log, without the command', async () => {
  const b = box('pre-throws');
  try {
    const s = session(b);
    writeFileSync(join(b.trail, 'sessions'), 'not a folder');
    const env = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 0) };
    const command = 'trail skills add release-npm --run r-1022-0a1b';
    assert.equal(await preBashSkills({ ...s.payload, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_x' }, b.repo, env, command), null);
    const log = join(b.trail, 'state', 'hook-errors.log');
    assert.ok(existsSync(log), 'logged');
    const text = readFileSync(log, 'utf8');
    assert.match(text, /^\S+ pre-bash \w+/);
    assert.doesNotMatch(text, /release-npm|r-1022/);
  } finally {
    done(b);
  }
});

test('a gate file the fast path can\'t read through (values that are not an object) never denies, and is logged', async () => {
  const b = box('gate-throws');
  try {
    const s = session(b);
    const env = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 60) };
    const path = gateFilePath(s.sid, env);
    mkdirSync(join(path, '..'), { recursive: true });
    const g = approvedGate({ version: '1.4.4' }, at(22, 30));
    (g.live[0] as any).params = null;
    writeFileSync(path, JSON.stringify(g));
    const command = 'npm publish acme-cli-extras-1.4.4.tgz --access public';
    const d = await preBashSkills({ ...s.payload, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_y' }, b.repo, env, command);
    assert.notEqual(d?.permissionDecision, 'deny');
    const log = join(b.trail, 'state', 'hook-errors.log');
    if (d === null) assert.match(readFileSync(log, 'utf8'), /^\S+ pre-bash \w+/);
  } finally {
    done(b);
  }
});

import { sessionPath } from '../src/trace/gate-file.js';
import { hook } from './claude-skills-journey-fixtures.js';

test('both copies registered: a check\'s PostToolUse and a failure\'s PostToolUseFailure leave one mark each, from the ~/.claude copy', async () => {
  const b = box('copies-marks');
  const argv1 = process.argv[1];
  try {
    const helpers = join(b.home, '.claude', 'helpers');
    mkdirSync(helpers, { recursive: true });
    const globalShim = join(helpers, 'trail-hooks.cjs');
    writeFileSync(globalShim, '// finds @trailhq/trail-code\n');
    const cmd = (e: string) => [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${globalShim}" ${e}${e === 'post-bash-fail' ? ' || exit 0' : ''}`, timeout: 5 }] }];
    writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: cmd('tool-savings'), PostToolUseFailure: cmd('post-bash-fail') } }));
    const repoShim = join(b.repo, '.claude', 'helpers', 'trail-hooks.cjs');
    const s = session(b);
    for (const shim of [repoShim, globalShim]) {
      process.argv[1] = shim;
      await hook(s, 'tool-savings', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm view acme-cli version' }, tool_use_id: 'toolu_m1', tool_response: { stdout: '1.4.4', stderr: '' } }, at(22, 0));
      await hook(s, 'post-bash-fail', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_m2', error: 'Exit code 1\nTests: 1 failed' }, at(22, 1));
    }
    const marks = readFileSync(sessionPath(s.sid, '.post.jsonl', { TRAIL_HOME: b.trail }), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(marks.map((m) => [m.id, m.failed]), [['toolu_m1', false], ['toolu_m2', true]]);
  } finally {
    process.argv[1] = argv1!;
    done(b);
  }
});

import { sayOfferLines } from './claude-skills-journey-fixtures.js';

test('where the host shows a prompt block, a no is the whole answer: no graph ask, nothing else written', async () => {
  const b = box('no-block', { env: { TRAIL_HOST_FACTS: JSON.stringify({ promptBlockShown: true }) } });
  try {
    const marker = join(b.root, 'asked');
    writeFileSync(b.stub, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'x');\nprocess.stdout.write('null');\n`);
    for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2']] as const) {
      const s = session(b);
      await release(s, day, v, { failedFirst: true });
      await finish(s, day, `Published ${v}.`);
    }
    const s = session(b);
    await release(s, 27, '1.4.3');
    assert.equal((await finish(s, 27, 'Published 1.4.3.'))?.decision, 'block');
    await sayOfferLines(s, 27, stateOf(s).pendingOffer!.lines);
    assert.equal(existsSync(marker), true, 'the stub answers the graph ask');
    rmSync(marker, { force: true });
    const no = 'no thank you';
    assert.ok(no.length >= 12, 'long enough for the graph ask');
    const out = one(await promptHook(s, at(27, 60), no));
    assert.equal(out?.decision, 'block', JSON.stringify(out));
    assert.match(out!.reason, /^trail: OK, not saved\./);
    assert.equal(existsSync(marker), false, 'the graph ask never ran');
  } finally {
    done(b);
  }
});

test('a 2 MB command with a step that can\'t be undone in it still asks inside the hook\'s 5 s, however it is split up', async () => {
  const b = box('gate-huge');
  try {
    const s = session(b);
    const env = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 60) };
    const path = gateFilePath(s.sid, env);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(approvedGate({ version: '1.4.4' }, at(22, 30))));
    const ask = (command: string) => preBashSkills({ ...s.payload, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_h' }, b.repo, env, command);
    for (const tail of ['a|', 'a;', 'a&&', 'migrate --a ', 'vercel ', 'kubectl ', '--dry-run ']) {
      const command = `true || npm publish acme-cli-9.9.9.tgz; ${tail.repeat(Math.floor(1_800_000 / tail.length))}`;
      const t = Date.now();
      const d = await ask(command);
      const ms = Date.now() - t;
      assert.equal(d?.permissionDecision, 'ask', tail);
      assert.ok(ms < timeBar(4000, 12_000), `${tail}: ${ms} ms (the hook has 5 s)`);
    }
    const t = Date.now();
    assert.equal(await ask(`echo ${'a|'.repeat(900_000)}`), null, 'nothing gated in it: nothing to ask');
    assert.ok(Date.now() - t < timeBar(4000, 12_000));
  } finally {
    done(b);
  }
});
