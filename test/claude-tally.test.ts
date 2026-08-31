/**
 * "Saved" vs "said": the turn-end check that measures whether the agent actually
 * told the user what graft saved. Its rules: read only the last turn, never
 * count one reply twice, and count NEITHER total for a turn we cannot observe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSavingsTally, lastAssistantTurn } from '../src/claude/tally.js';
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
  return JSON.stringify({ type: 'user', uuid: `u-${text}`, message: { role: 'user', content: text } });
}
function toolResult(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
}
function transcript(lines: string[]): string {
  const p = join(mkdtempSync(join(tmpdir(), 'graft-tally-')), 'session.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('the whole last turn is read, not just its final text block', () => {
  const p = transcript([
    userPrompt('older question'),
    assistant('a1', 'no tally in this earlier turn'),
    userPrompt('how does auth work'),
    assistant('a2', '🌱 graft saved ~5,000 tokens this turn'),
    toolResult('[graft] tokens saved ≈ 1,000'),
    assistant('a3', 'Done.'),
  ]);
  const turn = lastAssistantTurn(p)!;
  assert.equal(turn.uuid, 'a3', 'uuid is the last assistant entry of the turn');
  assert.equal(hasSavingsTally(turn.text), true, 'a tally in an earlier block of the same turn still counts');
});

test('the previous turn is not read into this one', () => {
  const p = transcript([
    userPrompt('first'),
    assistant('a1', '🌱 graft saved ~9,000 tokens this turn'),
    userPrompt('second'),
    assistant('a2', 'Nothing to report.'),
  ]);
  const turn = lastAssistantTurn(p)!;
  assert.equal(hasSavingsTally(turn.text), false);
});

test('a subagent’s prose is never what the user read', () => {
  const p = transcript([
    userPrompt('go'),
    JSON.stringify({ type: 'assistant', uuid: 's1', isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: '🌱 graft saved ~4,000 tokens this turn' }] } }),
    assistant('a1', 'The subagent finished.'),
  ]);
  assert.equal(hasSavingsTally(lastAssistantTurn(p)!.text), false);
});

test('an unobservable turn yields null rather than a false negative', () => {
  assert.equal(lastAssistantTurn(undefined), null, 'no transcript_path (e.g. Codex)');
  assert.equal(lastAssistantTurn('/nope/missing.jsonl'), null, 'unreadable file');
  assert.equal(lastAssistantTurn(transcript([userPrompt('go')])), null, 'no assistant prose yet');
});

/* ---------------------------------------------------------------------- */
/* the hook path: tool-savings flags the turn, stop resolves it            */
/* ---------------------------------------------------------------------- */

async function runHook(event: string, stdin: object): Promise<void> {
  process.env.GRAFT_TEST_STDIN = JSON.stringify(stdin);
  try { await main(event); } finally { delete process.env.GRAFT_TEST_STDIN; }
}

function repo(): string {
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
  writeSession(d, 's1', { lastQuery: null, perAgentQuery: {}, graftReads: 3, sourceReads: 1, savedTokens: 900 });
  await runHook('tool-savings', { session_id: 's1', tool_response: '[graft] tokens saved ≈ 100' });
  const p = transcript([userPrompt('how does auth work'), assistant('a1', 'graft saved ~1,000 tokens this turn')]);
  await runHook('stop', { session_id: 's1', transcript_path: p });
  const s = readSession(d, 's1');
  assert.equal(s.savedTokens, 1000, 'the existing counter is preserved');
  assert.equal(s.graftTurns, 1);
});
