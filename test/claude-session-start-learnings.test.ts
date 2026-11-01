/**
 * Session start loads the learnings even when `graft/INDEX.md` is missing.
 * `graft/` is git-ignored, so a teammate's first session in a fresh clone has
 * no INDEX.md, and that is exactly the session the repo's learnings are for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { main } from '../src/claude/hooks.js';
import { writeNote } from '../src/notes/notes.js';
import { tmpRepo } from './helpers.js';

// A scratch home, so the hook's upkeep and telemetry never touch the real one.
const HOME = mkdtempSync(join(tmpdir(), 'session-start-learnings-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.TRAIL_HOME = join(HOME, '.trail');
process.env.DO_NOT_TRACK = '1';

async function sessionStart(dir: string): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.CLAUDE_PROJECT_DIR = dir;
  process.env.GRAFT_TEST_STDIN = JSON.stringify({ session_id: 's1', source: 'startup' });
  try {
    await main('session-start');
  } finally {
    process.stdout.write = write;
    delete process.env.GRAFT_TEST_STDIN;
    delete process.env.CLAUDE_PROJECT_DIR;
  }
  return out;
}

function repo(): string {
  const dir = tmpRepo('session-start-learnings');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

test('a repo with learnings and no graft/INDEX.md still gets its standing learnings and how to save one', async () => {
  process.env[BRAND_ENV] = 'trail';
  const dir = repo();
  writeNote(dir, { title: 'Use pnpm, never npm, in this repo', body: '## Decided\nThe lockfile is pnpm-lock.yaml.\n', author: 'Priya', date: '2026-10-07', standing: true });
  assert.equal(existsSync(join(dir, 'graft', 'INDEX.md')), false);
  const out = await sessionStart(dir);
  assert.ok(out, 'the hook said something');
  const text: string = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(text, /Standing learnings/);
  assert.match(text, /Use pnpm, never npm, in this repo/);
  assert.match(text, /This repo has 1 learning from past sessions/);
  assert.match(text, /Save a learning when the session finds what the code can't tell the next person/);
  assert.match(text, /--title "<the decision in plain words a teammate understands, no file names>"/);
  assert.match(text, /Put files, commands and values in the body under "In the code:"\./);
  assert.doesNotMatch(text, /the fact, not the task/);
  assert.doesNotMatch(text, /repo map \(graft\/INDEX\.md\)/, 'no map to show');
});

test('a repo that keeps no learnings and has no INDEX.md hears nothing about them', async () => {
  process.env[BRAND_ENV] = 'trail';
  const out = await sessionStart(repo());
  assert.doesNotMatch(out, /learning/i);
});
