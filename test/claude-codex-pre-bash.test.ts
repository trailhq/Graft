/**
 * Phase 2 c7 (design 3.3, 4.17, P37, P38; J13's Codex leg, model-free): on Codex a step that can't be undone is
 * always denied with its command printed for the person, in every permission mode, because a Codex hook's `ask`
 * fails the hook and lets the command run (D17, D133). Trail never answers `allow` on Codex (an allow without
 * `updatedInput` drops the whole output), and a deny is the only thing in the output. Made-up repo, skill and ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexPayload, preBashOutput } from '../src/claude/pre-bash.js';
import { detectHost } from '../src/trace/host.js';
import { gatedWhat } from '../src/skills/risk.js';
import { programOf } from '../src/trace/shell.js';
import { gateFilePath, readGateFile, type GateFile } from '../src/trace/gate-file.js';
import { at, box, done, one, type Box } from './claude-skills-journey-fixtures.js';
import { cxPreBash, cxSession, nextCall, type CxSession } from './codex-journey-fixtures.js';

const STEP2 = 'npm publish acme-cli-{version}.tgz --access public';
const STEP3 = 'npm publish acme-cli-extras-{version}.tgz --access public';
const PARAMS = { version: '1.4.4' };
const RUN2 = 'npm publish acme-cli-1.4.4.tgz --access public';
const RUN3 = 'npm publish acme-cli-extras-1.4.4.tgz --access public';

function gate(approvedAt: string | null = null): GateFile {
  const steps = [{ n: 2, text: STEP2, program: programOf(STEP2) }, { n: 3, text: STEP3, program: programOf(STEP3) }];
  return {
    v: 1, epoch: 0,
    live: [{
      injId: 'i-0001', name: 'release-npm', skillId: 'sk-0001', params: PARAMS, steps: ['npm run build', STEP2, STEP3], check: 'npm view acme-cli version',
      groups: [{ kind: 'publish', steps, askedAt: approvedAt, askedToolUseId: approvedAt ? 'call_x' : null, approvedAt, askedStep: approvedAt ? 2 : null }],
    }],
  };
}

function rig(tag: string, mode: string, g: GateFile | null = gate()): { b: Box; s: CxSession } {
  const b = box(tag);
  const s = cxSession(b, { mode });
  if (g) {
    const path = gateFilePath(s.sid, { TRAIL_HOME: b.trail });
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(g));
  }
  return { b, s };
}

const denyFor = (cmd: string, n: number) => `trail: Trail, the tool this person installed to keep commands that worked as skills, stopped step ${n} of skill release-npm: it ${gatedWhat('publish', n === 2 ? STEP2 : STEP3, PARAMS)} and can't be undone, and this session can't ask the person first. So don't run it, and don't try it again this turn, even after a yes in chat; ask the person to run this command in their own terminal: ${cmd}`;

test('J13 Codex leg: in every permission mode the gated step is denied and its command printed; no ask is marked', async () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']) {
    const { b, s } = rig(`cx-j13-${mode}`, mode);
    try {
      for (const [cmd, n] of [[RUN2, 2], [RUN3, 3]] as const) {
        const out = one(await cxPreBash(s, at(22, 1), cmd, nextCall(s)));
        assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyFor(cmd, n) } }, `${mode} step ${n}`);
      }
      assert.equal(readGateFile(s.sid, { TRAIL_HOME: b.trail })!.live[0]!.groups[0]!.askedStep, null, 'nothing was asked');
    } finally {
      done(b);
    }
  }
});

test('J13 Codex leg: a yes in chat or an earlier approval never lets a gated step through on Codex', async () => {
  const { b, s } = rig('cx-j13-approved', 'default', gate(at(22, 0)));
  try {
    const out = one(await cxPreBash(s, at(22, 1), RUN3, nextCall(s)));
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    done(b);
  }
});

test('J13 Codex leg: with no live block a publish is Codex\'s own business', async () => {
  const { b, s } = rig('cx-j13-none', 'default', null);
  try {
    assert.equal(await cxPreBash(s, at(22, 1), RUN2, nextCall(s)), '');
  } finally {
    done(b);
  }
});

test('no allow and no ask anywhere in Codex PreToolUse output; a deny carries only the decision and its reason (P37, P38)', async () => {
  const { b, s } = rig('cx-scan', 'default');
  try {
    const commands = [
      RUN2, RUN3, 'npm run build', 'ls -la', 'trail skills on', 'tr""ail skills offers on', 'node .claude/helpers/trail-hooks.cjs stop',
      'trail skills add release-npm --run r-1022-0a1b2c3d', 'trail skills lesson --offer o-0a1b2c', 'trail skills lesson release-npm --offer o-0a1b2c',
      'timeout 5 npm test', 'trail keep 1', 'cat ~/.codex/hooks/graft/graft-hooks.cjs',
    ];
    let denies = 0;
    for (const cmd of commands) {
      const raw = await cxPreBash(s, at(22, 1), cmd, nextCall(s));
      if (raw === '') continue;
      const out = one(raw)!;
      assert.deepEqual(Object.keys(out), ['hookSpecificOutput'], cmd);
      assert.deepEqual(Object.keys(out.hookSpecificOutput), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'], cmd);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', cmd);
      assert.ok(out.hookSpecificOutput.permissionDecisionReason, cmd);
      denies++;
    }
    assert.ok(denies >= 5, `${denies} denies`);
  } finally {
    done(b);
  }
});

test('the fast path turns any allow into nothing and any ask into a deny on a Codex payload; Claude Code\'s are as before', () => {
  const codex = { session_id: 's', transcript_path: '/home/dev/.codex/sessions/2026/10/27/rollout-x.jsonl', turn_id: 't', tool_name: 'Bash', tool_input: { command: 'x' } };
  const claude = { session_id: 's', transcript_path: '/home/dev/.claude/projects/-x/s.jsonl', tool_name: 'Bash', tool_input: { command: 'x' } };
  const allow = () => ({ permissionDecision: 'allow' as const, reason: 'trail: fine' });
  const ask = () => ({ permissionDecision: 'ask' as const, reason: 'trail: this publishes and can\'t be undone.' });
  assert.equal(preBashOutput(codex, '/x', allow), '');
  assert.equal(JSON.parse(preBashOutput(codex, '/x', ask)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(preBashOutput(claude, '/x', allow)).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(JSON.parse(preBashOutput(claude, '/x', ask)).hookSpecificOutput.permissionDecision, 'ask');
});

test("the fast path's Codex check agrees with detectHost on every payload shape", () => {
  const payloads: Record<string, unknown>[] = [
    { session_id: 's', transcript_path: '/h/.codex/sessions/2026/10/27/rollout-2026-10-27T10-00-00-x.jsonl', turn_id: 't' },
    { session_id: 's', transcript_path: '/h/.codex/sessions/2026/10/27/rollout-2026-10-27T10-00-00-x.jsonl' },
    { session_id: 's', transcript_path: null, turn_id: 't' },
    { session_id: 's', transcript_path: 'C:\\Users\\dev\\.codex\\sessions\\rollout-x.jsonl.zst' },
    { session_id: 's', transcript_path: '/h/.claude/projects/-x/s.jsonl' },
    { session_id: 's', transcript_path: '/h/.claude/projects/-x/s.jsonl', hook_event_name: 'PreToolUse', agent_id: 'a' },
    { conversation_id: 'c', turn_id: 't' },
    { conversationId: 'c', turn_id: 't' },
    { session_id: 's', transcript_path: '/h/.cursor/projects/x/agent-transcripts/rollout-1.jsonl' },
    { sessionId: 's', toolName: 'bash', transcriptPath: '/h/.copilot/session-state/x.jsonl' },
    { session_id: 's', turn_id: null },
    {},
  ];
  for (const p of payloads) assert.equal(codexPayload(p), detectHost(p).host === 'codex', JSON.stringify(p));
});
