/**
 * "Saved" vs "said": the turn-end check that measures whether the agent actually
 * told the user what graft saved. Its rules: judge only the reply since the
 * person's last prompt, read only what the transcript gained since the last
 * read, never count one reply twice, and count NEITHER total for a turn we
 * cannot observe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catchUpTranscript, hasSavingsTally } from '../src/claude/tally.js';
import { main } from '../src/claude/hooks.js';
import { readSession, writeSession } from '../src/claude/state.js';

test('hasSavingsTally accepts the phrasings agents actually write', () => {
  for (const yes of [
    '🌱 graft saved ~12,400 tokens this turn (3 calls)',
    'graft saved ~12k tokens this turn',
    'Graft saved 8,100 tokens across 2 calls.',
    'graft saved ≈ 900 tok this turn',
  ]) assert.equal(hasSavingsTally(yes), true, yes);
});

test('hasSavingsTally is not tripped by ordinary prose about graft', () => {
  for (const no of [
    'I used graft to find the call sites.',
    'graft saved me a lot of time here',           // no number, no unit
    'The 3 calls to graft returned 8 hits each.',
    '',
  ]) assert.equal(hasSavingsTally(no), false, no);
});

/** A transcript line as Claude Code writes it. */
function assistant(uuid: string, text: string): string {
  return JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}
function userPrompt(text: string): string {
  return JSON.stringify({ type: 'user', uuid: `u-${text}`, origin: { kind: 'human' }, message: { role: 'user', content: text } });
}
function toolResult(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
}
function transcript(lines: string[]): string {
  const p = join(mkdtempSync(join(tmpdir(), 'graft-tally-')), 'session.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
/** A fresh cursor file, as `<id>.hooks.json` would be. */
function cursor(): string {
  return join(mkdtempSync(join(tmpdir(), 'graft-tally-cursor-')), 's.hooks.json');
}
/** The open reply after reading `lines` from the top. */
function turnOf(lines: string[]) {
  const r = catchUpTranscript(transcript(lines), cursor());
  return r.fresh ? r.turn : null;
}

test('the whole reply since the typed prompt is read, not just its final text block', () => {
  const turn = turnOf([
    userPrompt('older question'),
    assistant('a1', 'no tally in this earlier turn'),
    userPrompt('how does auth work'),
    assistant('a2', '🌱 graft saved ~5,000 tokens this turn'),
    toolResult('[graft] tokens saved ≈ 1,000'),
    assistant('a3', 'Done.'),
  ])!;
  assert.equal(turn.uuid, 'a3', 'uuid is the last assistant entry of the turn');
  assert.equal(turn.tally, true, 'a tally in an earlier block of the same turn still counts');
});

test('the previous turn is not read into this one', () => {
  const turn = turnOf([userPrompt('first'), assistant('a1', '🌱 graft saved ~9,000 tokens this turn'), userPrompt('second'), assistant('a2', 'Nothing to report.')])!;
  assert.equal(turn.tally, false);
});

test('only what the person typed starts a turn: a task notice, a command wrapper or a compaction summary does not', () => {
  const notice = JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' } });
  const wrapper = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/review</command-name>' } });
  const summary = JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } });
  for (const row of [notice, wrapper, summary]) {
    const turn = turnOf([userPrompt('how does auth work'), assistant('a1', '🌱 graft saved ~5,000 tokens this turn'), row, assistant('a2', 'Done.')])!;
    assert.equal(turn.tally, true, `not a new turn: ${row.slice(0, 60)}`);
    assert.equal(turn.uuid, 'a2');
  }
});

test('a subagent’s prose is never what the user read', () => {
  const turn = turnOf([
    userPrompt('go'),
    JSON.stringify({ type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '🌱 graft saved ~4,000 tokens this turn' }] } }),
    assistant('a1', 'The subagent finished.'),
  ])!;
  assert.equal(turn.tally, false);
});

test('an unobservable turn reads as nothing new rather than a false negative', () => {
  assert.equal(catchUpTranscript('/nope/missing.jsonl', cursor()).fresh, false, 'unreadable file');
  assert.equal(turnOf([userPrompt('go')])!.uuid, null, 'no assistant prose yet');
  const c = cursor();
  const p = transcript([userPrompt('go'), assistant('a1', 'hi')]);
  assert.equal(catchUpTranscript(p, c).fresh, true);
  assert.equal(catchUpTranscript(p, c).fresh, false, 'read again with nothing appended: nothing new');
});

/* ---------------------------------------------------------------------- */
/* the hook path: tool-savings flags the turn, stop resolves it            */
/* ---------------------------------------------------------------------- */

async function runHook(event: string, stdin: object): Promise<void> {
  process.env.GRAFT_TEST_STDIN = JSON.stringify(stdin);
  try { await main(event); } finally { delete process.env.GRAFT_TEST_STDIN; }
}

function repo(): string {
  // The hooks' transcript cursor lives under the trail home: never the real one.
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'graft-tally-home-'));
  const d = mkdtempSync(join(tmpdir(), 'graft-tally-repo-'));
  mkdirSync(join(d, 'graft', '.cache', 'session'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = d;
  return d;
}

test('a graft turn that reports the tally counts in both totals', async () => {
  const d = repo();
  await runHook('tool-savings', { session_id: 's1', tool_response: '[graft] tokens saved ≈ 4,000' });
  assert.equal(readSession(d, 's1').turnUsedGraft, true, 'the turn is flagged as owing a tally');
  const p = transcript([userPrompt('how does auth work'), assistant('a1', '🌱 graft saved ~4,000 tokens this turn (1 call)')]);
  await runHook('stop', { session_id: 's1', transcript_path: p });
  const s = readSession(d, 's1');
  assert.equal(s.graftTurns, 1);
  assert.equal(s.reportedTurns, 1);
  assert.equal(s.turnUsedGraft, false, 'the flag is cleared so the next turn starts clean');
});

test('a silent graft turn counts in the denominator only', async () => {
  const d = repo();
  await runHook('tool-savings', { session_id: 's1', tool_response: '[graft] tokens saved ≈ 20,000' });
  const p = transcript([userPrompt('how does auth work'), assistant('a1', 'Auth is handled in src/auth.ts.')]);
  await runHook('stop', { session_id: 's1', transcript_path: p });
  const s = readSession(d, 's1');
  assert.equal(s.graftTurns, 1);
  assert.equal(s.reportedTurns ?? 0, 0, 'saved 20k, said nothing — that is the gap we ship');
});

test('a turn that never touched graft is not counted at all', async () => {
  const d = repo();
  const p = transcript([userPrompt('just chatting here'), assistant('a1', 'Sure.')]);
  await runHook('stop', { session_id: 's1', transcript_path: p });
  const s = readSession(d, 's1');
  assert.equal(s.graftTurns, undefined);
  assert.equal(s.reportedTurns, undefined);
});

test('a second Stop on the same reply does not count the turn twice', async () => {
  const d = repo();
  const p = transcript([userPrompt('how does auth work'), assistant('a1', '🌱 graft saved ~4,000 tokens this turn')]);
  await runHook('tool-savings', { session_id: 's1', tool_response: '[graft] tokens saved ≈ 4,000' });
  await runHook('stop', { session_id: 's1', transcript_path: p });
  // The flag is re-set (another graft call), but the reply on disk is unchanged.
  await runHook('tool-savings', { session_id: 's1', tool_response: '[graft] tokens saved ≈ 4,000' });
  await runHook('stop', { session_id: 's1', transcript_path: p });
  const s = readSession(d, 's1');
  assert.equal(s.graftTurns, 1, 'one reply is one turn, however often Stop fires');
  assert.equal(s.reportedTurns, 1);
});

test('a turn whose reply cannot be read is dropped from both totals', async () => {
  const d = repo();
  await runHook('tool-savings', { session_id: 's1', tool_response: '[graft] tokens saved ≈ 4,000' });
  await runHook('stop', { session_id: 's1' }); // no transcript_path — a Codex-shaped Stop
  const s = readSession(d, 's1');
  assert.equal(s.graftTurns, undefined, 'an unobservable turn must not deflate the ratio');
  assert.equal(s.turnUsedGraft, false, 'but the flag is still cleared, so it cannot leak forward');
});

test('a pre-existing session file with none of these fields still parses', async () => {
  const d = repo();
  writeSession(d, 's1', { graftReads: 3, sourceReads: 1, savedTokens: 900 });
  await runHook('tool-savings', { session_id: 's1', tool_response: '[graft] tokens saved ≈ 100' });
  const p = transcript([userPrompt('how does auth work'), assistant('a1', 'graft saved ~1,000 tokens this turn')]);
  await runHook('stop', { session_id: 's1', transcript_path: p });
  const s = readSession(d, 's1');
  assert.equal(s.savedTokens, 1000, 'the existing counter is preserved');
  assert.equal(s.graftTurns, 1);
});

/** An assistant entry carrying usage, as Claude Code writes it: one API
 * response is split across several lines that all repeat the same `message.id`
 * and the same `usage`. */
function billed(
  uuid: string,
  msgId: string,
  part: unknown,
  usage: { input: number; cacheCreate: number; cacheRead: number },
  model = 'claude-opus-5',
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      id: msgId,
      model,
      content: [part],
      usage: {
        input_tokens: usage.input,
        cache_creation_input_tokens: usage.cacheCreate,
        cache_read_input_tokens: usage.cacheRead,
        output_tokens: 100,
      },
    },
  });
}

test('billing: one API response split across lines is billed once', () => {
  // The trap this exists for: Claude Code writes a thinking block and a tool_use
  // block of the SAME response as two entries, each repeating the same usage.
  // Summing lines would bill this turn twice and halve every dollar figure.
  const usage = { input: 10, cacheCreate: 1_000, cacheRead: 100_000 };
  const b = catchUpTranscript(transcript([
    userPrompt('a question'),
    billed('a1', 'msg_1', { type: 'thinking', thinking: '...' }, usage),
    billed('a2', 'msg_1', { type: 'tool_use', name: 'Bash', input: {} }, usage),
  ]), cursor());
  assert.equal(b.tokens, 101_010, 'the response is counted once, not twice');
  // 10 fresh + 1,000 written at 1.25x + 100,000 read at 0.1x, at $5/Mtok.
  assert.equal(b.costMicros, Math.round((10 + 1_250 + 10_000) * 5));
});

test('billing: distinct responses are summed', () => {
  const b = catchUpTranscript(transcript([
    userPrompt('a question'),
    billed('a1', 'msg_1', { type: 'text', text: 'first' }, { input: 100, cacheCreate: 0, cacheRead: 0 }),
    billed('a2', 'msg_2', { type: 'text', text: 'second' }, { input: 200, cacheCreate: 0, cacheRead: 0 }),
  ]), cursor());
  assert.equal(b.tokens, 300);
});

test('billing: a response billed by an earlier read is never billed again, even when its lines straddle two reads', () => {
  const c = cursor();
  const p = transcript([userPrompt('older question'), billed('a1', 'msg_1', { type: 'text', text: 'old' }, { input: 9_999, cacheCreate: 0, cacheRead: 0 })]);
  assert.equal(catchUpTranscript(p, c).tokens, 9_999);
  appendFileSync(p, [userPrompt('current question'), billed('a2', 'msg_2', { type: 'thinking', thinking: '...' }, { input: 100, cacheCreate: 0, cacheRead: 0 })].join('\n') + '\n');
  assert.equal(catchUpTranscript(p, c).tokens, 100, 'only the new response');
  appendFileSync(p, billed('a3', 'msg_2', { type: 'text', text: 'new' }, { input: 100, cacheCreate: 0, cacheRead: 0 }) + '\n');
  const third = catchUpTranscript(p, c);
  assert.equal(third.tokens, 0, 'the rest of msg_2 arrived later: still billed once');
  assert.equal(third.turn.uuid, 'a3');
});

test('billing: an unpriced model is left out of the rate entirely', () => {
  // Not zero-cost — absent. Keeping its tokens in the denominator with no cost
  // in the numerator would drag the blended rate toward zero and quietly
  // under-report every saving after it.
  const b = catchUpTranscript(transcript([
    userPrompt('a question'),
    billed('a1', 'msg_1', { type: 'text', text: 'x' }, { input: 500, cacheCreate: 0, cacheRead: 0 }, 'some-future-model'),
    billed('a2', 'msg_2', { type: 'text', text: 'y' }, { input: 100, cacheCreate: 0, cacheRead: 0 }),
  ]), cursor());
  assert.equal(b.tokens, 100);
});

test('billing: nothing to bill when no entry carries usage, and a subagent is never billed', () => {
  const none = catchUpTranscript(transcript([userPrompt('q'), assistant('a1', 'a reply with no usage recorded')]), cursor());
  assert.equal(none.tokens, 0);
  assert.equal(none.costMicros, 0);
  const side = JSON.stringify({ ...JSON.parse(billed('s1', 'msg_9', { type: 'text', text: 'sub' }, { input: 700, cacheCreate: 0, cacheRead: 0 })), isSidechain: true });
  assert.equal(catchUpTranscript(transcript([userPrompt('q'), side]), cursor()).tokens, 0);
});
