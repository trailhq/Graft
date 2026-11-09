/**
 * The Stop hook reads the transcript from where it last stopped, never from
 * the top (a real one passed 233 MB), and keeps what it learns as running
 * totals: the cost of every response once, and the reply in progress. It
 * reads a transcript only when Claude Code sent the payload: Cursor and
 * Copilot CLI run the same hooks with transcripts of their own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/claude/hooks.js';
import { readSession } from '../src/claude/state.js';
import { hookCursorPath } from '../src/trace/state.js';
import { jsonl, toolResult, typed } from './trace-fixtures.js';

const SESSION = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

/** An assistant line with usage, as Claude Code writes one block of a response. */
function reply(uuid: string, msgId: string, part: object, input = 100): object {
  return {
    type: 'assistant', uuid, sessionId: SESSION, isSidechain: false, timestamp: '2026-10-01T10:00:01.000Z', cwd: '/home/dev/shop',
    message: { id: msgId, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [part], usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 } },
  };
}
const text = (t: string) => ({ type: 'text', text: t });
const graftCall = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'trail ask "cart total"' } });

async function hook(event: string, stdin: object): Promise<void> {
  process.env.GRAFT_TEST_STDIN = JSON.stringify(stdin);
  try {
    await main(event);
  } finally {
    delete process.env.GRAFT_TEST_STDIN;
  }
}

function setup(): { dir: string; transcript: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'stop-trace-home-'));
  process.env.TRAIL_HOME = home;
  // Skills are on by default; these tests are about the Stop hook's own reading, with them off.
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ v: 1, skills: 'off' }));
  const dir = mkdtempSync(join(tmpdir(), 'stop-trace-repo-'));
  mkdirSync(join(dir, 'graft', '.cache', 'session'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = dir;
  // Claude Code keeps transcripts under ~/.claude/projects/<folder>/<session>.jsonl.
  const folder = join(home, 'claude', 'projects', '-home-dev-shop');
  mkdirSync(folder, { recursive: true });
  return { dir, transcript: join(folder, `${SESSION}.jsonl`), home };
}

const stopPayload = (transcript: string, extra: object = {}) => ({ session_id: SESSION, transcript_path: transcript, cwd: '/home/dev/shop', hook_event_name: 'Stop', stop_hook_active: false, ...extra });

test('a transcript that grows across three Stops is read once, piece by piece, into running totals', async () => {
  const { dir, transcript } = setup();
  const cursorFile = hookCursorPath(SESSION);
  // Turn 1: a graft call and a reply with the tally.
  writeFileSync(transcript, jsonl([
    typed('where is the cart total computed'),
    reply('a1', 'msg_1', graftCall('toolu_1'), 1_000),
    toolResult('toolu_1', 'src/cart.ts:12 total()\n[graft] tokens saved ≈ 4,000'),
    reply('a2', 'msg_2', text('It is in src/cart.ts. 🌱 graft saved ~4,000 tokens this turn'), 2_000),
  ]));
  await hook('tool-savings', { session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'trail ask "cart total"' }, tool_response: '[graft] tokens saved ≈ 4,000' });
  await hook('stop', stopPayload(transcript));
  let s = readSession(dir, SESSION);
  assert.equal(s.graftTurns, 1);
  assert.equal(s.reportedTurns, 1);
  assert.equal(s.inputTokensBilled, 3_000, 'both responses of turn 1');
  const size1 = statSync(transcript).size;
  assert.equal(JSON.parse(readFileSync(cursorFile, 'utf8')).trace.offset, size1, 'the cursor sits at the end of what was read');

  // Turn 2: graft again, no tally this time.
  appendFileSync(transcript, jsonl([
    typed('and the tax?'),
    reply('a3', 'msg_3', graftCall('toolu_2'), 500),
    toolResult('toolu_2', 'src/tax.ts:4 rate()\n[graft] tokens saved ≈ 900'),
    reply('a4', 'msg_4', text('Tax comes from src/tax.ts.'), 600),
  ]));
  await hook('tool-savings', { session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'trail ask "tax"' }, tool_response: '[graft] tokens saved ≈ 900' });
  await hook('stop', stopPayload(transcript));
  s = readSession(dir, SESSION);
  assert.equal(s.graftTurns, 2);
  assert.equal(s.reportedTurns, 1, 'turn 2 said nothing about it');
  assert.equal(s.inputTokensBilled, 4_100, 'turn 1 is not billed again');

  // Turn 3: no graft; one response whose second block lands after this Stop.
  appendFileSync(transcript, jsonl([typed('thanks, run the tests'), reply('a5', 'msg_5', { type: 'thinking', thinking: 'Run them.', signature: 'c2ln' }, 700)]));
  await hook('stop', stopPayload(transcript));
  appendFileSync(transcript, jsonl([reply('a6', 'msg_5', text('All tests pass.'), 700)]));
  await hook('stop', stopPayload(transcript));
  s = readSession(dir, SESSION);
  assert.equal(s.graftTurns, 2, 'a turn without graft is not counted');
  assert.equal(s.inputTokensBilled, 4_800, 'msg_5 billed once though its lines came in two reads');
  assert.equal(JSON.parse(readFileSync(cursorFile, 'utf8')).trace.offset, statSync(transcript).size);
});

test('the cursor file is private and holds no words from the transcript', async () => {
  const { transcript } = setup();
  writeFileSync(transcript, jsonl([typed('the quokka migration plan'), reply('a1', 'msg_1', text('Here is the quokka plan.'))]));
  await hook('stop', stopPayload(transcript));
  const file = hookCursorPath(SESSION);
  assert.ok(file.endsWith(`${SESSION}.hooks.json`));
  const raw = readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /quokka/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(join(process.env.TRAIL_HOME!, 'sessions', `${SESSION}.json`)), false, "the skills catch-up's cursor file is left alone");
});

test("a reply whose last words aren't on disk yet still counts the tally from the Stop payload", async () => {
  const { dir, transcript } = setup();
  writeFileSync(transcript, jsonl([typed('where is the cart total computed'), reply('a1', 'msg_1', graftCall('toolu_1')), toolResult('toolu_1', '[graft] tokens saved ≈ 4,000')]));
  await hook('tool-savings', { session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'trail ask "cart"' }, tool_response: '[graft] tokens saved ≈ 4,000' });
  await hook('stop', stopPayload(transcript, { last_assistant_message: 'It is in src/cart.ts. 🌱 graft saved ~4,000 tokens this turn' }));
  const s = readSession(dir, SESSION);
  assert.equal(s.graftTurns, 1);
  assert.equal(s.reportedTurns, 1);
});

test('Cursor and Copilot payloads on the Claude hooks never have their transcript read as Claude’s', async () => {
  const { dir, transcript } = setup();
  writeFileSync(transcript, jsonl([typed('where is the cart total computed'), reply('a1', 'msg_1', text('🌱 graft saved ~4,000 tokens this turn'))]));
  const cursorShape = { conversation_id: SESSION, generation_id: 'g1', cursor_version: '1.7.0', workspace_roots: ['/home/dev/shop'], hook_event_name: 'stop', transcript_path: transcript };
  const copilotShape = { sessionId: SESSION, timestamp: 1760000000000, cwd: '/home/dev/shop', transcriptPath: transcript };
  for (const payload of [cursorShape, copilotShape]) {
    await hook('tool-savings', { ...payload, tool_response: '[graft] tokens saved ≈ 4,000' });
    await hook('stop', payload);
  }
  assert.equal(existsSync(hookCursorPath(SESSION)), false, 'nothing read, so no cursor');
  const s = readSession(dir, SESSION);
  assert.equal(s.inputTokensBilled, undefined, 'nothing billed');
  assert.equal(s.graftTurns, undefined, 'an unobservable turn is in neither total');
  assert.equal(s.turnUsedGraft, false, 'and its flag does not leak into the next turn');
});

/*
 * When the cursor can't be used (none yet, lost, or the transcript was
 * replaced, truncated or is another file under the same session id), the read
 * starts over near the end of the file. What it finds there was mostly billed
 * already: by an earlier read, or by a version from before the cursor that
 * kept `lastBillingUuid`. A read that starts over bills only the reply in
 * progress, and never a response an earlier read billed.
 */
const billedNow = (dir: string) => readSession(dir, SESSION).inputTokensBilled;

test('a session that began before the cursor existed is not billed twice for turns already billed', async () => {
  const { dir, transcript } = setup();
  const { writeSession } = await import('../src/claude/state.js');
  writeFileSync(transcript, jsonl([typed('first question'), reply('a1', 'msg_1', text('one'), 1_000)]));
  // An older version billed turn 1 at its Stop and kept the last reply's uuid.
  writeSession(dir, SESSION, { inputTokensBilled: 1_000, inputCostMicros: 3_000, lastBillingUuid: 'a1' });
  await hook('stop', stopPayload(transcript));
  assert.equal(billedNow(dir), 1_000, 'a repeated Stop on the turn the older version billed adds nothing');
  appendFileSync(transcript, jsonl([typed('second question'), reply('a2', 'msg_2', text('two'), 500)]));
  await hook('stop', stopPayload(transcript));
  assert.equal(billedNow(dir), 1_500, 'only turn 2 is new');
});

test('a first read with no cursor bills the reply in progress, not the turns before it', async () => {
  const { dir, transcript } = setup();
  writeFileSync(transcript, jsonl([typed('first question'), reply('a1', 'msg_1', text('one'), 1_000), typed('second question'), reply('a2', 'msg_2', text('two'), 500)]));
  await hook('stop', stopPayload(transcript));
  assert.equal(billedNow(dir), 500);
});

test('a lost cursor, a replaced or truncated transcript never bills a response twice', async () => {
  const restarts: Array<[string, (transcript: string) => void]> = [
    ['cursor lost', () => rmSync(hookCursorPath(SESSION))],
    ['transcript replaced', (t) => { const body = readFileSync(t, 'utf8'); rmSync(t); writeFileSync(t, body); }],
    ['transcript truncated', (t) => writeFileSync(t, jsonl([typed('second question'), reply('a2', 'msg_2', text('two'), 500)]))],
  ];
  for (const [what, restart] of restarts) {
    const { dir, transcript } = setup();
    writeFileSync(transcript, jsonl([typed('first question'), reply('a1', 'msg_1', text('one'), 1_000), typed('second question'), reply('a2', 'msg_2', text('two'), 500)]));
    rmSync(transcript);
    writeFileSync(transcript, jsonl([typed('first question'), reply('a1', 'msg_1', text('one'), 1_000)]));
    await hook('stop', stopPayload(transcript));
    appendFileSync(transcript, jsonl([typed('second question'), reply('a2', 'msg_2', text('two'), 500)]));
    await hook('stop', stopPayload(transcript));
    assert.equal(billedNow(dir), 1_500, `${what}: before`);
    restart(transcript);
    await hook('stop', stopPayload(transcript));
    assert.equal(billedNow(dir), 1_500, `${what}: nothing billed twice`);
    appendFileSync(transcript, jsonl([typed('third question'), reply('a3', 'msg_3', text('three'), 250)]));
    await hook('stop', stopPayload(transcript));
    assert.equal(billedNow(dir), 1_750, `${what}: the next turn still billed`);
  }
});

test('one session id on two transcript files, Stops alternating, bills each response once', async () => {
  const { dir, transcript } = setup();
  const other = transcript.replace(/\.jsonl$/, '-copy.jsonl');
  const lines = jsonl([typed('first question'), reply('a1', 'msg_1', text('one'), 1_000)]);
  writeFileSync(transcript, lines);
  writeFileSync(other, lines);
  for (let i = 0; i < 3; i++) {
    await hook('stop', stopPayload(transcript));
    await hook('stop', stopPayload(other));
  }
  assert.equal(billedNow(dir), 1_000);
});

test('usage that is negative or out of range is billed as nothing, so totals never go negative', async () => {
  const { dir, transcript } = setup();
  const absurd = '{"type":"assistant","uuid":"a2","message":{"id":"msg_2","model":"claude-sonnet-5-5","content":[{"type":"text","text":"two"}],"usage":{"input_tokens":1e400}}}\n';
  writeFileSync(transcript, jsonl([typed('first question'), reply('a1', 'msg_1', text('one'), -5_000)]) + absurd + jsonl([reply('a3', 'msg_3', text('three'), 6_000)]));
  await hook('stop', stopPayload(transcript));
  const s = readSession(dir, SESSION);
  assert.equal(s.inputTokensBilled, 6_000);
  assert.ok(Number.isFinite(s.inputCostMicros) && s.inputCostMicros! > 0, `cost ${s.inputCostMicros}`);
});

test("Copilot's snake_case payload (an ISO timestamp, its transcript anywhere) is never read as Claude Code's", async () => {
  const { dir, transcript } = setup();
  writeFileSync(transcript, jsonl([typed('where is the cart total computed'), reply('a1', 'msg_1', text('🌱 graft saved ~4,000 tokens this turn'))]));
  const vscodeMode = { hook_event_name: 'Stop', session_id: SESSION, timestamp: '2026-10-15T10:00:00Z', cwd: '/home/dev/shop', transcript_path: transcript, stop_hook_active: false };
  await hook('stop', vscodeMode);
  assert.equal(existsSync(hookCursorPath(SESSION)), false, 'nothing read, so no cursor');
  assert.equal(readSession(dir, SESSION).inputTokensBilled, undefined);
});
