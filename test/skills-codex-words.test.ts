/**
 * Phase 2 c7 (design 4.17, P36, rule 6): what Trail tells the agent and the person on Codex. A directive that names
 * a `trail skills` command that writes to ~/.trail says Codex's sandbox may ask first; a save held because Trail
 * couldn't find the conversation names the host it came from. Synthetic names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_COPY, withCodexSandbox } from '../src/hosts/codex-trust.js';
import { heldLines } from '../src/skills/save-gate.js';

test('a Codex directive that names a save command says the sandbox may ask (P36); nothing else changes', () => {
  const ctx = '[trail] From Trail, ... To keep it as they said, run: trail skills add release-npm --run r-1027-0a1b2c3d. Then tell them the line it prints.';
  assert.equal(withCodexSandbox({ context: ctx }, 'codex').context, `${ctx} ${CODEX_COPY.sandbox}`);
  const block = 'If they answer yes, run: trail skills lesson release-npm --offer o-0a1b2c (Trail checks their yes), then tell them.';
  assert.equal(withCodexSandbox({ block }, 'codex').block, `${block} ${CODEX_COPY.sandbox}`);
  assert.equal(withCodexSandbox({ context: 'run: trail skills update release-npm --offer o-0a1b2c.' }, 'codex').context?.endsWith(CODEX_COPY.sandbox), true);
  // Once only, never on Claude Code, never on text that runs no save.
  const once = withCodexSandbox(withCodexSandbox({ context: ctx }, 'codex'), 'codex').context!;
  assert.equal(once.split(CODEX_COPY.sandbox).length, 2);
  assert.deepEqual(withCodexSandbox({ context: ctx }, 'claude'), { context: ctx });
  const read = { context: '[trail] Skill release-npm fits. trail skills show release-npm', notice: 'trail: using skill release-npm' };
  assert.deepEqual(withCodexSandbox(read, 'codex'), read);
  assert.deepEqual(withCodexSandbox({}, 'codex'), {});
});

test('a save held for its transcript names the host where Trail looked', () => {
  const [, claude] = heldLines('release-npm', 'transcript', 'claude');
  assert.match(claude, /where Claude Code keeps it/);
  const [line, codex] = heldLines('release-npm', 'transcript', 'codex');
  assert.match(line, /where Codex keeps it/);
  assert.match(codex, /where Codex keeps it/);
  assert.doesNotMatch(codex, /Claude Code/);
  assert.match(heldLines('x', 'transcript', 'something-else')[0], /where your agent keeps it/);
});
