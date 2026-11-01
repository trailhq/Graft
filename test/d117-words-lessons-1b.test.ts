/**
 * D117 (5): a kept "this repo" preference is named "your learning for this repo" in the D87 notice, and a
 * `timeout-missing` lesson counts as worked when the next timeout-free run of the same program passes.
 * Made-up repos and commands only.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { keptLine } from '../src/claude/start-init.js';
import { writeEveryRepo } from '../src/notes/every-repo.js';
import { writeLesson } from '../src/skills/lessons.js';
import { parseNote } from '../src/notes/notes.js';
import { readWalls } from '../src/trace/wall-state.js';
import { readFileSync } from 'node:fs';
import { at, box, calling, done, finish, postBashFailHook, promptHook, resultOf, session, SHOP } from './claude-skills-journey-fixtures.js';
import { tmpRepo } from './helpers.js';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('D117 (5): a kept preference for this repo is "your learning for this repo"; an every-repo one keeps its title', () => {
  const root = tmpRepo('d117-pref');
  made.push(root);
  const env = { HOME: root, TRAIL_HOME: join(root, 'trail-home') };
  mkdirSync(env.TRAIL_HOME, { recursive: true });
  const path = writeEveryRepo({ title: 'use plain words', body: 'use plain words', author: '', date: '2026-10-01', kind: 'preference', src: 'init-typed', standing: true } as never, 'pref-plainwords.md', env);
  const every = parseNote(readFileSync(path, 'utf8'), path)!.id!;
  const line = keptLine([
    { kind: 'preference', name: '', id: every, forget: every },
    { kind: 'preference', name: '', id: 'l-0a0b0c0d', forget: 'l-0a0b0c0d' },
  ], env);
  assert.equal(line, `trail: kept from trail init in your terminal: "use plain words" (learning, undo: trail forget ${every}) · your learning for this repo (learning, undo: trail forget l-0a0b0c0d)`);
});

const TIMEOUT_ERR = 'zsh:1: command not found: timeout';

test('D117 (5) through the hooks: a timeout-missing lesson counts as worked when the next timeout-free run of the same program passes', async () => {
  for (const [ok, counts] of [['npm test', true], ['npm test -- --watch=false', true], ['go test ./...', false], ['timeout 60 npm test', false]] as const) {
    const b = box(`d117-timeout-${ok.replace(/\W/g, '').slice(0, 12)}`);
    try {
      const file = writeLesson({ id: '', skill: null, at: '2026-10-02', text: '"timeout: command not found": npm test with the Bash tool\'s own timeout', kind: 'lesson', src: 'repair', wall: 'timeout-missing' }, SHOP, { TRAIL_HOME: b.trail });
      const id = parseNote(readFileSync(file, 'utf8'), file)!.id!;
      const s = session(b);
      await promptHook(s, at(15, 0), 'run the tests');
      const fid = calling(s, at(15, 10), 'timeout 60 npm test');
      resultOf(s, at(15, 10), fid, TIMEOUT_ERR, true);
      await postBashFailHook(s, at(15, 11), 'timeout 60 npm test', fid, TIMEOUT_ERR);
      const pid = calling(s, at(15, 20), ok);
      resultOf(s, at(15, 20), pid, ok.startsWith('timeout') ? TIMEOUT_ERR : 'Tests: 12 passed, 12 total', ok.startsWith('timeout'));
      await finish(s, 15, 'Tests pass.');
      const w = readWalls({ TRAIL_HOME: b.trail }).classes['timeout-missing'];
      assert.equal(w?.seen.length ? true : false, true, `${ok}: the hit is noted`);
      assert.equal((w?.lessons[id]?.worked ?? []).length, counts ? 1 : 0, `${ok}: ${JSON.stringify(w)}`);
    } finally {
      done(b);
    }
  }
});
