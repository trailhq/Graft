/**
 * PostToolUse and PostToolUseFailure's wall part (design 3.4, J06 day 1):
 * a failed command whose error is in the catalog gets the fix as context
 * from Trail (D88), the hook writes no file for it, `failureContext: false`
 * and skills off append nothing, an exit-0 result matches only under P23's
 * limits, and a kept lesson that worked in 2 epochs adds what fixed it
 * before. Telemetry: `wall_hit{class, had_lesson}`. Synthetic repo, made-up
 * commands and error text only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseNote } from '../src/notes/notes.js';
import { delimiter, join } from 'node:path';
import { postBashRun } from '../src/claude/post-bash.js';
import { WALL_COPY, wallFixText } from '../src/trace/walls.js';
import { noteWalls, wallsPath } from '../src/trace/wall-state.js';
import { writeLesson } from '../src/skills/lessons.js';
import { at, box, calling, done, one, postBashFailHook, postBashHook, resultOf, session, SHOP, type Box } from './claude-skills-journey-fixtures.js';
import { allowedValue, EVENTS } from '../src/telemetry/contract.js';

const DOCKER_ERR = 'Exit code 1\n--- FAIL: TestOrders (0.01s)\npanic: rootless Docker not found [recovered]\nFAIL\tacme/shop/orders\t0.412s';
const GO_TEST = 'go test -tags integration ./...';

/** A box whose hooks see a `colima` on PATH (J06's machine). */
function colimaBox(tag: string, opts: { env?: Record<string, string>; settings?: Record<string, unknown> } = {}): Box {
  const b = box(tag, { settings: opts.settings, env: opts.env });
  const bin = join(b.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'colima'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'colima'), 0o755);
  b.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  return b;
}
const ctxOf = (out: string) => one(out)?.hookSpecificOutput ?? null;

/** Telemetry carries only the contract's keys and values (counts only, R16). */
function contractOnly(sent: Array<[string, Record<string, string>]>): void {
  for (const [event, props] of sent) {
    const keys = EVENTS[event];
    assert.ok(keys, `not a contract event: ${event}`);
    for (const [k, v] of Object.entries(props)) {
      assert.ok(keys.has(k), `${event}.${k} is not in the contract`);
      assert.ok(allowedValue(event, k, String(v)), `${event}.${k}=${v} is not a contract value`);
    }
  }
}

test('J06 day 1: the docker wall\'s fix is appended to the failed result as information from Trail, and that hook writes no file', async () => {
  const b = colimaBox('walls-j06');
  try {
    const s = session(b);
    const id = calling(s, at(10, 0), GO_TEST);
    resultOf(s, at(10, 1), id, DOCKER_ERR, true);
    const out = ctxOf(await postBashFailHook(s, at(10, 1), GO_TEST, id, DOCKER_ERR));
    assert.equal(out?.hookEventName, 'PostToolUseFailure');
    const text: string = out?.additionalContext ?? '';
    assert.ok(text.startsWith(WALL_COPY.lead!), text);
    for (const name of ['DOCKER_HOST=unix://$HOME/.colima/default/docker.sock', 'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock', 'TESTCONTAINERS_RYUK_DISABLED=true']) assert.ok(text.includes(name), name);
    assert.doesNotMatch(text, /What fixed this here before/, 'no lesson kept yet');
    assert.doesNotMatch(text, /TestOrders|acme\/shop\/orders/, 'nothing from the output');
    assert.equal(existsSync(wallsPath({ TRAIL_HOME: b.trail })), false, 'PostToolUseFailure writes no walls.json (R34)');
  } finally {
    done(b);
  }
});

test('failureContext false appends nothing on PostToolUseFailure; skills off neither; an error outside the catalog neither', async () => {
  const quiet = colimaBox('walls-nofc', { env: { TRAIL_HOST_FACTS: JSON.stringify({ failureContext: false }) } });
  try {
    const s = session(quiet);
    const id = calling(s, at(10, 0), GO_TEST);
    assert.equal(await postBashFailHook(s, at(10, 1), GO_TEST, id, DOCKER_ERR), '');
  } finally {
    done(quiet);
  }
  const off = colimaBox('walls-off', { settings: { skills: 'off' } });
  try {
    const s = session(off);
    const id = calling(s, at(10, 0), GO_TEST);
    assert.equal(await postBashFailHook(s, at(10, 1), GO_TEST, id, DOCKER_ERR), '');
  } finally {
    done(off);
  }
  const plain = colimaBox('walls-plain');
  try {
    const s = session(plain);
    const id = calling(s, at(10, 0), 'npm test');
    assert.equal(await postBashFailHook(s, at(10, 1), 'npm test', id, 'Exit code 1\nTests: 1 failed, 11 passed'), '');
  } finally {
    done(plain);
  }
});

test('an exit-0 result matches only P23\'s classes, on a command that is not look-only, as PostToolUse context', async () => {
  const b = colimaBox('walls-exit0');
  try {
    const s = session(b);
    const cmd = 'go test ./... 2>&1 | tail -5';
    const id = calling(s, at(10, 0), cmd);
    const out = ctxOf(await postBashHook(s, at(10, 1), cmd, id, 'panic: rootless Docker not found\nok'));
    assert.equal(out?.hookEventName, 'PostToolUse');
    assert.ok(String(out?.additionalContext).startsWith(WALL_COPY.lead!));
    const look = 'cat logs/test.log';
    const id2 = calling(s, at(10, 2), look);
    assert.equal(await postBashHook(s, at(10, 3), look, id2, 'panic: rootless Docker not found'), '', 'look-only: a log printed, not a wall hit');
  } finally {
    done(b);
  }
});

test('wall_hit carries the class and whether a lesson applies; a lesson that worked in 2 epochs adds what fixed it before', () => {
  const b = colimaBox('walls-lesson');
  try {
    const s = session(b);
    const env = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(12, 0), PATH: b.env.PATH };
    const payload = { ...s.payload, tool_name: 'Bash', tool_input: { command: GO_TEST }, tool_use_id: 'toolu_w1', error: DOCKER_ERR };
    const first = postBashRun(payload, b.repo, env, true);
    assert.deepEqual(first.sent, [['wall_hit', { class: 'docker-rootless', had_lesson: 'false' }]]);
    assert.equal(first.out.context, wallFixText('docker-rootless', { hasProgram: (p) => p === 'colima', remoteSsh: null }));

    const lessonText = '"rootless Docker not found": colima start, then DOCKER_HOST=unix://$HOME/.colima/default/docker.sock';
    const path = writeLesson({ id: '', skill: null, at: '2026-10-02', text: lessonText, kind: 'lesson', src: 'repair', wall: 'docker-rootless' }, SHOP, env);
    const id = parseNote(readFileSync(path, 'utf8'), path)!.id!;
    noteWalls({ worked: [{ cls: 'docker-rootless', lessonId: id, sh: 'a1b2c3d4e5f6', epoch: 0, d: '2026-10-02' }] }, env);
    const once = postBashRun(payload, b.repo, env, true);
    assert.deepEqual(once.sent, [['wall_hit', { class: 'docker-rootless', had_lesson: 'true' }]]);
    assert.doesNotMatch(once.out.context ?? '', /What fixed this here before/, 'one epoch is not enough (4.10)');
    noteWalls({ worked: [{ cls: 'docker-rootless', lessonId: id, sh: 'a1b2c3d4e5f6', epoch: 1, d: '2026-10-09' }] }, env);
    const twice = postBashRun(payload, b.repo, env, true);
    for (const r of [first, once, twice]) contractOnly(r.sent as Array<[string, Record<string, string>]>);
    assert.match(twice.out.context ?? '', /\n\[trail\] What fixed this here before \(a learning this person kept in Trail, worked on Oct 2 and Oct 9\): "rootless Docker not found": colima start/);
  } finally {
    done(b);
  }
});
