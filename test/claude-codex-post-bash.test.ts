/**
 * Phase 2 c7 (design 3.4, P34): Codex's PostToolUse on Bash (`codex-post-bash`). Codex fires it on every exit, with
 * `tool_response` the model-facing text, so the exit comes from the output's header: `Process exited with code N`
 * (or the older `Exit code: N`, or JSON `metadata.exit_code`). A text with no header (a command still running, an
 * unknown shape) writes no mark: the rollout's result is then the only one. Context goes out only where Codex's
 * facts say PostToolUse context reaches the model (`postToolContext`, off until HC1). Synthetic output only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { codexFailed } from '../src/claude/post-bash.js';
import { WALL_COPY } from '../src/trace/walls.js';
import { at, box, done, one, type Box } from './claude-skills-journey-fixtures.js';
import { cxCall, cxOutput, cxPostBash, cxSession, execText, nextCall, runningText } from './codex-journey-fixtures.js';

const marksOf = (b: Box, sid: string): Array<Record<string, unknown>> => {
  const p = join(b.trail, 'sessions', `${sid}.post.jsonl`);
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('codexFailed reads only the header: each exit form, a running command, and none', () => {
  assert.equal(codexFailed(execText(0, 'Tests: 12 passed')), false);
  assert.equal(codexFailed(execText(1, 'Tests: 1 failed')), true);
  assert.equal(codexFailed(execText(137, '')), true);
  assert.equal(codexFailed('Exit code: 2\nWall time: 0.2 seconds\nOutput:\nnope'), true);
  assert.equal(codexFailed('Exit code: 0\nWall time: 0.2 seconds\nOutput:\nok'), false);
  assert.equal(codexFailed(JSON.stringify({ output: 'ok', metadata: { exit_code: 0, duration_seconds: 0.1 } })), false);
  assert.equal(codexFailed(JSON.stringify({ output: 'no', metadata: { exit_code: 3 } })), true);
  assert.equal(codexFailed([{ type: 'input_text', text: execText(1, 'x') }]), true, 'an array of text parts');
  assert.equal(codexFailed(runningText(7, 'still going')), null, 'still running: no exit yet');
  assert.equal(codexFailed(execText(1, 'Process exited with code 0')), true, 'the words in the body are never the header');
  assert.equal(codexFailed('plain text'), null);
  assert.equal(codexFailed(''), null);
  assert.equal(codexFailed({ stdout: 'x', stderr: '' }), null, "Claude Code's shape is not Codex's");
  assert.equal(codexFailed(undefined), null);
});

test("a check's result leaves a mark with the exit from the header and the body as the rollout reader shows it", async () => {
  const b = box('cx-post');
  try {
    const s = cxSession(b);
    const ok = nextCall(s);
    cxCall(s, at(27, 1), ok, 'npm test');
    assert.equal(await cxPostBash(s, at(27, 2), 'npm test', ok, execText(0, 'Tests: 12 passed, 12 total')), '', 'no context on Codex (postToolContext off)');
    const bad = nextCall(s);
    cxCall(s, at(27, 3), bad, 'npm test');
    assert.equal(await cxPostBash(s, at(27, 4), 'npm test', bad, execText(1, 'Tests: 1 failed, 11 passed, 12 total')), '');
    const marks = marksOf(b, s.sid);
    assert.deepEqual(marks.map((m) => [m.id, m.failed]), [[ok, false], [bad, true]]);
    assert.match(String(marks[0]!.tail), /Tests: 12 passed, 12 total$/);
    assert.doesNotMatch(String(marks[0]!.tail), /Chunk ID|Process exited/, 'the header is not output');
    assert.match(String(marks[1]!.tail), /1 failed/);
  } finally {
    done(b);
  }
});

test('no header, no mark (P34): a command still running, or a text Trail can\'t read the exit from', async () => {
  const b = box('cx-post-none');
  try {
    const s = cxSession(b);
    const id = nextCall(s);
    cxCall(s, at(27, 1), id, 'npm test');
    cxOutput(s, at(27, 2), id, runningText(7, 'RUNS  orders.test.js'));
    assert.equal(await cxPostBash(s, at(27, 2), 'npm test', id, runningText(7, 'RUNS  orders.test.js')), '');
    assert.equal(await cxPostBash(s, at(27, 3), 'npm test', id, 'Tests: 12 passed'), '');
    assert.equal(await cxPostBash(s, at(27, 4), 'npm test', id, { stdout: 'Tests: 12 passed', stderr: '' }), '');
    assert.deepEqual(marksOf(b, s.sid), []);
  } finally {
    done(b);
  }
});

test("a wall's fix goes out on Codex only where PostToolUse context reaches the model, in Codex's own output shape", async () => {
  const docker = 'Exit code 1\n--- FAIL: TestOrders (0.01s)\npanic: rootless Docker not found [recovered]\nFAIL\tacme/shop/orders\t0.412s';
  const body = docker.replace(/^Exit code 1\n/, '');
  const colima = (b: Box) => {
    const bin = join(b.root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'colima'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'colima'), 0o755);
    b.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  };
  const off = box('cx-wall-off');
  try {
    colima(off);
    const s = cxSession(off);
    const id = nextCall(s);
    cxCall(s, at(27, 1), id, 'go test -tags integration ./...');
    assert.equal(await cxPostBash(s, at(27, 2), 'go test -tags integration ./...', id, execText(1, body)), '', 'HC1 not written up: nothing');
  } finally {
    done(off);
  }
  const on = box('cx-wall-on', { env: { TRAIL_HOST_FACTS: JSON.stringify({ codex: { postToolContext: true } }) } });
  try {
    colima(on);
    const s = cxSession(on);
    const id = nextCall(s);
    cxCall(s, at(27, 1), id, 'go test -tags integration ./...');
    const out = one(await cxPostBash(s, at(27, 2), 'go test -tags integration ./...', id, execText(1, body)));
    assert.deepEqual(Object.keys(out ?? {}), ['hookSpecificOutput'], 'only keys Codex accepts on PostToolUse');
    assert.deepEqual(Object.keys(out!.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.equal(out!.hookSpecificOutput.hookEventName, 'PostToolUse', 'never PostToolUseFailure on Codex');
    assert.ok(String(out!.hookSpecificOutput.additionalContext).startsWith(WALL_COPY.lead!));
    // A flat TRAIL_HOST_FACTS is Claude's: it never turns Codex's on.
  } finally {
    done(on);
  }
  const flat = box('cx-wall-flat', { env: { TRAIL_HOST_FACTS: JSON.stringify({ postToolContext: true }) } });
  try {
    colima(flat);
    const s = cxSession(flat);
    const id = nextCall(s);
    cxCall(s, at(27, 1), id, 'go test -tags integration ./...');
    assert.equal(await cxPostBash(s, at(27, 2), 'go test -tags integration ./...', id, execText(1, body)), '');
  } finally {
    done(flat);
  }
});

test('codex-post-bash ignores a call that is not Bash, and skills off', async () => {
  const b = box('cx-post-off', { settings: { skills: 'off' } });
  try {
    const s = cxSession(b);
    const id = nextCall(s);
    assert.equal(await cxPostBash(s, at(27, 2), 'npm test', id, execText(0, 'Tests: 12 passed')), '');
    assert.deepEqual(marksOf(b, s.sid), []);
  } finally {
    done(b);
  }
});
