/**
 * The queue: the reason no graft command ever waits on a socket. Its contract is
 * "append cheaply, drain exactly once, and never grow without bound".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_QUEUE_BYTES, drain, enqueue, peek, queuePath, requeue } from '../src/telemetry/queue.js';
import { shouldRequeue } from '../src/telemetry/flush.js';
import { tmpRepo } from './helpers.js';

function home(tag: string): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, '.graft'), { recursive: true });
  return dir;
}

test('enqueue then drain returns the events and leaves the queue empty', () => {
  const h = home('q-roundtrip');
  enqueue({ event: 'a' }, h);
  enqueue({ event: 'b' }, h);
  assert.deepEqual(drain(h), [{ event: 'a' }, { event: 'b' }]);
  assert.deepEqual(drain(h), [], 'a second drain finds nothing');
});

test('draining an empty or missing queue is not an error', () => {
  assert.deepEqual(drain(home('q-empty')), []);
});

test('peek reads without draining', () => {
  const h = home('q-peek');
  enqueue({ event: 'a' }, h);
  assert.equal(peek(h).length, 1);
  assert.equal(peek(h).length, 1);
  assert.equal(drain(h).length, 1);
});

test('a torn line costs one event, not the whole batch', () => {
  const h = home('q-torn');
  enqueue({ event: 'good1' }, h);
  appendFileSync(queuePath(h), '{"event":"tor\n'); // a crash mid-append
  enqueue({ event: 'good2' }, h);
  assert.deepEqual(drain(h), [{ event: 'good1' }, { event: 'good2' }]);
});

test('the cap drops the OLDEST events, keeping the recent ones', () => {
  const h = home('q-cap');
  // Big enough payloads to blow past MAX_QUEUE_BYTES well before the count cap.
  for (let i = 0; i < 900; i++) enqueue({ event: 'e', i, pad: 'x'.repeat(400) }, h);
  const raw = readFileSync(queuePath(h), 'utf8');
  const kept = drain(h) as { i: number }[];
  // Bytes are the bound — plus at most the one append that triggered the trim.
  // The event count is deliberately NOT asserted: trimming is size-triggered, so
  // between trims the file legitimately holds more than TRIM_TO_EVENTS lines.
  assert.ok(Buffer.byteLength(raw) <= MAX_QUEUE_BYTES + 1024, `queue was ${Buffer.byteLength(raw)} bytes`);
  assert.ok(kept.length < 900, `nothing was dropped: kept ${kept.length}`);
  assert.equal(kept.at(-1)?.i, 899, 'the newest event survives');
  assert.ok((kept[0]?.i ?? 0) > 0, 'the oldest events were the ones dropped');
});

test('the byte bound holds even for events far larger than average', () => {
  const h = home('q-cap-big');
  for (let i = 0; i < 200; i++) enqueue({ event: 'e', i, pad: 'x'.repeat(8000) }, h);
  const kept = drain(h);
  const bytes = kept.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
  assert.ok(bytes <= MAX_QUEUE_BYTES + 9000, `kept ${bytes} bytes in ${kept.length} events`);
});

test('requeue puts a failed batch back, ahead of anything queued since', () => {
  const h = home('q-requeue');
  const batch = drain(h);
  assert.deepEqual(batch, []);
  enqueue({ event: 'queued-after' }, h);
  requeue([{ event: 'failed-send' }], h);
  assert.deepEqual(drain(h), [{ event: 'failed-send' }, { event: 'queued-after' }]);
});

test('an unwritable home is silent, not fatal', () => {
  // A path whose parent is a FILE: mkdir must fail, and enqueue must not throw.
  const dir = tmpRepo('q-unwritable');
  writeFileSync(join(dir, 'blocker'), 'x');
  assert.doesNotThrow(() => enqueue({ event: 'a' }, join(dir, 'blocker')));
});

test('the queue file is newline-delimited JSON, one event per line', () => {
  const h = home('q-ndjson');
  enqueue({ event: 'a' }, h);
  enqueue({ event: 'b' }, h);
  const lines = readFileSync(queuePath(h), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

// --- what a failed flush does with the batch ---

test('a transport failure or a 5xx keeps the batch; a 4xx discards it', () => {
  // Ours to retry: the events are still good, the network or the server wasn't.
  assert.equal(shouldRequeue({ ok: false }), true, 'transport failure');
  assert.equal(shouldRequeue({ ok: false, status: 500 }), true);
  assert.equal(shouldRequeue({ ok: false, status: 503 }), true);
  // Never ours to retry: a bad key or a malformed batch fails the same way
  // forever, and retrying would pin the queue at its cap.
  assert.equal(shouldRequeue({ ok: false, status: 401 }), false, 'bad key');
  assert.equal(shouldRequeue({ ok: false, status: 400 }), false, 'malformed batch');
  assert.equal(shouldRequeue({ ok: true, status: 200 }), false);
});
