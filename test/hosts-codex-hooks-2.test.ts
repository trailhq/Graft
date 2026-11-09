/**
 * Phase 2 c7 (design 2.11, 4.17, P33): Trail's Codex hook entries are pinned byte for byte, written in place on
 * every install, and changed once (0.26.0, D125): PostToolUse gains `codex-post-bash` on Bash and SessionStart's
 * matcher gains `clear`. Codex keys a hook's trust by the file, the event, the group's index and the handler's index,
 * so an entry that moves or changes stops running until the person trusts it again.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desiredCodexEntries, installCodexHooks } from '../src/hosts/codex-hooks.js';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'c7-cxhooks-'));
  made.push(h);
  mkdirSync(join(h, '.codex'), { recursive: true });
  return h;
}
const cfgPath = (h: string) => join(h, '.codex', 'hooks.json');
const read = (h: string) => JSON.parse(readFileSync(cfgPath(h), 'utf8'));
const SHIM = '/home/dev/.codex/hooks/graft/graft-hooks.cjs';

test('every Trail entry is pinned byte for byte (P33)', () => {
  const got = desiredCodexEntries(SHIM).map((d) => `${d.event} ${JSON.stringify(d.entry)}`);
  const cmd = (sub: string) => `node \\"${SHIM}\\" ${sub} || exit 0`;
  assert.deepEqual(got, [
    `SessionStart {"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"${cmd('session-start')}","timeout":10}]}`,
    `UserPromptSubmit {"hooks":[{"type":"command","command":"${cmd('prompt')}","timeout":15}]}`,
    `PostToolUse {"matcher":"apply_patch|Write|Edit|MultiEdit","hooks":[{"type":"command","command":"${cmd('post-edit')}","timeout":10}]}`,
    `PostToolUse {"matcher":"Bash","hooks":[{"type":"command","command":"${cmd('codex-post-bash')}","timeout":5}]}`,
    `PreToolUse {"matcher":"Bash","hooks":[{"type":"command","command":"${cmd('pre-bash')}","timeout":5}]}`,
    `Stop {"hooks":[{"type":"command","command":"${cmd('stop')}","timeout":10}]}`,
  ]);
});

test('a fresh install writes exactly the pinned entries, and a second install changes no byte', () => {
  const h = home();
  installCodexHooks(h);
  const shim = join(h, '.codex', 'hooks', 'graft', 'graft-hooks.cjs');
  const want: Record<string, unknown[]> = {};
  for (const d of desiredCodexEntries(shim)) (want[d.event] ??= []).push(d.entry);
  assert.deepEqual(read(h).hooks, want);
  const bytes = readFileSync(cfgPath(h), 'utf8');
  const again = installCodexHooks(h);
  assert.deepEqual(again.map((w) => w.action), ['unchanged', 'unchanged']);
  assert.equal(readFileSync(cfgPath(h), 'utf8'), bytes);
});

test("a foreign entry added after Trail's stays after it: Trail's keeps its index", () => {
  const h = home();
  installCodexHooks(h);
  const cfg = read(h);
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool check', timeout: 3 }] };
  cfg.hooks.PreToolUse.push(foreign);
  cfg.hooks.PostToolUse.push(foreign);
  writeFileSync(cfgPath(h), JSON.stringify(cfg, null, 2));
  installCodexHooks(h);
  const out = read(h).hooks;
  assert.match(out.PreToolUse[0].hooks[0].command, /graft-hooks\.cjs" pre-bash/);
  assert.deepEqual(out.PreToolUse[1], foreign);
  assert.match(out.PostToolUse[0].hooks[0].command, /post-edit/);
  assert.match(out.PostToolUse[1].hooks[0].command, /codex-post-bash/);
  assert.deepEqual(out.PostToolUse[2], foreign);
});

test('a foreign entry before Trail\'s keeps Trail\'s at its own index', () => {
  const h = home();
  const foreign = { hooks: [{ type: 'command', command: 'other-tool stop', timeout: 30 }] };
  writeFileSync(cfgPath(h), JSON.stringify({ hooks: { Stop: [foreign] } }));
  installCodexHooks(h);
  assert.deepEqual(read(h).hooks.Stop[0], foreign);
  assert.match(read(h).hooks.Stop[1].hooks[0].command, /" stop \|\| exit 0$/);
});

test('an old 0.22 entry is replaced in place, never moved behind later entries', () => {
  const h = home();
  const foreignA = { matcher: 'Edit', hooks: [{ type: 'command', command: 'a-tool' }] };
  const foreignB = { matcher: 'Bash', hooks: [{ type: 'command', command: 'b-tool' }] };
  const old = (sub: string, timeout = 8000) => ({ hooks: [{ type: 'command', command: `node "/old/.codex/hooks/graft/graft-hooks.cjs" ${sub}`, timeout }] });
  writeFileSync(cfgPath(h), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: 'startup|resume|compact', ...old('session-start') }, foreignA],
    PostToolUse: [foreignA, { matcher: 'Write', ...old('post-edit') }, foreignB],
    PreToolUse: [{ matcher: 'Bash', ...old('pre-bash', 5000) }, foreignB],
  } }));
  installCodexHooks(h);
  const out = read(h).hooks;
  assert.equal(out.SessionStart.length, 2);
  assert.equal(out.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.deepEqual(out.SessionStart[1], foreignA);
  // post-edit stays at index 1; the new Bash entry is the one missing, so it goes at the end.
  assert.deepEqual(out.PostToolUse[0], foreignA);
  assert.match(out.PostToolUse[1].hooks[0].command, /post-edit \|\| exit 0$/);
  assert.equal(out.PostToolUse[1].hooks[0].timeout, 10);
  assert.deepEqual(out.PostToolUse[2], foreignB);
  assert.match(out.PostToolUse[3].hooks[0].command, /codex-post-bash \|\| exit 0$/);
  assert.match(out.PreToolUse[0].hooks[0].command, /pre-bash \|\| exit 0$/);
  assert.deepEqual(out.PreToolUse[1], foreignB);
  assert.ok(!JSON.stringify(out).includes('/old/'));
});

test('a doubled Trail entry is folded into one at the first place; a Trail entry of a retired sub-command takes a missing one\'s place', () => {
  const h = home();
  const t = (sub: string) => ({ hooks: [{ type: 'command', command: `node "/x/trail-hooks.cjs" ${sub}` }] });
  const foreign = { hooks: [{ type: 'command', command: 'z-tool' }] };
  writeFileSync(cfgPath(h), JSON.stringify({ hooks: {
    Stop: [t('stop'), foreign, t('stop')],
    PostToolUse: [{ matcher: 'apply_patch', ...t('post-edit') }, foreign, { matcher: 'Bash', ...t('post-bash-old') }],
  } }));
  installCodexHooks(h);
  const out = read(h).hooks;
  assert.equal(out.Stop.length, 2);
  assert.match(out.Stop[0].hooks[0].command, /" stop \|\| exit 0$/);
  assert.deepEqual(out.Stop[1], foreign);
  assert.equal(out.PostToolUse.length, 3);
  assert.match(out.PostToolUse[0].hooks[0].command, /post-edit/);
  assert.deepEqual(out.PostToolUse[1], foreign);
  assert.match(out.PostToolUse[2].hooks[0].command, /codex-post-bash/);
});

test("a person's own handler inside a Trail group stays at its place; only Trail's handler in it is written (P33)", () => {
  const h = home();
  const mine = { type: 'command', command: '/home/dev/bin/audit.sh', timeout: 3 };
  writeFileSync(cfgPath(h), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/x/graft-hooks.cjs" stop' }, mine] }] } }));
  installCodexHooks(h);
  const out = read(h).hooks;
  assert.equal(out.Stop.length, 1, 'no second Stop group: the one there runs Trail');
  assert.equal(out.Stop[0].hooks.length, 2);
  assert.match(out.Stop[0].hooks[0].command, /graft-hooks\.cjs" stop \|\| exit 0$/);
  assert.deepEqual(out.Stop[0].hooks[1], mine);
});

test('a doubled Trail entry with a foreign entry after it stays as it was, so the foreign one keeps its index (P33)', () => {
  const h = home();
  const t = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/x/graft-hooks.cjs" pre-bash' }] };
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'z-tool' }] };
  writeFileSync(cfgPath(h), JSON.stringify({ hooks: { PreToolUse: [t, t, foreign] } }));
  installCodexHooks(h);
  const out = read(h).hooks;
  assert.equal(out.PreToolUse.length, 3);
  assert.deepEqual(out.PreToolUse[2], foreign);
});
