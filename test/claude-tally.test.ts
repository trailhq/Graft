import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastTurnBilling } from '../src/claude/tally.js';

function transcript(lines: object[]): string {
  const p = join(mkdtempSync(join(tmpdir(), 'graft-billing-')), 'session.jsonl');
  writeFileSync(p, `${lines.map(JSON.stringify).join('\n')}\n`);
  return p;
}
function user(): object { return { type: 'user', message: { role: 'user', content: 'question' } }; }
function billed(uuid: string, id: string, input: number, cacheCreate = 0, cacheRead = 0, model = 'claude-opus-5'): object {
  return { type: 'assistant', uuid, message: { role: 'assistant', id, model, content: [], usage: {
    input_tokens: input, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead } } };
}

test('lastTurnBilling deduplicates repeated fragments of one response', () => {
  const b = lastTurnBilling(transcript([user(), billed('a1', 'm1', 100), billed('a2', 'm1', 100)]))!;
  assert.equal(b.tokens, 100);
  assert.equal(b.uuid, 'a2');
});

test('lastTurnBilling only examines the final user turn', () => {
  const p = transcript([user(), billed('a1', 'old', 999), user(), billed('a2', 'new', 100)]);
  assert.equal(lastTurnBilling(p)!.tokens, 100);
});

test('lastTurnBilling sums distinct responses and applies cache pricing', () => {
  const b = lastTurnBilling(transcript([user(), billed('a1', 'm1', 10, 1_000, 100_000), billed('a2', 'm2', 200)]))!;
  assert.equal(b.tokens, 101_210);
  assert.equal(b.costMicros, Math.round((10 + 1_250 + 10_000 + 200) * 5));
});

test('lastTurnBilling ignores unpriced models and missing transcripts', () => {
  assert.equal(lastTurnBilling(undefined), null);
  const b = lastTurnBilling(transcript([user(), billed('a1', 'old', 500, 0, 0, 'future-model'), billed('a2', 'new', 100)]))!;
  assert.equal(b.tokens, 100);
});
