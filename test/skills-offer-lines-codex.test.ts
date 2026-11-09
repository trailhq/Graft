/**
 * D133: `offer-lines.ts` reads the person's typed line through the host's
 * dialect, so a moment 4 (correction) offer has its lines on Codex too. A
 * Codex typed line is the person's only by its keyed hash (P30). Synthetic
 * rollouts only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLines, meta, rollout, userItem, userMessage } from './codex-fixtures.js';
import { typedLineAt } from '../src/skills/offer-lines.js';
import { noteCodexPrompt } from '../src/trace/codex.js';
import { CODEX_DIALECT } from '../src/trace/dialect.js';
import { typedSha } from '../src/trace/typed.js';
import type { SkillSessionState } from '../src/trace/types.js';

test('a Codex typed line at its offset reads back through the dialect, only when the prompt hook hashed it', () => {
  const root = mkdtempSync(join(tmpdir(), 'c8-lines-'));
  try {
    const trail = join(root, 'trail');
    mkdirSync(trail);
    const env = { HOME: join(root, 'home'), TRAIL_HOME: trail, CODEX_HOME: join(root, 'codex') };
    const tx = rollout(join(root, 'codex'), [meta({ cwd: '/home/dev/shop' })]);
    const offset = statSync(tx).size;
    const said = "no, don't push to main, open a PR";
    appendLines(tx, [userMessage(said, 5), userItem(said, 5)]);
    const st = { codex: { meta: null, typedShas: [] } } as unknown as SkillSessionState;
    const use = { dialect: CODEX_DIALECT, st };
    assert.equal(typedLineAt(tx, offset, typedSha(said), env, use), null, 'not hashed by the prompt hook: not the person\'s');
    noteCodexPrompt(st, said, env);
    assert.equal(typedLineAt(tx, offset, typedSha(said), env, use), said);
    assert.equal(typedLineAt(tx, offset, typedSha(said), env), null, 'Claude\'s reader never reads a Codex line');
    assert.equal(typedLineAt(tx, offset, typedSha('something else'), env, use), null, 'the sha still has to match');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
