/**
 * The prompt hook brings in the learnings that bear on what the person typed
 * on its own, without the graph ask: a short ask like "ff to prod" is too
 * short to ask the graph about, and an ask that fails or runs out of time
 * must not take the learnings down with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { main } from '../src/claude/hooks.js';
import { writeNote } from '../src/notes/notes.js';
import { tmpRepo } from './helpers.js';
import { timeBar } from './machine-speed.js';

const PROD = { title: 'Promote to prod only after beta is green', body: '## Decided\nPush to beta first, wait for its deploy, then fast-forward prod.\n', author: 'Priya', date: '2026-10-07', touches: [] };
const DNS = { title: 'DNS changes go through the infra repo', body: '## Decided\nNever edit records by hand.\n', author: 'Kumar', date: '2026-10-06', touches: [] };

/** A git repo under trail with the two learnings committed to its `.trail/learnings/`. */
function repo(): string {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'prompt-learnings-home-'));
  process.env[BRAND_ENV] = 'trail';
  const dir = tmpRepo('prompt-learnings');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeNote(dir, PROD);
  writeNote(dir, DNS);
  process.env.CLAUDE_PROJECT_DIR = dir;
  return dir;
}

/** A stand-in for `graft ask` that records it was called, then does `body`. */
function askStub(dir: string, body: string): { stub: string; calledFile: string } {
  const stub = join(dir, 'ask-stub.cjs');
  const calledFile = join(dir, 'ask-called.json');
  writeFileSync(stub, `require('fs').writeFileSync(${JSON.stringify(calledFile)}, JSON.stringify(process.argv.slice(2)));\n${body}\n`);
  return { stub, calledFile };
}

async function prompt(text: string, stub: string, session = 's1'): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.GRAFT_TEST_STDIN = JSON.stringify({ session_id: session, prompt: text });
  process.env.GRAFT_TEST_CLI = stub;
  try {
    await main('prompt');
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
    delete process.env.GRAFT_TEST_CLI;
  }
  return out;
}

function context(out: string): string {
  assert.ok(out, 'the hook said something');
  return JSON.parse(out).hookSpecificOutput.additionalContext as string;
}

test('"ff to prod" (10 characters) brings in the learning about prod, with no graph ask', async () => {
  const dir = repo();
  const { stub, calledFile } = askStub(dir, `process.stdout.write(JSON.stringify({ query: '', mode: 'lexical', hits: [] }));`);
  const text = context(await prompt('ff to prod', stub));
  assert.match(text, /Promote to prod only after beta is green/);
  assert.doesNotMatch(text, /DNS changes/, 'only the learning that bears on it');
  assert.equal(existsSync(calledFile), false, 'too short for the graph ask');
});

test('a 3-character prompt is enough to match, and a 2-character one says nothing', async () => {
  const dir = repo();
  const { stub } = askStub(dir, '');
  assert.match(context(await prompt('dns', stub)), /DNS changes go through the infra repo/);
  assert.equal(await prompt('ok', stub, 's2'), '');
  assert.equal(existsSync(join(dir, 'graft', '.cache', 'session', 's2.json')), false, 'nothing kept for it either');
});

test('learnings still arrive when the graph ask fails', async () => {
  const dir = repo();
  const { stub, calledFile } = askStub(dir, `process.exit(1);`);
  const text = context(await prompt('how do we promote this build to prod safely', stub));
  assert.equal(existsSync(calledFile), true, 'the ask ran, and failed');
  assert.match(text, /Promote to prod only after beta is green/);
});

test('learnings still arrive when the graph ask runs out of time', async () => {
  const dir = repo();
  // The hook's own total budget cuts the ask; the stand-in sleeps far past it.
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "x/.claude/helpers/trail-hooks.cjs" prompt', timeout: 15 }] }] } }));
  const { stub, calledFile } = askStub(dir, `setTimeout(() => {}, 60000);`);
  const started = Date.now();
  const text = context(await prompt('how do we promote this build to prod safely', stub));
  assert.ok(Date.now() - started < timeBar(20_000, 40_000), 'the ask was cut off (the stand-in sleeps 60 s)');
  assert.equal(existsSync(calledFile), true);
  assert.match(text, /Promote to prod only after beta is green/);
});

test("a learning the ask matched on its hits' files joins the ones matched by words, each once", async () => {
  const dir = repo();
  const fileHit = { note: { path: '/x/.trail/learnings/2026-10-05-retry-budget-kumar.md', title: 'Retry budget lives in client.go', author: 'Kumar', date: '2026-10-05', touches: ['src/client.go'], body: '## Decided\nFive retries.\n', scope: 'repo' }, score: 4, shared: ['src/client.go'] };
  const { stub } = askStub(dir, `process.stdout.write(JSON.stringify({ query: 'q', mode: 'lexical', hits: [], notes: [${JSON.stringify(fileHit)}] }));`);
  const text = context(await prompt('can prod take another retry here', stub));
  assert.match(text, /Retry budget lives in client\.go/, "the ask's file match");
  assert.match(text, /Promote to prod only after beta is green/, 'the word match');
  assert.equal(text.split('Promote to prod only after beta is green').length, 2, 'once');
});

/** A stand-in for `graft ask` that records what reached it on stdin, then answers with no hits. */
function stdinStub(dir: string): { stub: string; seenFile: string } {
  const stub = join(dir, 'ask-stdin-stub.cjs');
  const seenFile = join(dir, 'ask-stdin.txt');
  writeFileSync(stub, `const fs = require('fs');\nfs.writeFileSync(${JSON.stringify(seenFile)}, fs.readFileSync(0, 'utf8'));\nprocess.stdout.write(JSON.stringify({ query: '', mode: 'lexical', hits: [] }));\n`);
  return { stub, seenFile };
}

test('the hook looks up what the person typed: IDE context and reminders are stripped before the match and the ask', async () => {
  const dir = repo();
  const { stub, seenFile } = stdinStub(dir);
  const raw = '<ide_opened_file>The user opened the file /home/dev/shop/dns/records.ts in the IDE.</ide_opened_file>\n<system-reminder>DNS changes are on the infra list.</system-reminder>\nhow do we promote this build to prod safely';
  const text = context(await prompt(raw, stub));
  assert.match(text, /Promote to prod only after beta is green/);
  assert.doesNotMatch(text, /DNS changes/, 'words the IDE and the harness added match nothing');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(seenFile, 'utf8'), 'how do we promote this build to prod safely', 'the ask gets the typed words alone');
});

test('harness text in the prompt slot says nothing: a task notice, a command wrapper, a hand-back, a whole paste', async () => {
  const dir = repo();
  const { stub, seenFile } = stdinStub(dir);
  for (const raw of [
    '<task-notification>\n<status>completed</status>\n<summary>Background deploy to prod finished</summary>\n</task-notification>',
    '<command-name>/deploy</command-name>\n<command-args>prod</command-args>',
    'Another Claude session sent a message: promote the build to prod',
    '<pasted_content id="1">promote to prod after beta, DNS records too</pasted_content id="1">',
  ]) {
    assert.equal(await prompt(raw, stub, 's-harness'), '', raw.slice(0, 40));
  }
  assert.equal(existsSync(seenFile), false, 'and no graph ask for any of them');
});
