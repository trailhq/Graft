/**
 * The session-start hook's self-maintenance pass, end to end: it must refresh
 * wiring an older graft wrote, surface a cached upgrade nudge, and — critically —
 * never touch the network, because it runs inside Claude Code's hook timeout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { main } from '../src/claude/hooks.js';
import { readStamp, runningVersion, updateCachePath } from '../src/upkeep.js';
import { tmpRepo } from './helpers.js';
import { timeBar } from './machine-speed.js';

/** A repo that looks like a previous `graft init` ran here, with no stamp — i.e.
 * wired by a graft old enough not to have written one. */
function wiredRepo(tag: string): string {
  const repo = tmpRepo(tag);
  mkdirSync(join(repo, '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs'), '// wired by an old graft\n');
  return repo;
}

/** A fake home carrying a pre-populated update cache, so nothing has to fetch. */
function homeWithCache(tag: string, latest: string | null, ageMs = 0): string {
  const home = tmpRepo(tag);
  writeFileSync(
    (mkdirSync(join(home, '.graft'), { recursive: true }), updateCachePath(home)),
    JSON.stringify({ latest, checkedAt: Date.now() - ageMs }),
  );
  return home;
}

/** Runs the hook in-process with stdin/home/project-dir stubbed, returns stdout. */
async function runHook(event: string, repo: string, home: string): Promise<string> {
  const saved = {
    write: process.stdout.write,
    stdin: process.env.GRAFT_TEST_STDIN,
    home: process.env.HOME,
    profile: process.env.USERPROFILE,
    dir: process.env.CLAUDE_PROJECT_DIR,
  };
  let out = '';
  // The hook writes strings; the test runner's own reports (bytes, on Node 20) pass through.
  const write = saved.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof process.stdout.write;
  process.env.GRAFT_TEST_STDIN = JSON.stringify({ cwd: repo, session_id: 'test' });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_PROJECT_DIR = repo;
  try {
    await main(event);
  } finally {
    process.stdout.write = saved.write;
    if (saved.stdin === undefined) delete process.env.GRAFT_TEST_STDIN; else process.env.GRAFT_TEST_STDIN = saved.stdin;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
    if (saved.dir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.dir;
  }
  return out;
}

function contextOf(stdout: string): string {
  if (!stdout) return '';
  return JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
}

test('session-start refreshes stale wiring and stamps it', async () => {
  const repo = wiredRepo('hook-refresh');
  const ctx = contextOf(await runHook('session-start', repo, homeWithCache('hook-refresh-home', null)));

  assert.match(ctx, /refreshed this repo's agent wiring/);
  assert.match(ctx, /written by unwired, now /);
  // The wiring was actually re-written, not just announced.
  assert.ok(existsSync(join(repo, '.claude', 'settings.json')));
  assert.ok(existsSync(join(repo, '.claude', 'skills', 'graft', 'SKILL.md')));
  assert.equal(readStamp(repo)?.version, runningVersion());
  assert.deepEqual(readStamp(repo)?.hosts, ['claude']);
});

test('session-start says nothing on a second run — the stamp now matches', async () => {
  const repo = wiredRepo('hook-idempotent');
  const home = homeWithCache('hook-idempotent-home', null);
  await runHook('session-start', repo, home);
  const ctx = contextOf(await runHook('session-start', repo, home));
  assert.doesNotMatch(ctx, /refreshed this repo's agent wiring/);
});

test('session-start surfaces a cached upgrade nudge', async () => {
  const repo = wiredRepo('hook-nudge');
  const ctx = contextOf(await runHook('session-start', repo, homeWithCache('hook-nudge-home', '99.0.0')));
  assert.match(ctx, /graft .* → 99\.0\.0 available/);
  assert.match(ctx, /run `graft upgrade`/);
});

test('an up-to-date install gets no nudge', async () => {
  const repo = wiredRepo('hook-current');
  const ctx = contextOf(await runHook('session-start', repo, homeWithCache('hook-current-home', runningVersion())));
  assert.doesNotMatch(ctx, /available: run/);
});

test('a stale cache is used as-is: the hook never fetches', async () => {
  // Two days old — the CLI and the MCP server refresh this, never the hook: a
  // hook that shelled out to `npm view` would spend its whole timeout on it.
  const repo = wiredRepo('hook-stale-cache');
  const home = homeWithCache('hook-stale-home', '99.0.0', 2 * 24 * 60 * 60 * 1000);
  const before = Date.now();
  const ctx = contextOf(await runHook('session-start', repo, home));
  assert.match(ctx, /99\.0\.0 available/, 'stale answer still shown rather than refetched');
  assert.ok(Date.now() - before < timeBar(2000, 6000), 'no network round trip');
});

test('an unwired repo is left completely alone', async () => {
  const repo = tmpRepo('hook-unwired');
  const home = homeWithCache('hook-unwired-home', null);
  // Skills are on by default and are the person's, in every repo: with them off, there is nothing to say here.
  mkdirSync(join(home, '.trail'), { recursive: true });
  writeFileSync(join(home, '.trail', 'settings.json'), JSON.stringify({ v: 1, skills: 'off' }));
  const out = await runHook('session-start', repo, home);
  assert.equal(out, '', 'no INDEX.md, no wiring, skills off: nothing to say');
  assert.equal(existsSync(join(repo, '.claude')), false, 'never wires a repo that was not wired');
});

test('with skills on by default, an unwired repo hears only about skills, and is still never wired', async () => {
  const repo = tmpRepo('hook-unwired-on');
  const ctx = contextOf(await runHook('session-start', repo, homeWithCache('hook-unwired-on-home', null)));
  assert.match(ctx, /keeps commands that worked here as skills, and keeps one only after the person says yes/);
  assert.doesNotMatch(ctx, /available|INDEX\.md|graft is now Trail-code/, 'no upkeep words in a repo nobody wired');
  assert.equal(existsSync(join(repo, '.claude')), false, 'never wires a repo that was not wired');
});

test('a nudge still lands in a wired repo with no graph built yet', async () => {
  const repo = wiredRepo('hook-nograph');
  const ctx = contextOf(await runHook('session-start', repo, homeWithCache('hook-nograph-home', '99.0.0')));
  assert.match(ctx, /99\.0\.0 available/, 'the no-INDEX.md path still reports upkeep');
});

test('a repo graft set up, on a machine without trail, hands the agent the trail line once a week', async () => {
  const path = process.env.PATH;
  const ci = process.env.CI;
  // node and git, and no trail command; and not CI, where the line stays quiet
  process.env.PATH = [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
  delete process.env.CI;
  try {
    const home = homeWithCache('hook-handover-home', null);
    const first = contextOf(await runHook('session-start', wiredRepo('hook-handover'), home));
    assert.match(first, /graft is now Trail-code/);
    assert.match(first, /`graft upgrade` adds it/);
    const again = contextOf(await runHook('session-start', wiredRepo('hook-handover-2'), home));
    assert.doesNotMatch(again, /graft is now Trail-code/, 'once a week, not every session');
  } finally {
    process.env.PATH = path;
    if (ci !== undefined) process.env.CI = ci;
  }
});
