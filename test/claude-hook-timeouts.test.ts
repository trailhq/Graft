/**
 * Claude Code (and Codex) read a hook's `timeout` in seconds. Trail wrote
 * 8000-15000, meant as milliseconds, which the host read as two to four hours:
 * a wedged hook could hold a prompt that long. The installed numbers are now
 * seconds, Trail's own reading of them converts, and the prompt hook keeps to
 * a hard total budget of its own: the learnings first, the graph ask only
 * inside what is left (a large repo's ask took 13 s at p95).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { mergeGraftHooks, mergeGraftSettings, mergeTrailLocal, mergeTrailShared } from '../src/claude/settings-merge.js';
import { installCodexHooks } from '../src/hosts/codex-hooks.js';
import { handlePrompt, PROMPT_BUDGET_MS, promptAskTimeout } from '../src/claude/prompt-hook.js';
import { writeNote } from '../src/notes/notes.js';
import { tmpRepo } from './helpers.js';
import { timeBar } from './machine-speed.js';

type Hooks = Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;

/** Every graft/trail hook's timeout, by event. */
function timeouts(hooks: Hooks): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [event, blocks] of Object.entries(hooks)) {
    for (const b of blocks) for (const h of b.hooks) if (/(graft|trail)-hooks\.cjs|\/\.trail\/hook\.cjs/.test(h.command)) (out[event] ??= []).push(h.timeout);
  }
  return out;
}

const EXPECTED = { PostToolUse: [10, 8], UserPromptSubmit: [15], PreToolUse: [5, 5], PostToolUseFailure: [5], SessionStart: [10], Stop: [10], SessionEnd: [5] };

test('the repo and ~/.claude installs write every hook timeout in seconds', () => {
  assert.deepEqual(timeouts(mergeGraftSettings({}, { name: 'trail' }).merged.hooks), EXPECTED);
  assert.deepEqual(timeouts(mergeGraftHooks({}, '/home/dev/.claude/helpers').merged.hooks), EXPECTED);
  // trail's layout (#619): the shared file's one session-start entry, and the personal file's others under --no-global.
  assert.deepEqual(timeouts(mergeTrailShared({}).hooks), { SessionStart: [10] });
  const { SessionStart: _shared, ...personal } = EXPECTED;
  assert.deepEqual(timeouts(mergeTrailLocal({}, { hooks: true }).merged.hooks), personal);
});

test('an install from before is rewritten in seconds when it is merged again (init, or upkeep after an upgrade)', () => {
  const old: Hooks = {
    UserPromptSubmit: [{ hooks: [{ command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/trail-hooks.cjs" prompt', timeout: 15000 }] }],
    Stop: [{ hooks: [{ command: 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/trail-hooks.cjs" stop', timeout: 8000 }] }, { hooks: [{ command: './scripts/my-own-stop.sh', timeout: 30 }] }],
  };
  const merged = mergeGraftSettings({ hooks: old }, { name: 'trail' }).merged.hooks as Hooks;
  assert.deepEqual(timeouts(merged).UserPromptSubmit, [15]);
  assert.deepEqual(timeouts(merged).Stop, [10]);
  assert.ok(merged.Stop!.some((b) => b.hooks.some((h) => h.command === './scripts/my-own-stop.sh' && h.timeout === 30)), "the person's own hook is kept as it was");
});

test('Codex hooks are written in seconds too', () => {
  const home = mkdtempSync(join(tmpdir(), 'hook-timeouts-codex-'));
  mkdirSync(join(home, '.codex'), { recursive: true });
  installCodexHooks(home);
  const hooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks as Hooks;
  assert.deepEqual(timeouts(hooks), { SessionStart: [10], UserPromptSubmit: [15], PostToolUse: [10, 5], PreToolUse: [5], Stop: [10] });
});

/** A repo whose UserPromptSubmit hook carries `timeout`, with no user-level hooks in the way. */
function withTimeout(timeout: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'hook-timeouts-'));
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node ".claude/helpers/trail-hooks.cjs" prompt', timeout }] }] } }));
  return d;
}

test('promptAskTimeout reads an installed timeout as seconds, and an old one as the milliseconds it was meant as', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hook-timeouts-nouser-'));
  try {
    assert.equal(promptAskTimeout(withTimeout(15)), 13000, '15 s, less the hook’s own headroom');
    assert.equal(promptAskTimeout(withTimeout(60)), 58000);
    assert.equal(promptAskTimeout(withTimeout(15000)), 13000, 'an install from before: meant as ms');
    assert.equal(promptAskTimeout(withTimeout(8000)), 6000);
    assert.equal(promptAskTimeout(withTimeout(2)), 0, 'a 2 s hook has no room for an ask: none is started rather than one the host kills');
    // trail's personal file (#619, --no-global) names the committed hook, `.trail/hook.cjs`.
    const local = mkdtempSync(join(tmpdir(), 'hook-timeouts-local-'));
    mkdirSync(join(local, '.claude'), { recursive: true });
    writeFileSync(join(local, '.claude', 'settings.local.json'), JSON.stringify(mergeTrailLocal({}, { hooks: true }).merged));
    assert.equal(promptAskTimeout(local), 13000, 'the 15 s in .claude/settings.local.json');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

/** A trail repo with one learning about prod, and a `graft ask` stand-in that never answers. */
function slowAskRepo(): { dir: string; called: string } {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'hook-timeouts-home-'));
  process.env[BRAND_ENV] = 'trail';
  const dir = tmpRepo('hook-timeouts-budget');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeNote(dir, { title: 'Promote to prod only after beta is green', body: '## Decided\nPush to beta first.\n', author: 'Priya', date: '2026-10-07', touches: [] });
  const stub = join(dir, 'ask-never.cjs');
  const called = join(dir, 'ask-called');
  writeFileSync(stub, `require('fs').writeFileSync(${JSON.stringify(called)}, '1');\nsetTimeout(() => {}, 120000);\n`);
  process.env.GRAFT_TEST_CLI = stub;
  // The developer's own ~/.claude hooks must not decide these.
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hook-timeouts-nouser-'));
  // Nor their Trail home. Skills are on by default; these budgets are the learnings' and the ask's, so skills are off.
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'hook-timeouts-trail-'));
  writeFileSync(join(process.env.TRAIL_HOME, 'settings.json'), JSON.stringify({ v: 1, skills: 'off' }));
  return { dir, called };
}

/** The hook's answer on stdout while `fn` runs (strings); the test runner's own writes (buffers) pass through. */
async function captured(fn: () => Promise<void> | void): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

test('the prompt hook ends inside its total budget, with the learnings, when the graph ask never answers', async () => {
  const { dir, called } = slowAskRepo();
  try {
    const started = Date.now();
    const out = await captured(() => handlePrompt({ session_id: 's1', prompt: 'how do we promote this build to prod safely' }, dir, { budgetMs: 1500 }));
    const took = Date.now() - started;
    // The budget, and what a slow machine adds around it; under the default 4 s budget, which would show if this one were ignored.
    const bar = Math.min(1500 + timeBar(700, 2100), 3900);
    assert.ok(took < bar, `took ${took} ms on a 1500 ms budget (bar ${bar} ms)`);
    assert.equal(readFileSync(called, 'utf8'), '1', 'the ask was started inside the budget');
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Promote to prod only after beta is green/);
  } finally {
    delete process.env.GRAFT_TEST_CLI;
  }
});

test('with no room left for an ask, none is started and the learnings still go out', async () => {
  const { dir, called } = slowAskRepo();
  try {
    const out = await captured(() => handlePrompt({ session_id: 's1', prompt: 'how do we promote this build to prod safely' }, dir, { budgetMs: 100 }));
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Promote to prod only after beta is green/);
    assert.throws(() => readFileSync(called), 'no ask started');
  } finally {
    delete process.env.GRAFT_TEST_CLI;
  }
});

test('the default budget holds a never-answering ask to a few seconds, whatever the installed timeout says', async () => {
  const { dir } = slowAskRepo();
  // An install from before: read as 15 s of room, far over the budget.
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "x/.claude/helpers/trail-hooks.cjs" prompt', timeout: 15000 }] }] } }));
  try {
    assert.ok(PROMPT_BUDGET_MS <= 5000, `budget ${PROMPT_BUDGET_MS} ms`);
    const started = Date.now();
    const out = await captured(() => handlePrompt({ session_id: 's1', prompt: 'how do we promote this build to prod safely' }, dir));
    const took = Date.now() - started;
    // Far under the installed 15 s however slow the machine: 700 ms scaled is at most 7 s.
    assert.ok(took < PROMPT_BUDGET_MS + timeBar(700, 2100), `took ${took} ms`);
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Promote to prod/);
  } finally {
    delete process.env.GRAFT_TEST_CLI;
  }
});

/** Whether a process is gone, waiting up to `ms` for it. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}

test('the budget holds when the ask is slow to die (a refresh under way handles SIGTERM only when its parse ends), and the child is not left behind', async () => {
  const { dir } = slowAskRepo();
  // The real CLI mid-refresh: it takes SIGTERM to release its lock, but its
  // handler runs only once the synchronous parse is done (32 s on a large repo).
  const stub = join(dir, 'ask-busy.cjs');
  const pidFile = join(dir, 'ask-pid');
  writeFileSync(stub, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.once('SIGTERM', () => process.kill(process.pid, 'SIGTERM'));\nfor (const end = Date.now() + 3000; Date.now() < end;) {}\n`);
  process.env.GRAFT_TEST_CLI = stub;
  try {
    const started = Date.now();
    const out = await captured(() => handlePrompt({ session_id: 's1', prompt: 'how do we promote this build to prod safely' }, dir, { budgetMs: 1500 }));
    const took = Date.now() - started;
    // The budget, and what a slow machine adds around it; under the 3 s the stub's parse takes, which a wait for it would show.
    const bar = Math.min(1500 + timeBar(700, 1400), 2900);
    assert.ok(took < bar, `took ${took} ms on a 1500 ms budget (bar ${bar} ms)`);
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Promote to prod only after beta is green/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(await goneWithin(pid, 6000), 'the cut ask ends on its own once its work is done');
    const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    assert.equal(ps.stdout.trim(), '', 'no zombie left behind');
  } finally {
    delete process.env.GRAFT_TEST_CLI;
  }
});
