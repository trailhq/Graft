/**
 * The session rollup — the event that answers "did the agent prefer graft to
 * grep". Its rules: only closed sessions, only once each, and only buckets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_IDLE_MS, flushClosedSessions, summarizeSession } from '../src/telemetry/sessions.js';
import { peek } from '../src/telemetry/queue.js';
import { readSession } from '../src/claude/state.js';
import { tmpRepo } from './helpers.js';

const OPEN: NodeJS.ProcessEnv = {};

function fixture(tag: string): { repo: string; home: string } {
  const repo = tmpRepo(tag);
  const home = tmpRepo(`${tag}-home`);
  mkdirSync(join(home, '.graft'), { recursive: true });
  mkdirSync(join(repo, 'graft', '.cache', 'session'), { recursive: true });
  process.env.GRAFT_POSTHOG_KEY = 'phc_test_key';
  return { repo, home };
}

function writeSessionFile(repo: string, id: string, body: object, ageMs: number): void {
  const path = join(repo, 'graft', '.cache', 'session', `${id}.json`);
  writeFileSync(path, JSON.stringify(body));
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

test('a closed session is rolled up into one bucketed event', () => {
  const { repo, home } = fixture('sess-closed');
  writeSessionFile(repo, 's1', { graftReads: 56, sourceReads: 12, savedTokens: 7400 }, SESSION_IDLE_MS + 1000);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 1);
  const [ev] = peek(home) as { event: string; properties: Record<string, string> }[];
  assert.equal(ev.event, 'session_summary');
  assert.equal(ev.properties.graft_reads_bucket, '50-199');
  assert.equal(ev.properties.source_reads_bucket, '5-19');
  assert.equal(ev.properties.saved_tokens_bucket, '5-20k');
  // The raw counters must not ride along. Checked against the property VALUES,
  // not a substring of the serialised event: the event carries two random UUIDs,
  // and '56' is two hex digits — a substring check here fails whenever a uuid
  // happens to contain them, which is often.
  const values = Object.values(ev.properties);
  for (const raw of ['56', '12', '7400']) {
    assert.equal(values.includes(raw), false, `the raw counter ${raw} was sent as a property value`);
  }
});

test('the rollup is attributed to the host that flushed it (Cursor, not the hardcoded default)', () => {
  const { repo, home } = fixture('sess-host');
  writeSessionFile(repo, 's1', { graftReads: 4, sourceReads: 1 }, SESSION_IDLE_MS + 1000);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN, 'cursor'), 1);
  const [ev] = peek(home) as { properties: Record<string, string> }[];
  assert.equal(ev.properties.agent_host, 'cursor');
});

test('the default host stays claude-code when none is passed', () => {
  const { repo, home } = fixture('sess-host-default');
  writeSessionFile(repo, 's1', { graftReads: 1 }, SESSION_IDLE_MS + 1000);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 1);
  const [ev] = peek(home) as { properties: Record<string, string> }[];
  assert.equal(ev.properties.agent_host, 'claude-code');
});

test('a session stamped with a host is attributed to it, even when the idle sweep (claude-code default) flushes it', () => {
  const { repo, home } = fixture('sess-host-stamp');
  writeSessionFile(repo, 's1', { graftReads: 4, host: 'cursor' }, SESSION_IDLE_MS + 1000);
  // the flusher passes no host → default claude-code; the file's stamp must win.
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 1);
  const [ev] = peek(home) as { properties: Record<string, string> }[];
  assert.equal(ev.properties.agent_host, 'cursor');
});

test('summarizeSession force-closes a just-touched session — the idle gate is skipped', () => {
  const { repo, home } = fixture('sess-force');
  // mtime = now: flushClosedSessions would skip this, but the end-of-session hook must not.
  writeSessionFile(repo, 's1', { graftReads: 8, sourceReads: 2, savedTokens: 7400 }, 0);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 0, 'the idle sweep skips a fresh file');
  assert.equal(summarizeSession(repo, 's1', { host: 'cursor', home, env: OPEN }), 1);
  const [ev] = peek(home) as { event: string; properties: Record<string, string> }[];
  assert.equal(ev.event, 'session_summary');
  assert.equal(ev.properties.agent_host, 'cursor');
  assert.equal(ev.properties.graft_reads_bucket, '5-19');
  // and it is marked, so a later idle sweep can't double-count it
  assert.equal(readSession(repo, 's1').summarized, true);
});

test('summarizeSession counts a session exactly once', () => {
  const { repo, home } = fixture('sess-force-once');
  writeSessionFile(repo, 's1', { graftReads: 1 }, 0);
  assert.equal(summarizeSession(repo, 's1', { host: 'cursor', home, env: OPEN }), 1);
  assert.equal(summarizeSession(repo, 's1', { host: 'cursor', home, env: OPEN }), 0, 'already summarized');
  assert.equal(peek(home).length, 1);
});

test('summarizeSession prefers the file stamp over the passed host', () => {
  const { repo, home } = fixture('sess-force-stamp');
  writeSessionFile(repo, 's1', { graftReads: 1, host: 'cursor' }, 0);
  assert.equal(summarizeSession(repo, 's1', { host: 'claude-code', home, env: OPEN }), 1);
  const [ev] = peek(home) as { properties: Record<string, string> }[];
  assert.equal(ev.properties.agent_host, 'cursor');
});

test('a live session is left alone', () => {
  const { repo, home } = fixture('sess-live');
  writeSessionFile(repo, 's1', { graftReads: 3 }, 60_000);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 0);
  assert.deepEqual(peek(home), []);
});

test('a session is counted exactly once, however often the hook runs', () => {
  const { repo, home } = fixture('sess-once');
  writeSessionFile(repo, 's1', { graftReads: 3 }, SESSION_IDLE_MS + 1000);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 1);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 0);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 0);
  assert.equal(peek(home).length, 1);
});

test('the rollup marks the file instead of deleting it, so a resumed session keeps its state', () => {
  const { repo, home } = fixture('sess-keep');
  writeSessionFile(repo, 's1', { graftReads: 3, lastQuery: 'how does auth work', injectedPointers: ['a.ts'] }, SESSION_IDLE_MS + 1000);
  flushClosedSessions(repo, Date.now(), home, OPEN);
  const s = readSession(repo, 's1');
  assert.equal(s.summarized, true);
  assert.equal(s.lastQuery, 'how does auth work');
  assert.deepEqual(s.injectedPointers, ['a.ts']);
});

test('the query text never reaches the event', () => {
  const { repo, home } = fixture('sess-noquery');
  writeSessionFile(repo, 's1', { graftReads: 1, lastQuery: 'where is the private key loaded' }, SESSION_IDLE_MS + 1000);
  flushClosedSessions(repo, Date.now(), home, OPEN);
  assert.equal(JSON.stringify(peek(home)).includes('private key'), false);
});

test('a repo with no sessions is a no-op', () => {
  const repo = tmpRepo('sess-none');
  const home = tmpRepo('sess-none-home');
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 0);
});

test('an empty session still counts — installed but unused is the signal we want', () => {
  const { repo, home } = fixture('sess-empty');
  writeSessionFile(repo, 's1', { graftReads: 0, sourceReads: 0, savedTokens: 0 }, SESSION_IDLE_MS + 1000);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 1);
  const [ev] = peek(home) as { properties: Record<string, string> }[];
  assert.equal(ev.properties.graft_reads_bucket, '0');
});

test('the saved-vs-said turn counts ride along, bucketed', () => {
  const { repo, home } = fixture('sess-tally');
  writeSessionFile(repo, 's1',
    { graftReads: 6, sourceReads: 1, savedTokens: 7400, graftTurns: 9, reportedTurns: 3 },
    SESSION_IDLE_MS + 1000);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 1);
  const [ev] = peek(home) as { properties: Record<string, string> }[];
  assert.equal(ev.properties.graft_turns_bucket, '5-19');
  assert.equal(ev.properties.reported_turns_bucket, '1-4');
  const values = Object.values(ev.properties);
  for (const raw of ['9', '3']) {
    assert.equal(values.includes(raw), false, `the raw turn count ${raw} was sent as a property value`);
  }
});

test('a session file written before the turn counters exist reports zero, not undefined', () => {
  const { repo, home } = fixture('sess-tally-old');
  writeSessionFile(repo, 's1', { graftReads: 4, sourceReads: 0, savedTokens: 500 }, SESSION_IDLE_MS + 1000);
  assert.equal(flushClosedSessions(repo, Date.now(), home, OPEN), 1);
  const [ev] = peek(home) as { properties: Record<string, string> }[];
  assert.equal(ev.properties.graft_turns_bucket, '0');
  assert.equal(ev.properties.reported_turns_bucket, '0');
});
