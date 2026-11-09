/**
 * D100 item 18: a FIFO planted where a hook appends (the PostToolUse mark
 * file, the hook-error log written by hookError and by the save gate's fast
 * path) must not hold the hook. Each append opens without blocking and writes
 * only to a regular file; anything else is skipped, failing open. Each case
 * runs in a child process with a timeout, so a blocking open fails the test
 * instead of hanging the runner. Made-up sessions only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { timeBar } from './machine-speed.js';

const SRC = resolve(import.meta.dirname, '..', 'src');
const FIXTURES = resolve(import.meta.dirname, 'claude-skills-journey-fixtures.ts');
const posix = process.platform !== 'win32';

/** Runs `body` (an async function body, given `env`) in a child; returns its printed ms, or fails on a timeout. */
function inChild(root: string, env: Record<string, string>, body: string): number {
  const script = join(root, 'child.mts');
  writeFileSync(script, `const env = ${JSON.stringify(env)};\nconst t0 = performance.now();\nawait (async () => {\n${body}\n})();\nprocess.stdout.write(String(Math.round(performance.now() - t0)));\n`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...env } });
  assert.equal(r.signal, null, `the child was stopped (${r.signal}): the append blocked on the FIFO`);
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim().split('\n').pop());
}

function fifoAt(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  execFileSync('mkfifo', [path]);
}
const stillFifo = (path: string) => statSync(path).isFIFO();

test('a FIFO at the PostToolUse mark file: appendPostMark returns at once and writes nothing', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'trail-fifo-mark-'));
  try {
    const env = { HOME: join(root, 'home'), TRAIL_HOME: join(root, 'trail-home') };
    const path = join(env.TRAIL_HOME, 'sessions', 's-fifo.post.jsonl');
    fifoAt(path);
    const ms = inChild(root, env, `const { appendPostMark } = await import(${JSON.stringify(join(SRC, 'trace', 'gate-file.ts'))});
appendPostMark('s-fifo', { id: 'toolu_1', at: '2026-10-01T10:00:01.000Z', failed: false }, env);`);
    assert.ok(ms < timeBar(100, 400), `${ms} ms`);
    assert.ok(stillFifo(path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a FIFO at the hook-error log: hookError returns at once and writes nothing', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'trail-fifo-log-'));
  try {
    const env = { HOME: join(root, 'home'), TRAIL_HOME: join(root, 'trail-home') };
    const path = join(env.TRAIL_HOME, 'state', 'hook-errors.log');
    fifoAt(path);
    const ms = inChild(root, env, `const { hookError } = await import(${JSON.stringify(join(SRC, 'claude', 'skills-hook-util.ts'))});
hookError('prompt', new TypeError('made up'), env);`);
    assert.ok(ms < timeBar(100, 400), `${ms} ms`);
    assert.ok(stillFifo(path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a FIFO at the hook-error log: the PreToolUse fast path that throws (logThrow) returns at once and writes nothing', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'trail-fifo-pre-'));
  try {
    const ms = inChild(root, {}, `const { box, session, at, done } = await import(${JSON.stringify(FIXTURES)});
const { preBashSkills } = await import(${JSON.stringify(join(SRC, 'claude', 'pre-bash-skills.ts'))});
const { gateFilePath } = await import(${JSON.stringify(join(SRC, 'trace', 'gate-file.ts'))});
const { programOf } = await import(${JSON.stringify(join(SRC, 'trace', 'shell.ts'))});
const { writeFileSync, mkdirSync, readFileSync, rmSync, statSync } = await import('node:fs');
const { execFileSync } = await import('node:child_process');
const { join } = await import('node:path');
const b = box('fifo-pre');
try {
  const s = session(b);
  const e = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 60) };
  // A gate file whose live skill has params that are not an object: the gated-step check throws, outside the save gate.
  const step = 'npm publish acme-cli-{version}.tgz --access public';
  const path = gateFilePath(s.sid, e);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ v: 1, epoch: 0, live: [{
    injId: 'i-0001', name: 'release-npm', skillId: 'sk-0001', params: null, steps: ['npm run build', step], check: 'npm view acme-cli version',
    groups: [{ kind: 'publish', steps: [{ n: 2, text: step, program: programOf(step) }], askedAt: at(22, 0), askedToolUseId: 'toolu_asked', approvedAt: at(22, 30), askedStep: 2 }],
  }] }));
  const command = 'npm publish acme-cli-1.4.4.tgz --access public';
  const input = { ...s.payload, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_y' };
  const log = join(b.trail, 'state', 'hook-errors.log');
  // Once with a plain log: it proves the throw reaches logThrow, and loads every module, so only the FIFO call is timed.
  if ((await preBashSkills(input, b.repo, e, command)) !== null) throw new Error('the warm-up call did not fail open');
  if (!/^\\S+ pre-bash \\w+/.test(readFileSync(log, 'utf8'))) throw new Error('the warm-up call logged nothing');
  rmSync(log);
  execFileSync('mkfifo', [log]);
  const t = performance.now();
  const d = await preBashSkills(input, b.repo, e, command);
  const took = performance.now() - t;
  if (d !== null) throw new Error('the gate did not fail open');
  if (!statSync(log).isFIFO()) throw new Error('the FIFO was replaced');
  if (took >= 100) throw new Error(took + ' ms');
} finally {
  done(b);
}`);
    assert.ok(Number.isFinite(ms));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a FIFO at the hook-error log: the save gate that throws (hookError) returns at once and writes nothing', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'trail-fifo-gate-'));
  try {
    inChild(root, {}, `const { box, session, at, done } = await import(${JSON.stringify(FIXTURES)});
const { preBashSkills } = await import(${JSON.stringify(join(SRC, 'claude', 'pre-bash-skills.ts'))});
const { writeFileSync, readFileSync, rmSync, statSync } = await import('node:fs');
const { execFileSync } = await import('node:child_process');
const { join } = await import('node:path');
const b = box('fifo-gate');
try {
  const s = session(b);
  // A file where the sessions folder goes: the save gate throws (as in claude-hooks-review's test).
  writeFileSync(join(b.trail, 'sessions'), 'not a folder');
  const e = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 0) };
  const command = 'trail skills add release-npm --run r-1022-0a1b';
  const input = { ...s.payload, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_x' };
  const log = join(b.trail, 'state', 'hook-errors.log');
  await preBashSkills(input, b.repo, e, command);
  if (!readFileSync(log, 'utf8')) throw new Error('the warm-up call logged nothing');
  rmSync(log);
  execFileSync('mkfifo', [log]);
  const t = performance.now();
  const d = await preBashSkills(input, b.repo, e, command);
  const took = performance.now() - t;
  if (d !== null) throw new Error('the gate did not fail open');
  if (!statSync(log).isFIFO()) throw new Error('the FIFO was replaced');
  if (took >= 100) throw new Error(took + ' ms');
} finally {
  done(b);
}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
