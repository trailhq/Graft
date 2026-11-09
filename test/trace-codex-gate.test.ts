/**
 * Phase 2 c7 (design 3.0, 4.17, 4.18, R18, P31): the skills gate on Codex payloads. Headless comes from the
 * rollout's `session_meta` (`originator: "codex_exec"`, or `source` exec or mcp), never from Claude Code's
 * entrypoint; a session with no rollout (ephemeral) folds nothing and learns nothing; Codex stays tier B (fold on,
 * learning off) unless a test home sets TRAIL_TIER_CODEX=A. Synthetic rollouts only.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillsGate, withSkillSession } from '../src/trace/skill-session.js';
import { detectHost, CODEX_TIER } from '../src/trace/host.js';
import { hostTier } from '../src/skills/host-facts.js';
import * as CX from './codex-fixtures.js';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A test home with skills on, a Codex home, and one rollout whose first line is `meta`. */
function boxWith(metaOpts: Parameters<typeof CX.meta>[0] = {}, envExtra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'c7-gate-'));
  made.push(root);
  const trail = join(root, 'trail-home');
  mkdirSync(trail, { recursive: true });
  writeFileSync(join(trail, 'settings.json'), JSON.stringify({ v: 1, skills: 'on', onSince: '2026-08-01T00:00:00.000Z' }));
  const tx = CX.rollout(root, [CX.meta(metaOpts), CX.turnContext('/home/dev/shop')]);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TRAIL_HOME: trail, CODEX_HOME: join(root, '.codex'), ...envExtra };
  const payload = { session_id: CX.CODEX_SID, transcript_path: tx, cwd: '/home/dev/shop', permission_mode: 'default', turn_id: 'turn-1', model: 'gpt-5-codex', hook_event_name: 'PreToolUse' };
  return { root, env, tx, payload };
}

function gate(input: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const g = skillsGate(input, '/home/dev/shop', env);
  if (!g.ok) throw new Error(g.why);
  return g.ctx;
}

test('an interactive Codex session is tier B until the flip: fold on, learning off for the host', () => {
  assert.equal(CODEX_TIER, 'B', 'the one constant P31 flips');
  const b = boxWith();
  const ctx = gate(b.payload, b.env);
  assert.equal(ctx.host, 'codex');
  assert.equal(ctx.tier, 'B');
  assert.equal(ctx.entry, 'interactive', 'no CLAUDE_CODE_ENTRYPOINT on Codex, and that alone is not headless');
  assert.deepEqual([ctx.fold, ctx.learn, ctx.learnOff], [true, false, 'host']);
});

test('TRAIL_TIER_CODEX=A gives tier A in a test home only; never on a home that is the person\'s own layout', () => {
  const b = boxWith({}, { TRAIL_TIER_CODEX: 'A' });
  const ctx = gate(b.payload, b.env);
  assert.deepEqual([ctx.tier, ctx.learn, ctx.learnOff], ['A', true, null]);
  // TRAIL_HOME is HOME/.trail and there is no lab marker: not a test home, so the switch does nothing.
  const plain = { ...b.env, TRAIL_HOME: join(b.root, '.trail') };
  mkdirSync(plain.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(plain.TRAIL_HOME!, 'settings.json'), JSON.stringify({ v: 1, skills: 'on' }));
  assert.equal(gate(b.payload, plain).tier, 'B');
  assert.equal(hostTier('codex', 'B', plain), 'B');
  // Only Codex, and only the value A.
  assert.equal(hostTier('claude', 'A', b.env), 'A');
  assert.equal(hostTier('cursor', 'D', b.env), 'D');
  assert.equal(hostTier('codex', 'B', { ...b.env, TRAIL_TIER_CODEX: 'a' }), 'B');
});

test('headless from the rollout: originator codex_exec, or source exec or mcp; learning off, recall on', () => {
  for (const m of [{ originator: 'codex_exec' }, { source: 'exec' }, { source: 'mcp' }]) {
    const b = boxWith(m, { TRAIL_TIER_CODEX: 'A' });
    const ctx = gate(b.payload, b.env);
    assert.equal(ctx.entry, 'headless', JSON.stringify(m));
    assert.deepEqual([ctx.fold, ctx.learn, ctx.learnOff], [false, false, 'headless'], JSON.stringify(m));
  }
  // The CLI's own interactive session and the app's.
  for (const m of [{ originator: 'codex_cli_rs', source: 'cli' }, { originator: 'Codex Desktop', source: 'vscode' }]) {
    const b = boxWith(m);
    assert.equal(gate(b.payload, b.env).entry, 'interactive', JSON.stringify(m));
  }
});

test('the lab switch makes a codex exec box interactive (D26), only with its marker', () => {
  const b = boxWith({ originator: 'codex_exec', source: 'exec' }, { TRAIL_LAB_INTERACTIVE: '1', TRAIL_TIER_CODEX: 'A' });
  assert.equal(gate(b.payload, b.env).entry, 'headless', 'no $HOME/.trail-lab: the switch does nothing');
  writeFileSync(join(b.root, '.trail-lab'), '');
  const ctx = gate(b.payload, b.env);
  assert.equal(ctx.entry, 'interactive');
  assert.equal(ctx.learn, true);
});

test('an ephemeral Codex session (transcript_path null) folds nothing and learns nothing: recall only', () => {
  const b = boxWith({}, { TRAIL_TIER_CODEX: 'A' });
  const ctx = gate({ ...b.payload, transcript_path: null }, b.env);
  assert.equal(ctx.host, 'codex', 'turn_id says Codex');
  assert.deepEqual([ctx.fold, ctx.learn, ctx.learnOff, ctx.transcriptPath], [false, false, 'ephemeral', null]);
});

test('a Codex SessionStart payload (no turn_id) is told apart by its rollout path; with no path it reads as unknown, recall only (R18)', () => {
  const b = boxWith({}, { TRAIL_TIER_CODEX: 'A' });
  const start = { session_id: CX.CODEX_SID, transcript_path: b.tx, cwd: '/home/dev/shop', hook_event_name: 'SessionStart', model: 'gpt-5-codex', permission_mode: 'default', source: 'startup' };
  assert.equal(detectHost(start).host, 'codex');
  assert.equal(gate(start, b.env).learn, true);
  const none = { ...start, transcript_path: null };
  assert.equal(detectHost(none).host, 'unknown');
  const ctx = gate(none, b.env);
  assert.equal(ctx.learn, false, 'unknown is never tier A');
  assert.equal(ctx.transcriptPath, null, 'nothing to read');
});

test('a Codex subagent (agent_id) stays out, whatever the rollout says', () => {
  const b = boxWith({}, { TRAIL_TIER_CODEX: 'A' });
  const ctx = gate({ ...b.payload, agent_id: 'agent-7', agent_type: 'worker' }, b.env);
  assert.deepEqual([ctx.subagent, ctx.learn, ctx.learnOff], [true, false, 'subagent']);
});

test('the session keeps the rollout\'s first-line facts in st.codex.meta, once', () => {
  const b = boxWith({ originator: 'codex_cli_rs', source: 'cli', cli: '0.150.0-alpha.8' });
  const ctx = gate(b.payload, b.env);
  const meta = withSkillSession(ctx, { catchUp: false }, (st) => st.codex?.meta ?? null);
  assert.equal(meta?.id, CX.CODEX_SID);
  assert.equal(meta?.originator, 'codex_cli_rs');
  assert.equal(meta?.cliVersion, '0.150.0-alpha.8');
  // Typed hashes the prompt hook recorded stay as they are.
  withSkillSession(ctx, { catchUp: false }, (st) => { st.codex!.typedShas.push('0123456789abcdef'); });
  assert.deepEqual(withSkillSession(gate(b.payload, b.env), { catchUp: false }, (st) => st.codex?.typedShas), ['0123456789abcdef']);
});
