/**
 * D93 (4): a login step is gated (kind `login`). A skill that holds one asks the person right before it runs, and
 * is denied where the host can't ask (D17), like any step that can't be undone without them. Through the wrappers
 * a release uses (`script -q /dev/null npm login`, a piped answer, `env`, `npx`). The patterns stay linear on a
 * 2 MB command. Made-up skill, session and repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatedAnywhere, gatedKind, gatedWhat } from '../src/skills/risk.js';
import { neverSave } from '../src/skills/never-save.js';
import { parseSkillMd, renderSkillMd } from '../src/skills/skillmd.js';
import { preBashSkills } from '../src/claude/pre-bash-skills.js';
import { programOf } from '../src/trace/shell.js';
import { gateFilePath, type GateFile } from '../src/trace/gate-file.js';
import { at, box, done, session } from './claude-skills-journey-fixtures.js';
import { releaseSkill } from './skills-recall-fixtures.js';
import { timeBar } from './machine-speed.js';

const LOGINS = [
  'npm login', 'npm adduser', 'npm login --registry https://registry.npmjs.org', 'npm --registry=https://npm.acme.dev login', 'pnpm login', 'yarn npm login',
  'gh auth login', 'gh auth login --web', 'vercel login', 'docker login', 'docker login ghcr.io', 'aws configure', 'aws configure --profile acme',
  'aws configure sso', 'aws sso login', 'aws sso login --profile acme', 'gcloud auth login', 'gcloud auth application-default login',
  'firebase login', 'heroku login', 'heroku auth:login', 'az login',
  // Through wrappers, as a release runs it.
  'script -q /dev/null npm login', "(sleep 15; printf '\\n'; sleep 300) | script -q /dev/null npm login",
  'env NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm login', 'npx vercel login', 'npx firebase-tools login', 'cd packages/cli && npm login',
];
const NOT_LOGINS = [
  'npm whoami', 'npm test -- --grep login', 'npm run build', 'gh auth status', 'gh auth token --help-less', 'aws configure get region', 'aws configure list',
  'aws s3 ls', 'docker logout', 'docker ps', 'gcloud auth list', 'vercel ls', 'heroku logs --tail', 'az account show', 'cat login.md', 'git log --oneline',
];

test('the login steps are gated, through any wrapper; the look-alikes are not', () => {
  for (const cmd of LOGINS) assert.equal(gatedKind(cmd), 'login', cmd);
  for (const cmd of LOGINS) assert.ok(gatedAnywhere(cmd).has('login'), cmd);
  for (const cmd of NOT_LOGINS) assert.notEqual(gatedKind(cmd), 'login', cmd);
  // A password written in the step is still never saved at all.
  assert.ok(neverSave('docker login -u bot -p hunter2hunter2 ghcr.io'));
  assert.equal(neverSave('npm login'), null);
});

test('gatedWhat names the service the step logs in to', () => {
  assert.equal(gatedWhat('login', 'script -q /dev/null npm login', {}), 'logs in to npm');
  assert.equal(gatedWhat('login', 'gh auth login', {}), 'logs in to GitHub');
  assert.equal(gatedWhat('login', 'vercel login', {}), 'logs in to Vercel');
  assert.equal(gatedWhat('login', 'docker login ghcr.io', {}), 'logs in to the image registry');
  assert.equal(gatedWhat('login', 'aws sso login', {}), 'logs in to AWS');
  assert.equal(gatedWhat('login', 'gcloud auth login', {}), 'logs in to Google Cloud');
  assert.equal(gatedWhat('login', 'firebase login', {}), 'logs in to Firebase');
  assert.equal(gatedWhat('login', 'heroku login', {}), 'logs in to Heroku');
  assert.equal(gatedWhat('login', 'az login', {}), 'logs in to Azure');
});

test('a SKILL.md step that logs in reads back as gated', () => {
  const skill = releaseSkill({}, {
    steps: [
      { n: 1, cmd: 'npm run build', gated: null, bg: false, wait: false },
      { n: 2, cmd: 'script -q /dev/null npm login', gated: 'login', bg: false, wait: false },
      { n: 3, cmd: 'npm publish', gated: 'publish', bg: false, wait: false },
    ],
  });
  const parsed = parseSkillMd(renderSkillMd(skill), skill.name);
  assert.deepEqual(parsed?.steps.map((s) => s.gated), [null, 'login', 'publish']);
});

const LOGIN = "(sleep 15; printf '\\n'; sleep 300) | script -q /dev/null npm login";

function rigFor(tag: string, opts: { mode?: string; env?: Record<string, string> } = {}) {
  const b = box(tag);
  const s = session(b, { mode: opts.mode });
  const env = { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 0), ...opts.env };
  const gate: GateFile = {
    v: 1, epoch: 0,
    live: [{
      injId: 'i-0002', name: 'release-npm', skillId: 'sk-0002', params: {}, steps: ['npm run build', LOGIN, 'npm publish'], check: 'npm view acme-cli version',
      groups: [
        { kind: 'login', steps: [{ n: 2, text: LOGIN, program: programOf(LOGIN) }], askedAt: null, askedToolUseId: null, approvedAt: null, askedStep: null },
        { kind: 'publish', steps: [{ n: 3, text: 'npm publish', program: programOf('npm publish') }], askedAt: null, askedToolUseId: null, approvedAt: null, askedStep: null },
      ],
    }],
  };
  const path = gateFilePath(s.sid, env);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(gate));
  const input = (command: string, id: string) => ({ ...s.payload, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  return { b, env, input };
}

test('PreToolUse asks before a skill\'s login step, and denies it where the host can\'t ask (D17)', async () => {
  const r = rigFor('login-ask');
  try {
    const d = await preBashSkills(r.input(LOGIN, 'toolu_l1'), r.b.repo, r.env);
    assert.deepEqual(d, { permissionDecision: 'ask', reason: "trail: this logs in to npm and can't be undone (release-npm, step 2)." });
    // The same login through another wrapper is the same step's ask.
    const other = await preBashSkills(r.input('env CI=1 npm login', 'toolu_l2'), r.b.repo, r.env);
    assert.equal(other?.permissionDecision, 'ask');
  } finally {
    done(r.b);
  }
  const h = rigFor('login-headless', { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
  try {
    const d = await preBashSkills(h.input(LOGIN, 'toolu_h1'), h.b.repo, h.env);
    assert.equal(d?.permissionDecision, 'deny');
    assert.match(d!.reason, /^trail: Trail, the tool this person installed to keep commands that worked as skills, stopped step 2 of skill release-npm: it logs in to npm and can't be undone, and this session can't ask the person first\. So don't run it, and don't try it again this turn, even after a yes in chat; ask the person to run this command/);
  } finally {
    done(h.b);
  }
});

test('the login pattern reads a 2 MB command in linear time', () => {
  // In a child process with a cap: a regex that backtracks blocks the event loop, so a test timeout can't stop it in here.
  const probe = `
    const { gatedKind, gatedAnywhere } = await import(${JSON.stringify(new URL('../src/skills/risk.ts', import.meta.url).href)});
    const big = 2 * 1024 * 1024;
    const units = ['npm --a ', 'npm --a b ', 'npm ', 'pnpm --registry x ', 'aws ', 'aws --a b ', 'aws configure ', 'gcloud auth ', 'gh auth ',
      'script -q /dev/null npm ', 'yarn npm ', 'firebase ', 'heroku auth:', 'docker ', 'az ', 'npm login '];
    const out = units.map((u) => {
      const c = u.repeat(Math.floor(big / u.length));
      let best = Infinity;
      for (let k = 0; k < 3; k++) { const t = process.cpuUsage(); gatedAnywhere(c); gatedKind(c); const d = process.cpuUsage(t); best = Math.min(best, (d.user + d.system) / 1000); }
      return { u, ms: Math.round(best) };
    });
    process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.signal, null, 'the gated patterns ran past 60 s');
  const bar = timeBar(1500, 4500);
  for (const row of JSON.parse(r.stdout) as Array<{ u: string; ms: number }>) assert.ok(row.ms < bar, `${JSON.stringify(row)} over ${bar} ms`);
});
