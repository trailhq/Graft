/**
 * D99: an asked save of a run whose job class is known is named after the job
 * (`release-npm`, `ship-beta-then-prod`, design 4.5 step 13), never after its
 * first step. With no job from the run's typed asks, the class comes from the
 * person's typed save request, then from the run's own commands (a publish to
 * a registry checked with `npm view` is a release; pushes to stable branches
 * are a ship). A run with no job keeps the first-step name. Synthetic runs.
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRun, type CompileOpts, type CompileResult } from '../src/skills/compile.js';
import { callKind } from '../src/trace/checks.js';
import type { CheckHit, RunCall, RunSheet } from '../src/trace/types.js';
import type { CompiledSkill } from '../src/skills/types.js';

const KEY = 'github.com/acme/storefront';
let seq = 0;
function call(cmd: string, o: Partial<RunCall> = {}): RunCall {
  seq++;
  return {
    id: `toolu_${String(seq).padStart(3, '0')}`, at: new Date(Date.UTC(2026, 9, 27, 10, 31, 40) + seq * 20_000).toISOString(), cmd,
    key: KEY, cwd: '', bg: false, failed: false, isError: false, kind: callKind(cmd, null), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...o,
  };
}
const passed = (family: CheckHit['family'], facts: CheckHit['facts'] = {}): CheckHit => ({ family, passed: true, facts });
function sheet(calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id: 'r-1027-3f9a', session: 'e76b4ca7f1a0', repoKey: KEY, branch: 'main', host: 'claude', tier: 'A', epoch: 1,
    startedAt: '2026-10-27T10:31:40Z', endedAt: '2026-10-27T10:44:05Z', job: null, jobWords: [], sharedWords: [], promptParams: {},
    calls, checkIndex: null, checked: false, end: 'done',
    counts: { commands: calls.length, failed: 0, toolCalls: calls.length + 2, edits: 0 }, helpers: [], skillId: null, ...o,
  };
}
const OPTS: CompileOpts = { repoRoot: '/home/dev/src/storefront', home: '/home/dev', platform: 'darwin', moment: 'asked', applies: KEY, taken: () => false };
function ok(r: CompileResult): CompiledSkill {
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}

/** "pull and publish": the lab's release, its ask not read as a job (no typed line, or words no class knows). */
function pullAndPublish(): RunSheet {
  const calls = [
    call('git fetch origin'), call('git pull --ff-only'), call('npm ci'), call('npm run build'),
    call('npm publish --access public'), call('npm view acme-cli version', { check: passed('npm-view') }),
  ];
  return sheet(calls, { checkIndex: 5, checked: true });
}

test('a job-less run that publishes to npm and checks it with npm view is a release: release-npm, not git-fetch', () => {
  const s = ok(compileRun(pullAndPublish(), { ...OPTS, askedWith: 'save this as a skill' }));
  assert.equal(s.name, 'release-npm');
  assert.match(s.title, /^Release storefront to npm$/);
  assert.match(s.meta.asks, /\bpublish\b/);
});

test('the typed save request names the job when the commands alone do not', () => {
  // The publish happens inside a script, so no command names a registry.
  const calls = [call('git fetch origin'), call('git pull --ff-only'), call('./scripts/ship-package.sh')];
  assert.equal(ok(compileRun(sheet(calls), { ...OPTS, askedWith: 'save the publish steps as a skill' })).name, 'release');
  // Without a job in the words or the commands, it stays job-less, named as before.
  assert.equal(ok(compileRun(sheet(calls), { ...OPTS, askedWith: 'save this as a skill' })).name, 'git-fetch');
  // A publish to npm with no check at all is still a release.
  const unchecked = [call('git fetch origin'), call('npm publish --access public')];
  assert.equal(ok(compileRun(sheet(unchecked), { ...OPTS, askedWith: 'save this as a skill' })).name, 'release-npm');
});

test('a job-less run that pushes beta then prod is a ship: ship-beta-then-prod', () => {
  const calls = [
    call('git fetch origin'), call('git push origin main:beta'), call('git push origin beta:prod'),
    call('git ls-remote origin prod', { check: passed('ls-remote') }),
  ];
  const s = ok(compileRun(sheet(calls, { checkIndex: 3, checked: true }), { ...OPTS, askedWith: 'save this as a skill' }));
  assert.equal(s.name, 'ship-beta-then-prod');
});

test('a job-less run keeps its first-step name and the asks from the save request', () => {
  const calls = [call('git fetch origin'), call('make docs')];
  const s = ok(compileRun(sheet(calls), { ...OPTS, askedWith: 'save this as a skill for rebuilding the docs site' }));
  assert.equal(s.name, 'git-fetch');
  assert.equal(s.meta.job, undefined);
});

test('a run whose typed ask already gave the job is unchanged', () => {
  const s = ok(compileRun({ ...pullAndPublish(), job: 'release', jobWords: ['publish'] }, { ...OPTS, askedWith: 'save this as a skill' }));
  assert.equal(s.name, 'release-npm');
  assert.equal(s.meta.job, 'release');
});
