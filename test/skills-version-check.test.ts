/**
 * D106: a check whose shown fact is a version (`npm view <pkg> version`, a
 * `git ls-remote --tags`, a tag or release lookup) takes the `{version}`
 * param the steps use, so the check line and the check's credit both read
 * the version this run is about. A release that bumps with `npm version
 * patch` publishes the version in package.json after the bump: that is its
 * `{version}`. When no step names or makes the version, the check can't tell
 * this release from the last one, and compile refuses with `no-check`.
 * The block fills it in (`checkVersion`; its credit is in
 * skills-version-credit.test.ts). Synthetic runs of the made-up acme-cli.
 */
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRun, refusalWords, type CompileOpts, type CompileResult } from '../src/skills/compile.js';
import { callKind } from '../src/trace/checks.js';
import { resolveParams } from '../src/skills/params.js';
import { checkLine, injectionFor, runBlock } from '../src/skills/runblock.js';
import { renderSkillMd } from '../src/skills/skillmd.js';
import type { CheckHit, RunCall, RunSheet } from '../src/trace/types.js';
import type { CompiledSkill } from '../src/skills/types.js';
import { cand } from './skills-recall-fixtures.js';

const KEY = 'github.com/acme/cli';
const PKG_VERSION = `$(node -p "require('./package.json').version")`;
let seq = 0;
function call(cmd: string, o: Partial<RunCall> = {}): RunCall {
  seq++;
  return {
    id: `toolu_${String(seq).padStart(3, '0')}`, at: new Date(Date.UTC(2026, 9, 27, 10, 31, 40) + seq * 20_000).toISOString(), cmd,
    key: KEY, cwd: '', bg: false, failed: false, isError: false, kind: callKind(cmd, 'release'), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...o,
  };
}
const npmView = (cmd: string, shown: string): RunCall => call(cmd, {
  kind: 'look', tail: shown, check: { family: 'npm-view', passed: true, facts: { version: shown, pkg: 'acme-cli' } } as CheckHit,
});
function sheet(calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id: 'r-1027-3f9a', session: 'e76b4ca7f1a0', repoKey: KEY, branch: 'main', host: 'claude', tier: 'A', epoch: 1,
    startedAt: '2026-10-27T10:31:40Z', endedAt: '2026-10-27T10:44:05Z', job: 'release', jobWords: ['publish'], sharedWords: [], promptParams: {},
    calls, checkIndex: calls.length - 1, checked: true, end: 'done',
    counts: { commands: calls.length, failed: 0, toolCalls: calls.length + 2, edits: 0 }, helpers: [], skillId: null, ...o,
  };
}
const OPTS: CompileOpts = { repoRoot: '/home/dev/src/cli', home: '/home/dev', platform: 'darwin', moment: 'repeated', applies: KEY, taken: () => false };
function ok(r: CompileResult): CompiledSkill {
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}
const CTX = { probes: [], canAsk: true, header: 'job' as const, lastFail: null };

/** `npm version patch`, then `npm publish`: the version is package.json's after the bump. */
function bumpAndPublish(cwd = ''): RunSheet {
  return sheet([
    call('git pull --ff-only'), call('npm run build', { cwd }), call('npm version patch', { cwd }),
    call('npm publish --access public', { cwd, tail: '+ acme-cli@0.3.2' }), npmView('npm view acme-cli version', '0.3.2'),
  ]);
}

test('a bump with npm version patch then npm publish: the check shows {version}, read from package.json after the bump', () => {
  const s = ok(compileRun(bumpAndPublish(), OPTS));
  assert.equal(s.check, 'npm view acme-cli version');
  assert.equal(s.checkShows, '{version}');
  assert.equal(s.meta['check-shows'], '{version}');
  assert.deepEqual(s.params, [{ name: 'version', shape: 'version', default: PKG_VERSION, seen: ['0.3.2'] }]);
  assert.equal(s.meta.params, `version=${PKG_VERSION}`);
  assert.ok(renderSkillMd(s).includes('`npm view acme-cli version` shows `{version}`.'));

  // The ask names the version: the check line and the injection's check carry it.
  const c = cand(s);
  const asked = resolveParams(c.skill.params, { version: '0.3.3' }).values;
  assert.match(checkLine(c, asked), /npm view acme-cli version \(it should show 0\.3\.3\)/);
  assert.match(runBlock(c, { ...CTX, values: asked, notes: [] }), /check: npm view acme-cli version \(it should show 0\.3\.3\)/);
  assert.equal(injectionFor(c, asked, 'job', 0).checkVersion, '0.3.3');
  // No version in the ask: the agent reads package.json after the bump; nothing literal to credit against.
  const plain = resolveParams(c.skill.params, {}).values;
  assert.match(checkLine(c, plain), /\(it should show \$\(node -p "require\('\.\/package\.json'\)\.version"\)\)/);
  assert.equal('checkVersion' in injectionFor(c, plain, 'job', 0), false);
});

test('a publish from a sub-folder reads that folder\'s package.json', () => {
  const s = ok(compileRun(bumpAndPublish('packages/cli'), OPTS));
  assert.equal(s.checkShows, '{version}');
  assert.equal(s.params[0]!.default, `$(node -p "require('./packages/cli/package.json').version")`);
});

test('the lab\'s release: a publish behind a pty wrapper, no version in any step, still checks {version}', () => {
  // Keystrokes piped into the wrapper are refused on their own (answers-prompt, D101); the wrapper alone is kept.
  const s = ok(compileRun(sheet([
    call('git fetch -q origin'), call('npm run build'), call('script -q /dev/null npm publish', { bg: true }), npmView('npm view acme-cli version 2>/dev/null', '0.22.1'),
  ], { promptParams: { version: '0.22.1' } }), { ...OPTS, moment: 'asked' }));
  assert.equal(s.check, 'npm view acme-cli version 2>/dev/null');
  assert.equal(s.checkShows, '{version}');
  assert.equal(s.params[0]!.default, PKG_VERSION);
  // The next ask names its version: the check line says what to expect, where it said "the new version".
  const c = cand(s);
  assert.match(checkLine(c, resolveParams(c.skill.params, { version: '0.22.2' }).values), /npm view acme-cli version 2>\/dev\/null \(it should show 0\.22\.2\)/);
});

test('a publish with an explicit version: the check shows the {version} the steps use', () => {
  const s = ok(compileRun(sheet([
    call('git pull --ff-only'), call('npm version 1.4.0 --no-git-tag-version'), call('npm publish --access public', { tail: '+ acme-cli@1.4.0' }),
    npmView('npm view acme-cli version', '1.4.0'),
  ]), OPTS));
  assert.deepEqual(s.params, [{ name: 'version', shape: 'version', seen: ['1.4.0'] }]);
  assert.equal(s.check, 'npm view acme-cli version');
  assert.equal(s.checkShows, '{version}');
  const c = cand(s);
  const values = resolveParams(c.skill.params, { version: '1.5.0' }).values;
  assert.equal(injectionFor(c, values, 'job', 0).checkVersion, '1.5.0');
  assert.match(checkLine(c, values), /\(it should show 1\.5\.0\)/);
});

test('a tag lookup with git ls-remote --tags is version-shaped: {version} in the check and in what it shows', () => {
  const s = ok(compileRun(sheet([
    call('git tag v1.4.0'), call('git push origin v1.4.0', { tail: ' * [new tag]         v1.4.0 -> v1.4.0' }),
    call('git ls-remote --tags origin refs/tags/v1.4.0', {
      kind: 'look', tail: '4e1c9a2b7d3e9f0a1b2c3d4e5f60718293a4b5c6\trefs/tags/v1.4.0',
      check: { family: 'ls-remote', passed: true, facts: { remote: 'origin', branch: 'refs/tags/v1.4.0' } },
    }),
  ], { job: null, jobWords: [] }), { ...OPTS, moment: 'asked' }));
  assert.equal(s.check, 'git ls-remote --tags origin refs/tags/v{version}');
  assert.equal(s.checkShows, '{version}');
});

test('a release whose version only appears in the check\'s output: refused, no-check, in words that say why', () => {
  const r = compileRun(sheet([call('git pull --ff-only'), call('./scripts/release.sh'), npmView('npm view acme-cli version', '2.0.0')]), OPTS);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no-check');
  assert.equal(r.detail, 'version');
  assert.equal(refusalWords(r.reason, r.detail),
    "the check reads a version, but no step names or makes the version it should show, so it can't tell this release from the last one");
  // The version written in the check alone is no tie either: the next run would check last time's version.
  const pinned = compileRun(sheet([call('git pull --ff-only'), call('./scripts/release.sh'), npmView('npm view acme-cli@2.0.0 version', '2.0.0')]), OPTS);
  assert.deepEqual(pinned.ok ? 'compiled' : [pinned.reason, pinned.detail], ['no-check', 'version']);
  // An asked save refuses the same way: a check that can never pass is worse than none.
  const asked = compileRun(sheet([call('git pull --ff-only'), call('./scripts/release.sh'), npmView('npm view acme-cli version', '2.0.0')]), { ...OPTS, moment: 'asked' });
  assert.deepEqual(asked.ok ? 'compiled' : [asked.reason, asked.detail], ['no-check', 'version']);
  // Any other no-check keeps its words.
  assert.equal(refusalWords('no-check', ''), 'nothing in the run checked that the job worked');
});
