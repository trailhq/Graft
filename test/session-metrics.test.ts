import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyToolUse, commandInvokesGraft, isGraftMcpTool, isMcpToolName, recordToolUse, latestSession, formatSessionStats } from '../src/claude/session-metrics.js';
import { readSession } from '../src/claude/state.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-metrics-')); }

const CASES: Array<[string, string | undefined, 'graft' | 'source' | null]> = [
  ['graft_find_code', undefined, 'graft'], ['MCP:graft_find_code', undefined, 'graft'],
  ['mcp__graft__graft_find_code', undefined, 'graft'], ['graft_repo_map', undefined, 'graft'],
  ['Read', undefined, 'source'], ['Grep', undefined, 'source'], ['Glob', undefined, 'source'], ['Search', undefined, 'source'],
  ['Bash', 'graft ask "auth"', 'graft'], ['Shell', 'graft map', 'graft'],
  ['Shell', 'npx -y @nanonets/graft callers foo', 'graft'],
  ['Bash', 'node dist/cli.js grep bar', 'graft'], ['Bash', 'ls -la', null], ['Shell', 'git status', null],
  ['Bash', './mygraft/run.sh', null], ['mygraft_search', undefined, null],
  ['graft-adjacent-tool', undefined, null], ['some__graft__tool', undefined, null],
  ['Write', undefined, null], ['Edit', undefined, null], ['Task', undefined, null], ['', undefined, null],
];

test('classifies graft and source retrievals without inspecting output text', () => {
  for (const [name, command, expected] of CASES)
    assert.equal(classifyToolUse(name, command), expected, `${name} ${command ?? ''}`);
  assert.ok(isGraftMcpTool('mcp__graft__graft_trace_calls'));
  assert.ok(isGraftMcpTool('graft_ask'), 'a legacy alias still counts');
  assert.ok(!isGraftMcpTool('Read'));
  assert.ok(!isGraftMcpTool('mygraft_search'));
  assert.ok(!isGraftMcpTool('graft-adjacent-tool'));
  assert.ok(!isGraftMcpTool('mcp__other__graft_helper'));
  assert.ok(isMcpToolName('mcp__graft__graft_find_code'));
  assert.ok(!isMcpToolName('Read'));
  assert.ok(!isMcpToolName('Shell'));
  assert.ok(commandInvokesGraft('cd repo && graft map'));
  assert.ok(!commandInvokesGraft('cat mygraft.txt'));
  assert.ok(!commandInvokesGraft('echo upgraft'));
});

test('recordToolUse retains graft-vs-source diagnostics without savings parsing', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'graft', host: 'cursor' });
  recordToolUse(d, 's1', { kind: 'graft' });
  recordToolUse(d, 's1', { kind: 'source' });
  const s = readSession(d, 's1');
  assert.equal(s.graftReads, 2);
  assert.equal(s.sourceReads, 1);
  assert.equal(s.host, 'cursor');
  assert.equal('savedTokens' in s, false);
});

test('recordToolUse is a no-op when there is nothing to record', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: null });
  recordToolUse(d, 's1', {});
  const s = readSession(d, 's1');
  assert.equal(s.graftReads, 0);
  assert.equal(s.sourceReads, 0);
});

test('recordToolUse stamps the host once — later uses do not overwrite', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'graft', host: 'cursor' });
  recordToolUse(d, 's1', { kind: 'source', host: 'claude-code' });
  assert.equal(readSession(d, 's1').host, 'cursor');
});

test('formatSessionStats reports usage mix, not token or dollar savings', () => {
  const out = formatSessionStats({ id: 'abc', lastQuery: 'where is auth', perAgentQuery: {}, graftReads: 8, sourceReads: 2 });
  assert.match(out, /session abc/);
  assert.match(out, /graft reads:\s+8/);
  assert.match(out, /source reads:\s+2/);
  assert.match(out, /80% graft/);
  assert.match(out, /where is auth/);
  assert.doesNotMatch(out, /saved|\$/i);
});

test('formatSessionStats has a friendly empty state', () => {
  assert.match(formatSessionStats(null), /no session recorded yet/);
});

function writeSession(d: string, id: string, body: object, ageMs = 0): void {
  const dir = join(d, 'graft', '.cache', 'session');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify(body));
  if (ageMs) { const when = new Date(Date.now() - ageMs); utimesSync(path, when, when); }
}

test('latestSession returns the most recently touched session', () => {
  const d = fresh();
  assert.equal(latestSession(d), null);
  writeSession(d, 'old', { graftReads: 1, sourceReads: 9 }, 60_000);
  writeSession(d, 'new', { graftReads: 8, sourceReads: 2 });
  const s = latestSession(d)!;
  assert.equal(s.id, 'new');
  assert.equal(s.graftReads, 8);
});
