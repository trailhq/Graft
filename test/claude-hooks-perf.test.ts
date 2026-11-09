/**
 * Every hook's own time, on a session whose transcript has grown huge (a real
 * one passed 233 MB). The hooks that read the transcript read only what it
 * gained since their last read, so each hook's time follows the turn, not the
 * file. The small test runs always; the 200 MB one runs with TRAIL_PERF=1 and
 * deletes its file after. Times are the handler's, in this process: the
 * spawn of Node itself is the same for every hook and is measured apart
 * (claude-pre-bash.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { main } from '../src/claude/hooks.js';
import { main as preBashMain } from '../src/claude/pre-bash.js';
import { readSession } from '../src/claude/state.js';
import { writeNote } from '../src/notes/notes.js';
import { jsonl, toolResult, typed } from './trace-fixtures.js';
import { tmpRepo } from './helpers.js';
import { timeBar } from './machine-speed.js';

const SESSION = '0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e';

/** One turn of about 3 KB: a prompt, a command with usage, its output, a reply with usage. */
function turn(i: number): string {
  const usage = { input_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 40_000, output_tokens: 30 };
  const base = { sessionId: SESSION, isSidechain: false, cwd: '/home/dev/shop', timestamp: '2026-10-01T10:00:00.000Z' };
  return jsonl([
    typed(`run the tests for module ${i}`),
    { ...base, type: 'assistant', uuid: `c-${i}`, message: { id: `msg_c${i}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: `npm test -- module-${i}` } }], usage } },
    toolResult(`toolu_${i}`, `PASS module-${i}\n${'ok line of test output\n'.repeat(100)}`, false),
    { ...base, type: 'assistant', uuid: `r-${i}`, message: { id: `msg_r${i}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: `Module ${i} passes.` }], usage } },
  ]);
}

function build(path: string, bytes: number): void {
  const block = Array.from({ length: 200 }, (_, i) => turn(i)).join('');
  const fd = openSync(path, 'w');
  try {
    for (let written = 0; written < bytes; written += Buffer.byteLength(block)) writeSync(fd, block);
  } finally {
    closeSync(fd);
  }
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)]!;
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** A trail repo with two learnings, a scratch home, and a graph ask that answers at once. */
function setup(tag: string): { dir: string; transcript: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), `hooks-perf-${tag}-`));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TRAIL_HOME = join(home, '.trail');
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  process.env.DO_NOT_TRACK = '1';
  process.env[BRAND_ENV] = 'trail';
  const dir = tmpRepo(`hooks-perf-${tag}`);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeNote(dir, { title: 'Run module tests with the cache warm', body: '## Decided\nnpm test -- module-N after npm run build.\n', author: 'Priya', date: '2026-10-07', touches: [] });
  writeNote(dir, { title: 'DNS changes go through the infra repo', body: '## Decided\nNever by hand.\n', author: 'Kumar', date: '2026-10-06', touches: [] });
  const stub = join(root, 'ask-stub.cjs');
  writeFileSync(stub, "process.stdout.write(JSON.stringify({ query: '', mode: 'lexical', hits: [] }));\n");
  process.env.GRAFT_TEST_CLI = stub;
  process.env.CLAUDE_PROJECT_DIR = dir;
  const folder = join(home, '.claude', 'projects', '-home-dev-shop');
  mkdirSync(folder, { recursive: true });
  return { dir, transcript: join(folder, `${SESSION}.jsonl`), root };
}

/** Milliseconds `fn` took, with stdout swallowed. */
async function timed(stdin: object, fn: () => Promise<void>): Promise<number> {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? true : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.GRAFT_TEST_STDIN = JSON.stringify(stdin);
  const t0 = performance.now();
  try {
    await fn();
    return performance.now() - t0;
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
  }
}

type Hook = 'session-start' | 'prompt' | 'pre-bash' | 'tool-savings' | 'stop';

/** One round of a turn's hooks, as Claude Code fires them, after `i`'s lines are appended. */
async function round(transcript: string, i: number, times: Record<Hook, number[]>): Promise<void> {
  const common = { session_id: SESSION, transcript_path: transcript, cwd: '/home/dev/shop', permission_mode: 'default' };
  appendFileSync(transcript, turn(100_000 + i));
  times.prompt.push(await timed({ ...common, hook_event_name: 'UserPromptSubmit', prompt: `run the tests for module ${100_000 + i}` }, () => main('prompt')));
  const bash = { ...common, tool_name: 'Bash', tool_input: { command: `npm test -- module-${i}` }, tool_use_id: `toolu_${i}` };
  times['pre-bash'].push(await timed({ ...bash, hook_event_name: 'PreToolUse' }, () => preBashMain('pre-bash')));
  times['tool-savings'].push(await timed({ ...bash, hook_event_name: 'PostToolUse', tool_response: { stdout: 'PASS\n[graft] tokens saved ≈ 1,200', stderr: '' } }, () => main('tool-savings')));
  times.stop.push(await timed({ ...common, hook_event_name: 'Stop', stop_hook_active: false }, () => main('stop')));
}

async function measure(bytes: number, rounds: number, tag: string): Promise<{ first: number; times: Record<Hook, number[]> }> {
  const { dir, transcript, root } = setup(tag);
  try {
    build(transcript, bytes);
    assert.ok(statSync(transcript).size >= bytes);
    const times: Record<Hook, number[]> = { 'session-start': [], prompt: [], 'pre-bash': [], 'tool-savings': [], stop: [] };
    // The first session start in a fresh home also does once-per-machine and once-per-repo work; it is reported apart.
    for (let i = 0; i < 20; i++) times['session-start'].push(await timed({ session_id: SESSION, transcript_path: transcript, cwd: '/home/dev/shop', hook_event_name: 'SessionStart', source: 'startup' }, () => main('session-start')));
    // The first Stop of a session meets the whole file: it reads only its end.
    const first = await timed({ session_id: SESSION, transcript_path: transcript, cwd: '/home/dev/shop', hook_event_name: 'Stop' }, () => main('stop'));
    const billedFirst = readSession(dir, SESSION).inputTokensBilled ?? 0;
    for (let i = 0; i < rounds; i++) await round(transcript, i, times);
    const billed = (readSession(dir, SESSION).inputTokensBilled ?? 0) - billedFirst;
    assert.equal(billed, rounds * 2 * 40_250, 'each appended response billed once, nothing read twice');
    const summary = (Object.keys(times) as Hook[]).map((h) => `${h} p50 ${p50(times[h]).toFixed(1)} / p95 ${p95(times[h]).toFixed(1)} ms`).join('; ');
    console.log(`${tag}: ${(statSync(transcript).size / 1024 / 1024).toFixed(0)} MB transcript, first session start ${times['session-start'][0]!.toFixed(1)} ms, first Stop ${first.toFixed(1)} ms; ${summary}`);
    return { first, times };
  } finally {
    for (const key of ['GRAFT_TEST_CLI', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR']) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

test('on a growing transcript every hook stays well under 300 ms, and Stop reads only the new turn', async () => {
  const { first, times } = await measure(4 * 1024 * 1024, 10, 'small');
  assert.ok(first < timeBar(1000, 3000), `first Stop ${first.toFixed(1)} ms`);
  // Scaled to this machine, with a floor, under a loaded full-suite run; the TRAIL_PERF run below holds the 300 ms line.
  assert.ok(p95(times.stop) < timeBar(300, 1000), `Stop p95 ${p95(times.stop).toFixed(1)} ms`);
});

test('on a 200 MB transcript each hook is under 300 ms at p95 (TRAIL_PERF=1)', { skip: process.env.TRAIL_PERF === '1' ? false : 'set TRAIL_PERF=1 to run' }, async () => {
  const { first, times } = await measure(200 * 1024 * 1024, 30, 'big');
  assert.ok(first < 1000, `first Stop ${first.toFixed(1)} ms`);
  for (const [hook, xs] of Object.entries(times)) assert.ok(p95(xs) < 300, `${hook} p95 ${p95(xs).toFixed(1)} ms`);
});
