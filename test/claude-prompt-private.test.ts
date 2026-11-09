/**
 * What the person types stays theirs: the prompt hook keeps counts, never the
 * prompt, and hands the prompt to its `ask` child on stdin, where `ps` can't
 * read it. Session files an older version wrote with the prompt in them lose
 * it at the next session start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/claude/hooks.js';
import { dropStoredPrompts, readSession, sessionDir, writeSession } from '../src/claude/state.js';
import { formatSessionStats } from '../src/claude/session-metrics.js';
import { renderSubagent } from '../src/claude/format.js';
import { buildGraph } from '../src/graph/build.js';
import { tmpRepo } from './helpers.js';

const PROMPT = 'how does the quokka ledger rotate its signing keys';

/** Every file under `dir` whose text contains `needle`. */
function filesWith(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (readFileSync(path, 'utf8').includes(needle)) hits.push(path);
  }
  return hits;
}

/**
 * A stand-in for the `ask` child, kept outside the repo: it records its argv
 * and its stdin, and answers with one hit so the hook has something to keep.
 */
function askStub(): { stub: string; seen: () => { argv: string[]; stdin: string } } {
  const at = mkdtempSync(join(tmpdir(), 'prompt-private-stub-'));
  const stub = join(at, 'ask-stub.cjs');
  const record = join(at, 'seen.json');
  writeFileSync(stub, [
    "const fs = require('fs');",
    'let stdin = "";',
    "try { stdin = fs.readFileSync(0, 'utf8'); } catch {}",
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));`,
    "process.stdout.write(JSON.stringify({ query: stdin, mode: 'lexical', coverage: 1, hits: [{ name: 'rotateKeys', pointer: 'src/ledger.ts:L10-L40', score: 9, kind: 'function' }] }));",
  ].join('\n'));
  return { stub, seen: () => JSON.parse(readFileSync(record, 'utf8')) };
}

async function runPrompt(dir: string, stub: string, text: string): Promise<void> {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? true : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.CLAUDE_PROJECT_DIR = dir;
  process.env.GRAFT_TEST_CLI = stub;
  process.env.GRAFT_TEST_STDIN = JSON.stringify({ session_id: 's1', prompt: text, agent: { name: 'Explore' } });
  const saved = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = join(dir, 'trail-home');
  try {
    await main('prompt');
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
    delete process.env.GRAFT_TEST_CLI;
    delete process.env.CLAUDE_PROJECT_DIR;
    if (saved === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = saved;
  }
}

test('the prompt hook keeps a count of what it asked, never the prompt', async () => {
  const dir = tmpRepo('prompt-private');
  const { stub } = askStub();
  await runPrompt(dir, stub, PROMPT);
  await runPrompt(dir, stub, 'and where are the quokka keys stored afterwards');
  const s = readSession(dir, 's1');
  assert.equal(s.promptAsks, 2);
  assert.deepEqual(filesWith(dir, 'quokka'), [], 'no word of the prompt on disk');
});

test('the ask child gets the prompt on stdin, never in its argv', async () => {
  const dir = tmpRepo('prompt-stdin');
  const { stub, seen } = askStub();
  await runPrompt(dir, stub, PROMPT);
  const { argv, stdin } = seen();
  assert.equal(stdin, PROMPT);
  assert.ok(!argv.some((a) => a.includes('quokka')), `argv: ${JSON.stringify(argv)}`);
  assert.deepEqual(argv.slice(0, 2), ['ask', '-']);
});

test('`ask -` reads the question from stdin', async () => {
  const dir = tmpRepo('ask-stdin');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'ledger.ts'), 'export function rotateSigningKeys(ledger: string): string {\n  return ledger + " rotated";\n}\n');
  await buildGraph(dir);
  // A Trail home of its own: the ask reads the repo index and its folder there, never the real ~/.trail.
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'ask', '-', dir, '--json', '--no-refresh'], {
    input: PROMPT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, TRAIL_HOME: join(dir, '.trail-home') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).query, PROMPT);
});

test('stats show how many prompts were asked about, not what was typed', () => {
  const out = formatSessionStats({ id: 'abc', graftReads: 8, sourceReads: 2, savedTokens: 0, promptAsks: 3 });
  assert.match(out, /prompts asked:\s+3/);
  assert.doesNotMatch(out, /last query/);
  assert.doesNotMatch(renderSubagent('Explore', { graftReads: 0, sourceReads: 0, savedTokens: 0 }), /graft:/);
});

/** A session file as an older version wrote it: the prompt in `lastQuery` and `perAgentQuery`, last touched days ago. */
function legacySession(dir: string, id: string): { file: string; old: Date } {
  writeSession(dir, id, { graftReads: 4, sourceReads: 1, savedTokens: 900, injectedPointers: ['src/a.ts'] });
  const file = join(sessionDir(dir), `${id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), lastQuery: PROMPT, perAgentQuery: { Explore: PROMPT } }));
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  utimesSync(file, old, old);
  return { file, old };
}

test('an older session file loses the prompt it kept, and keeps everything else, its age included', () => {
  const dir = tmpRepo('prompt-legacy');
  const { file, old } = legacySession(dir, 'old');
  assert.equal(JSON.stringify(readSession(dir, 'old')).includes('quokka'), false, 'never read back');
  dropStoredPrompts(dir);
  assert.deepEqual(filesWith(dir, 'quokka'), []);
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(kept.graftReads, 4);
  assert.deepEqual(kept.injectedPointers, ['src/a.ts']);
  // The idle sweep that rolls sessions up still sees it as long closed.
  assert.equal(Math.round(statSync(file).mtimeMs / 1000), Math.round(old.getTime() / 1000));
});

test('the session-start hook drops prompts older versions stored', async () => {
  const dir = tmpRepo('prompt-legacy-start');
  legacySession(dir, 'old');
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? true : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.CLAUDE_PROJECT_DIR = dir;
  process.env.GRAFT_TEST_STDIN = JSON.stringify({ session_id: 'new' });
  // b7 review: a Trail home of its own; session start reads every-repo learnings and init's kept notice there.
  const saved = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = join(dir, 'trail-home');
  try {
    await main('session-start');
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
    delete process.env.CLAUDE_PROJECT_DIR;
    if (saved === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = saved;
  }
  assert.deepEqual(filesWith(dir, 'quokka'), []);
});
