/**
 * PreToolUse's sure-fail guardrail through the real hook (design 3.3 step 1,
 * 4.11, J16): the prefilter lets a `timeout N` command reach the skills
 * part, the kept no-timeout guardrail denies it for the main agent and for a
 * subagent when this machine has no `timeout`, the deny is marked for Stop's
 * count, and nothing else is denied. Skills off: no deny. Made-up repo,
 * session ids and commands only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { skillsPrefilter } from '../src/claude/pre-bash.js';
import { SURE_FAIL_REASON } from '../src/trace/guard-fast.js';
import { sessionPath } from '../src/trace/gate-file.js';
import { writeEveryRepo } from '../src/notes/every-repo.js';
import { guardrailLearning } from '../src/notes/guardrails.js';
import { at, box, done, hook, one, pathWithoutTimeout, preBashHook, session, timeoutSeen, type Box, type Session } from './claude-skills-journey-fixtures.js';

/** A machine where Trail still finds a `timeout` (a system folder of 4.11, or Windows' System32) can't show a deny: those tests say so and skip. */
const SYSTEM_TIMEOUT = timeoutSeen();

/** The person kept the no-timeout guardrail at init (J01's end). */
function keepGuardrail(b: Box): void {
  writeEveryRepo(guardrailLearning('timeout-missing', 'every repo', 'on 6 days', new Date(2026, 9, 1)), 'no-timeout.md', { TRAIL_HOME: b.trail });
}
const decision = (out: string) => one(out)?.hookSpecificOutput ?? null;
const deniedLines = (s: Session) => {
  try {
    return readFileSync(sessionPath(s.sid, '.denied.jsonl', { TRAIL_HOME: s.b.trail }), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

test('the prefilter lets a timeout command with a duration reach the skills part, and nothing else new', () => {
  const env = { TRAIL_HOME: '/tmp/x/no-trail-home' };
  const input = { session_id: 'none' };
  for (const cmd of ['timeout 60 npm test', 'timeout -s KILL 5m make check', 'timeout --signal=TERM 1.5 make', 'cd web && timeout 30 npm test', 'env CI=1 timeout 5 go test ./...', 'tim"eout" 9 x']) {
    assert.equal(skillsPrefilter(input, cmd, env), true, cmd);
  }
  for (const cmd of ['ls', 'npm test', 'gtimeout 60 npm test', 'echo timeout', 'grep -rn timeout src', 'git log --grep timeout']) {
    assert.equal(skillsPrefilter(input, cmd, env), false, cmd);
  }
});

test('J16: the kept guardrail denies timeout N for the main agent and a subagent, marks each deny, and lets the same command without timeout run', { skip: SYSTEM_TIMEOUT }, async () => {
  const b = box('guard-j16', { env: { PATH: pathWithoutTimeout() } });
  try {
    keepGuardrail(b);
    const s = session(b);
    const main = decision(await preBashHook(s, at(17, 0), 'timeout 60 npm test', 'toolu_g1'));
    assert.equal(main?.permissionDecision, 'deny');
    assert.equal(main?.permissionDecisionReason, SURE_FAIL_REASON);
    const sub = decision(await preBashHook(s, at(17, 5), 'timeout 60 npm test', 'toolu_g2', { agent_id: 'agent-7', agent_type: 'general-purpose' }));
    assert.equal(sub?.permissionDecision, 'deny', 'the recall half reaches subagents (0 rule 2)');
    assert.equal(deniedLines(s).length, 2, 'one mark per deny, for Stop to count');
    for (const l of deniedLines(s)) assert.doesNotMatch(l, /npm test/, 'a sha, never the command');
    assert.equal(await preBashHook(s, at(17, 10), 'npm test', 'toolu_g3'), '', 'the same command without timeout');
    assert.equal(await preBashHook(s, at(17, 11), 'gtimeout 60 npm test', 'toolu_g4'), '');
  } finally {
    done(b);
  }
});

test('J16: with a timeout on the hook\'s PATH there is no deny; with no guardrail kept, or skills off, neither', { skip: SYSTEM_TIMEOUT }, async () => {
  const b = box('guard-path');
  try {
    keepGuardrail(b);
    const s = session(b);
    const bin = join(b.root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'timeout'), 0o755);
    assert.equal(await preBashHook(s, at(17, 0), 'timeout 60 npm test', 'toolu_p1', {}, { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }), '');
    assert.deepEqual(deniedLines(s), []);
  } finally {
    done(b);
  }
  const none = box('guard-none');
  try {
    const s = session(none);
    assert.equal(await preBashHook(s, at(17, 0), 'timeout 60 npm test', 'toolu_n1'), '', 'no guardrail kept');
  } finally {
    done(none);
  }
  const off = box('guard-off', { settings: { skills: 'off' } });
  try {
    keepGuardrail(off);
    const s = session(off);
    assert.equal(await preBashHook(s, at(17, 0), 'timeout 60 npm test', 'toolu_o1'), '', 'skills off: the guardrail loads as text only (0 rule 1)');
    assert.deepEqual(deniedLines(s), []);
  } finally {
    done(off);
  }
});

test('both copies registered: only the copy that answers denies and marks the deny', { skip: SYSTEM_TIMEOUT }, async () => {
  const b = box('guard-copies', { env: { PATH: pathWithoutTimeout() } });
  const argv1 = process.argv[1];
  try {
    keepGuardrail(b);
    const helpers = join(b.home, '.claude', 'helpers');
    mkdirSync(helpers, { recursive: true });
    const globalShim = join(helpers, 'trail-hooks.cjs');
    writeFileSync(globalShim, '// finds @trailhq/trail-code\n');
    writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${globalShim}" pre-bash || exit 0`, timeout: 5 }] }] } }));
    const s = session(b);
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'timeout 60 npm test' }, tool_use_id: 'toolu_c1' };
    process.argv[1] = join(b.repo, '.claude', 'helpers', 'trail-hooks.cjs');
    assert.equal(await hook(s, 'pre-bash', payload, at(17, 0)), '');
    assert.deepEqual(deniedLines(s), [], 'the repo copy wrote nothing');
    process.argv[1] = globalShim;
    assert.equal(decision(await hook(s, 'pre-bash', payload, at(17, 0)))?.permissionDecision, 'deny');
    assert.equal(deniedLines(s).length, 1);
  } finally {
    process.argv[1] = argv1!;
    done(b);
  }
});

test('a guardrail check that throws allows the command (0 rule 9)', { skip: SYSTEM_TIMEOUT }, async () => {
  const b = box('guard-bad');
  try {
    mkdirSync(join(b.trail, 'learnings', 'no-timeout.md'), { recursive: true });
    const s = session(b);
    assert.equal(await preBashHook(s, at(17, 0), 'timeout 60 npm test', 'toolu_b1'), '');
    assert.equal(existsSync(sessionPath(s.sid, '.denied.jsonl', { TRAIL_HOME: b.trail })), false);
  } finally {
    done(b);
  }
});
