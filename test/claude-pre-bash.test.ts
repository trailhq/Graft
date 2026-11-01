/**
 * PreToolUse on Bash: the hook that runs before every shell command.
 *
 * It must cost next to nothing and never stand in the way: the shim sends it
 * to its own small module (pre-bash.js) rather than the whole CLI, any error
 * or bad stdin leaves it silent with exit 0, and in phase 0 it decides
 * nothing at all. These tests run the real generated shim against the real
 * module, transpiled into a fake installed package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { preBash, preBashOutput } from '../src/claude/pre-bash.js';
import { hooksShim } from '../src/claude/shim-template.js';
import { mergeGraftSettings } from '../src/claude/settings-merge.js';
import { tmpRepo } from './helpers.js';
import { RELAY_LINE } from '../src/init/relay.js';
import { timeBar } from './machine-speed.js';

const SRC = resolve('src');
/** Loaded by `import()` only for a `skills add` command (pre-bash-skills.ts). */
const SAVE_GATE = 'skills/save-gate.ts';
const BASH = { session_id: 's1', transcript_path: '/tmp/x/t.jsonl', cwd: '/tmp/x', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } };
/** What else reaches the hook: a non-Bash tool, and the payloads Cursor and Copilot CLI send when they run the repo's Claude hooks. */
const OTHER_PAYLOADS = [
  JSON.stringify({ ...BASH, tool_name: 'Write', tool_input: { file_path: '/tmp/x/a.ts', content: 'x' } }),
  JSON.stringify({ conversation_id: 'c1', generation_id: 'g1', cursor_version: '1.7.0', workspace_roots: ['/tmp/x'], hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'npm test' } }),
  JSON.stringify({ sessionId: 's1', timestamp: 1760000000000, cwd: '/tmp/x', toolName: 'bash', toolArgs: '{"command":"npm test"}' }),
];

/**
 * Every src file `entry` can load at run time: static imports (`import type`
 * left out), plus `import('…')` ones unless `staticOnly`. Files in `skip`
 * (paths under src/) and what only they load are left out.
 */
function importClosure(entry: string, staticOnly = false, skip: string[] = []): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const skipped = new Set(skip.map((f) => join(SRC, f)));
  const walk = (file: string) => {
    if (files.has(file) || skipped.has(file)) return;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    const specs = [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
    if (!staticOnly) specs.push(...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!));
    for (const spec of specs) {
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else packages.add(spec);
    }
  };
  walk(entry);
  return { files: [...files], packages: [...packages] };
}

/**
 * A fake installed `@trailhq/trail-code` in `<project>/node_modules`, whose
 * `dist/` holds the pre-bash module and everything it imports, transpiled from
 * src the way tsc builds it. `extra` adds or overrides dist files.
 */
function fakePackage(project: string, extra: Record<string, string> = {}, withPreBash = true): string {
  const pkg = join(project, 'node_modules', '@trailhq', 'trail-code');
  mkdirSync(join(pkg, 'dist', 'claude'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@trailhq/trail-code', version: '99.0.0', type: 'module' }));
  writeFileSync(join(pkg, 'dist', 'claude', 'hooks.js'), 'export function main() {}\n');
  if (withPreBash) {
    // The save gate's closure (the store, compile, the session) is loaded only for `skills add`; these shim tests never reach it.
    for (const file of importClosure(join(SRC, 'claude', 'pre-bash.ts'), false, [SAVE_GATE]).files) {
      const out = join(pkg, 'dist', relative(SRC, file).replace(/\.ts$/, '.js'));
      mkdirSync(dirname(out), { recursive: true });
      const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(out, js);
    }
  }
  for (const [path, text] of Object.entries(extra)) writeFileSync(join(pkg, 'dist', path), text);
  return pkg;
}

/** A project with the hooks shim committed in `.claude/helpers/`, as `trail init` writes it. */
function project(tag: string): { dir: string; shim: string; home: string } {
  const dir = tmpRepo(tag);
  const shim = join(dir, '.claude', 'helpers', 'trail-hooks.cjs');
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, hooksShim());
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return { dir, shim, home };
}

/**
 * Keeps the machine's own trail or graft install out of the child, so the
 * shim sees only the fixture (see claude-shim-resolve.test.ts for why each
 * route matters): `execPath` repointed by a preload, PATH without a
 * `trail`/`graft` command, `npm root -g` answering from an empty prefix.
 */
function isolated(dir: string, extraPath: string[] = []): { args: string[]; env: NodeJS.ProcessEnv } {
  const preload = join(dir, 'no-ambient-trail.cjs');
  writeFileSync(preload, `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(join(dir, 'node-prefix', 'bin', 'node'))}, configurable: true });\n`);
  const prefix = join(dir, 'npm-prefix');
  mkdirSync(prefix, { recursive: true });
  const ambient = (d: string) => ['trail', 'graft', 'trail.cmd', 'graft.cmd'].some((b) => existsSync(join(d, b)));
  const path = [...extraPath, ...(process.env.PATH ?? '').split(delimiter).filter((d) => d && !ambient(d))];
  return { args: ['--require', preload], env: { npm_config_prefix: prefix, PATH: path.join(delimiter) } };
}

function runShim(p: { dir: string; shim: string; home: string }, stdin: string, opts: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [...(opts.args ?? []), p.shim, 'pre-bash'], {
    cwd: p.dir,
    input: stdin,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, HOME: p.home, USERPROFILE: p.home, TRAIL_HOME: join(p.home, '.trail'), CLAUDE_PROJECT_DIR: p.dir, TRAIL_NO_HOOKS: '', ...opts.env },
  });
}

test('preBash decides nothing in phase 0, and takes any input without throwing', () => {
  for (const input of [BASH, {}, null, undefined, 'x', [], { tool_input: { command: 42 } }, { tool_name: 'Bash', tool_input: null }]) {
    assert.equal(preBash(input, '/tmp/x'), null, JSON.stringify(input) ?? 'undefined');
  }
});

test('preBashOutput answers in the PreToolUse shape, and stays silent on anything else', () => {
  const reply = preBashOutput(BASH, '/tmp/x', () => ({ permissionDecision: 'ask', reason: 'this publishes 1.2.3 and cannot be undone' }));
  assert.deepEqual(JSON.parse(reply), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'this publishes 1.2.3 and cannot be undone' } });
  assert.equal(preBashOutput(BASH, '/tmp/x'), '', 'phase 0: nothing');
  assert.equal(preBashOutput(BASH, '/tmp/x', () => { throw new Error('broken learning file'); }), '', 'a throw lets the command through');
  for (const bad of [{ permissionDecision: 'block', reason: 'x' }, { permissionDecision: 'deny' }, { permissionDecision: 'deny', reason: 7 }, 'deny', 0]) {
    assert.equal(preBashOutput(BASH, '/tmp/x', () => bad as never), '', `malformed decision ${JSON.stringify(bad)} is never sent`);
  }
});

/** Loaded only for a `trail keep` command (see the tests at the end of this file). */
const KEEP_GATE = 'init/keep-gate.ts';

test('the PreToolUse module loads only node builtins and small files, never the CLI', () => {
  const { files, packages } = importClosure(join(SRC, 'claude', 'pre-bash.ts'), false, [KEEP_GATE, SAVE_GATE]);
  assert.deepEqual(packages.filter((p) => !p.startsWith('node:')), [], 'no npm package');
  const names = files.map((f) => relative(SRC, f).split('\\').join('/'));
  for (const heavy of ['cli.ts', 'claude/hooks.ts', 'upkeep.ts', 'upkeep-run.ts']) assert.ok(!names.includes(heavy), `${heavy} stays out`);
  assert.ok(!names.some((n) => /^(telemetry|graph|ask|notes|cloud)\//.test(n)), `nothing heavier: ${names.join(', ')}`);
  // Itself, the one-copy check (hook-layers, brand, host), the skills fast path below, and the
  // commit check (pre-bash-check.ts), loaded only before a commit, a push or a PR.
  assert.ok(files.length <= 13, `a small closure: ${names.join(', ')}`);
  // Loading it costs nothing but itself: no other file, and no ESM import of
  // node:fs, which alone costs Node several ms before every shell command.
  const atLoad = importClosure(join(SRC, 'claude', 'pre-bash.ts'), true);
  assert.deepEqual(atLoad.files.map((f) => relative(SRC, f).split('\\').join('/')), ['claude/pre-bash.ts']);
  assert.deepEqual(atLoad.packages, []);
});

test('the skills fast path (pre-bash-skills.ts, up to the save gate) is at most 9 small files that load only node:path and node:os', () => {
  const { files, packages } = importClosure(join(SRC, 'claude', 'pre-bash-skills.ts'), false, [SAVE_GATE]);
  const names = files.map((f) => relative(SRC, f).split('\\').join('/'));
  // 1b (R20): the ninth is trace/guard-fast.ts, the sure-fail guardrail (4.11); it imports only files already on the path.
  assert.ok(names.includes('trace/guard-fast.ts'), names.join(', '));
  assert.ok(files.length <= 9, `at most 9: ${names.join(', ')}`);
  assert.ok(!names.some((n) => /^(telemetry|graph|ask|notes|cloud)\//.test(n) || n === 'cli.ts'), `nothing heavier: ${names.join(', ')}`);
  assert.deepEqual(packages.filter((p) => p !== 'node:path' && p !== 'node:os'), [], `builtins only, and never node:fs: ${packages.join(', ')}`);
  // No file on it reaches for the session state, compile or the store at load.
  for (const n of names) assert.ok(!/^(trace\/(skill-session|runs|claude)|skills\/(compile|store|save-gate))\.ts$/.test(n), n);
});

test('the save gate\'s closure has no CLI, graph, ask, cloud or telemetry', () => {
  const { files } = importClosure(join(SRC, SAVE_GATE));
  const names = files.map((f) => relative(SRC, f).split('\\').join('/'));
  assert.ok(!names.some((n) => n === 'cli.ts' || /^(telemetry|graph|ask|cloud)\//.test(n)), names.filter((n) => n === 'cli.ts' || /^(telemetry|graph|ask|cloud)\//.test(n)).join(', '));
});

test('the shim sends PreToolUse to pre-bash.js, never to hooks.js', () => {
  const p = project('pre-bash-route');
  const ran = join(p.dir, 'ran.json');
  const record = (name: string) => `import { appendFileSync } from 'node:fs';\nexport function main(event) { appendFileSync(${JSON.stringify(ran)}, JSON.stringify([${JSON.stringify(name)}, event]) + '\\n'); }\n`;
  fakePackage(p.dir, { 'claude/pre-bash.js': record('pre-bash.js'), 'claude/hooks.js': record('hooks.js') });
  const r = runShim(p, JSON.stringify(BASH));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(ran, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), [['pre-bash.js', 'pre-bash']]);
});

test('a plain command with no gate file loads none of the skills code; a skills command or a live gate file does', () => {
  const p = project('pre-bash-prefilter');
  const loaded = join(p.dir, 'loaded.txt');
  const mark = (name: string, body: string) => `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(loaded)}, ${JSON.stringify(name)} + '\\n');\n${body}`;
  fakePackage(p.dir, {
    'claude/pre-bash-skills.js': mark('pre-bash-skills', 'export async function preBashSkills() { return null; }\n'),
    'claude/hook-layers.js': mark('hook-layers', 'export function globalCopyCovers() { return false; }\n'),
  });
  const run = (command: string) => {
    rmSync(loaded, { force: true });
    const r = runShim(p, JSON.stringify({ ...BASH, tool_input: { command } }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    return existsSync(loaded) ? readFileSync(loaded, 'utf8').trim().split('\n') : [];
  };
  for (const command of ['npm test', 'echo skillset', 'cat README.md']) assert.deepEqual(run(command), [], command);
  // A push runs trail check first (pre-bash-check.ts), after the one-copy check; never the skills part.
  assert.deepEqual(run('git push origin beta'), ['hook-layers'], 'git push origin beta');
  assert.deepEqual(run('trail skills on'), ['hook-layers', 'pre-bash-skills'], 'the one-copy check first, then the skills part');
  assert.deepEqual(run('tr""ail sk\'ills\' on'), ['hook-layers', 'pre-bash-skills'], 'quotes inside the words still read as skills');
  assert.deepEqual(run('node ~/.claude/helpers/trail-hooks.cjs prompt'), ['hook-layers', 'pre-bash-skills'], 'a hook script by hand');
  const gate = join(p.home, '.trail', 'sessions', `${BASH.session_id}.gate.json`);
  mkdirSync(dirname(gate), { recursive: true });
  writeFileSync(gate, '{}');
  assert.deepEqual(run('npm test'), ['hook-layers', 'pre-bash-skills'], 'a live gate file');
});

test('the shim runs PreToolUse silently with exit 0, whatever arrives on stdin', () => {
  const p = project('pre-bash-stdin');
  fakePackage(p.dir);
  for (const stdin of ['', 'not json', '{"tool_input":', 'null', '[]', '42', '"Bash"', '{}', JSON.stringify({ tool_input: null }), 'x'.repeat(200_000), JSON.stringify(BASH), ...OTHER_PAYLOADS]) {
    const r = runShim(p, stdin);
    const what = stdin.length > 40 ? `${stdin.slice(0, 40)}…` : stdin;
    assert.equal(r.status, 0, `exit 0 for ${what}: ${r.stderr}`);
    assert.equal(r.stdout, '', `no output for ${what}`);
    assert.equal(r.stderr, '', `nothing on stderr for ${what}`);
  }
});

test('a broken pre-bash module in the package still lets every command through', () => {
  for (const [label, text] of [
    ['throws on load', "throw new Error('boom');\n"],
    ['main throws', "export function main() { throw new Error('boom'); }\n"],
    ['not even JavaScript', 'export function main( {\n'],
  ]) {
    const p = project('pre-bash-broken');
    fakePackage(p.dir, { 'claude/pre-bash.js': text });
    const r = runShim(p, JSON.stringify(BASH));
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.equal(r.stdout, '', label);
  }
});

test('an older package without the PreToolUse module is not loaded whole for it', () => {
  const p = project('pre-bash-older');
  const marker = join(p.dir, 'hooks-loaded');
  // An older release: hooks.js, which pulls in everything, and no pre-bash.js.
  fakePackage(p.dir, { 'claude/hooks.js': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport function main() {}\n` }, false);
  const r = runShim(p, JSON.stringify(BASH), isolated(p.dir));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(marker), false, 'the shell command waits on nothing heavy');
});

test('with no installed package at all, the shim does nothing, and never runs npm to look', () => {
  const p = project('pre-bash-missing');
  const bin = join(p.dir, 'fake-bin');
  const marker = join(p.dir, 'npm-ran');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'npm.cmd'), `@echo ran > "${marker}"\r\n`);
  const r = runShim(p, JSON.stringify(BASH), isolated(p.dir, [bin]));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(marker), false, 'no `npm root -g` before a shell command');
});

/** The repo's PreToolUse command as `trail init` writes it, run through the platform shell from `p.dir`. */
function hostRun(p: { dir: string; home: string }) {
  const command = mergeGraftSettings({}, { name: 'trail' }).merged.hooks.PreToolUse[0].hooks[0].command as string;
  const env = { ...process.env, HOME: p.home, USERPROFILE: p.home, TRAIL_HOME: join(p.home, '.trail'), CLAUDE_PROJECT_DIR: p.dir, TRAIL_NO_HOOKS: '' };
  return spawn(command, { shell: true, cwd: p.dir, env, stdio: 'pipe' });
}

/** Exit code, stdout and how long it took, for a child whose stdin `feed` writes to and may never close. */
function settle(child: ReturnType<typeof spawn>, feed: (stdin: NodeJS.WritableStream) => void, giveUpMs = 8000): Promise<{ code: number | null; stdout: string; ms: number }> {
  const t = Date.now();
  let stdout = '';
  child.stdout!.on('data', (d) => { stdout += d; });
  child.stdin!.on('error', () => { /* the hook may stop reading early */ });
  feed(child.stdin!);
  return new Promise((done) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), giveUpMs);
    child.on('exit', (code) => { clearTimeout(kill); done({ code, stdout, ms: Date.now() - t }); });
  });
}

test('a payload whose stdin never closes ends the hook with exit 0, inside the host timeout', async () => {
  const p = project('pre-bash-open-stdin');
  fakePackage(p.dir);
  const child = hostRun(p);
  // 4.5 s where the bar was set, scaled, never under 13.5 s; the child is killed 3.5 s past it, which fails the exit code.
  const bar = timeBar(4500, 13_500);
  const r = await settle(child, (stdin) => stdin.write('{"tool_name":"Bash","tool_input":{"command":"npm'), bar + 3500);
  child.stdin!.destroy();
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < bar, `gave up after ${r.ms} ms: the host allows 5000`);
});

test('a 5 MB payload is read to its end and lets the command through, quickly and silently', async () => {
  const p = project('pre-bash-huge-stdin');
  fakePackage(p.dir);
  const huge = JSON.stringify({ ...BASH, tool_input: { command: `cat > /tmp/x/big.txt <<'EOF'\n${'a'.repeat(5 * 1024 * 1024)}\nEOF` } });
  const bar = timeBar(4500, 13_500);
  const r = await settle(hostRun(p), (stdin) => stdin.end(huge), bar + 3500);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < bar, `took ${r.ms} ms`);
});

/**
 * The 50 ms budget is what trail adds to each shell command: the shim finding
 * the package, loading pre-bash.js and reading the payload. Node's own start
 * is a floor no Node hook gets under, and on a loaded machine it is past 50 ms
 * alone, so each hook spawn is paired with a bare `node -e ''` run right
 * beside it and the budget is held against the difference. Both absolute
 * numbers are printed too.
 */
test('PreToolUse through the shim adds under 50 ms at p95, skills off, on, with a live gate file, and with a kept guardrail, on Claude Code and Codex payloads (TRAIL_PERF=1)', { skip: process.env.TRAIL_PERF === '1' ? false : 'set TRAIL_PERF=1 to time it' }, () => {
  const p = project('pre-bash-perf');
  fakePackage(p.dir);
  const stdin = JSON.stringify(BASH);
  // One Trail home per case, timed in turn beside a bare node, so a busy machine weighs on each the same.
  const home = (tag: string, on: boolean, gate: boolean, guardrail = false) => {
    const trail = join(p.home, `.trail-${tag}`);
    mkdirSync(join(trail, 'sessions'), { recursive: true });
    // 1b: the no-timeout guardrail kept (J16), read by the sure-fail guard only for a `timeout N` command.
    if (guardrail) {
      mkdirSync(join(trail, 'learnings'), { recursive: true });
      writeFileSync(join(trail, 'learnings', 'no-timeout.md'), '---\ntitle: "No timeout on this Mac"\nauthor: ""\ndate: 2026-10-17\nkind: "guardrail"\ncheck: "no-timeout"\nenforce: "sure-fail"\napplies: "every repo"\n---\nThis Mac has no `timeout`.\n');
    }
    if (on) writeFileSync(join(trail, 'settings.json'), JSON.stringify({ v: 1, skills: 'on', onSince: '2026-08-01T00:00:00.000Z' }));
    // A live block with a step that can't be undone: the skills part loads and finds no step in `npm test`.
    if (gate) writeFileSync(join(trail, 'sessions', 's1.gate.json'), JSON.stringify({ v: 1, epoch: 0, live: [{ injId: 'i-1', name: 'release-npm', skillId: 'sk-1', params: {}, steps: ['npm publish'], check: null,
      groups: [{ kind: 'publish', steps: [{ n: 1, text: 'npm publish', program: 'npm publish' }], askedAt: null, askedToolUseId: null, approvedAt: null }] }] }));
    return { ...process.env, HOME: p.home, USERPROFILE: p.home, TRAIL_HOME: trail, CLAUDE_PROJECT_DIR: p.dir, TRAIL_NO_HOOKS: '' };
  };
  const cases: Record<string, NodeJS.ProcessEnv> = {
    'skills off': home('off', false, false), 'skills on, no gate file': home('on', true, false), 'skills on, a live gate file': home('gate', true, true),
    'skills on, a kept guardrail': home('guard', true, false, true),
  };
  // A `timeout N` command with the guardrail kept, on a PATH with no timeout: the guard reads the file and denies.
  const TIMEOUT_RUN = JSON.stringify({ ...BASH, tool_input: { command: 'timeout 60 npm test' } });
  const denies = new Set(['a kept guardrail, a timeout command']);
  cases['a kept guardrail, a timeout command'] = { ...home('guard-run', true, false, true), PATH: dirname(process.execPath) };
  // Phase 2 (rule 9): Codex's payload (turn_id, a rollout path), skills on and with a live gate file.
  const CODEX = JSON.stringify({ ...BASH, transcript_path: '/tmp/x/.codex/sessions/2026/10/27/rollout-2026-10-27T10-00-00-s1.jsonl', turn_id: 'turn-1', model: 'gpt-5-codex', permission_mode: 'default', tool_use_id: 'call_1' });
  const codex = new Set(['Codex, skills on', 'Codex, a live gate file']);
  cases['Codex, skills on'] = home('cx-on', true, false);
  cases['Codex, a live gate file'] = home('cx-gate', true, true);
  const time = (args: string[], env: NodeJS.ProcessEnv, what = '') => {
    const t = process.hrtime.bigint();
    const input = args[0] !== p.shim ? stdin : denies.has(what) ? TIMEOUT_RUN : codex.has(what) ? CODEX : stdin;
    const r = spawnSync(process.execPath, args, { cwd: p.dir, input, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    // Denied where this machine has no timeout anywhere the guard looks; let through where it has one.
    if (denies.has(what) && args[0] === p.shim) assert.ok(r.stdout === '' || /"permissionDecision":"deny"/.test(r.stdout), r.stdout);
    else assert.equal(r.stdout, '');
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
  const runs = 200;
  const added: Record<string, number[]> = {};
  const hook: Record<string, number[]> = {};
  const bare: number[] = [];
  for (const [what, env] of Object.entries(cases)) time([p.shim, 'pre-bash'], env, what); // warm the disk cache once
  for (let i = 0; i < runs; i++) {
    for (const [what, env] of Object.entries(cases)) {
      const b = time(['-e', ''], env);
      const h = time([p.shim, 'pre-bash'], env, what);
      bare.push(b);
      (hook[what] ??= []).push(h);
      (added[what] ??= []).push(h - b);
    }
  }
  const lines = Object.keys(cases).map((what) =>
    `PreToolUse (${what}) adds p95 ${p95(added[what]!).toFixed(1)} ms over ${runs} spawns (hook p95 ${p95(hook[what]!).toFixed(1)} ms end to end)`);
  const summary = `${lines.join('; ')}; bare node p95 ${p95(bare).toFixed(1)} ms on this machine`;
  console.log(summary);
  for (const what of Object.keys(cases)) assert.ok(p95(added[what]!) < 50, summary);
});

test('an older shim that sends pre-bash to hooks.js gets the same silent answer, before any other hook work', async () => {
  const { main } = await import('../src/claude/hooks.js');
  const dir = tmpRepo('pre-bash-old-shim');
  const saved = { stdin: process.env.GRAFT_TEST_STDIN, project: process.env.CLAUDE_PROJECT_DIR, brand: process.env.TRAIL_INVOKED_AS, trail: process.env.TRAIL_HOME };
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as { write: unknown }).write = (chunk: unknown) => { out += String(chunk); return true; };
  try {
    process.env.CLAUDE_PROJECT_DIR = dir;
    process.env.TRAIL_HOME = join(dir, '.trail-home');   // never the real ~/.trail's session files
    for (const stdin of ['', 'not json', '[]', JSON.stringify(BASH)]) {
      delete process.env.TRAIL_INVOKED_AS;
      process.env.GRAFT_TEST_STDIN = stdin;
      await main('pre-bash');
      // The brand probe reads the repo's wiring for every other event; this
      // one runs before every shell command and goes straight to pre-bash.
      assert.equal(process.env.TRAIL_INVOKED_AS, undefined, `no repo probing for ${stdin || '(empty)'}`);
    }
  } finally {
    (process.stdout as { write: unknown }).write = write;
    for (const [key, value] of [['GRAFT_TEST_STDIN', saved.stdin], ['CLAUDE_PROJECT_DIR', saved.project], ['TRAIL_INVOKED_AS', saved.brand], ['TRAIL_HOME', saved.trail]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(out, '');
});

/* ---- trail keep waits for the person's answer ---- */

/** A transcript where the agent ran `trail init` and got the list back, then maybe the person answered. */
function initTranscript(dir: string, answered: boolean): string {
  const path = join(dir, 'session.jsonl');
  const line = (o: object) => JSON.stringify({ sessionId: 's1', cwd: dir, timestamp: '2026-10-01T10:00:00Z', ...o });
  const list = `${RELAY_LINE}\n  1. Explain it simply · you said it on 4 days · just for you, in this repo\nKeep: trail keep <numbers> · none: trail keep none`;
  const rows = [
    line({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'set up trail here' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'trail init --agents claude' } }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: list }] } }),
    ...(answered ? [line({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'keep 1' } })] : []),
  ];
  writeFileSync(path, rows.join('\n') + '\n');
  return path;
}
const keepCall = (transcript: string, command = 'trail keep 1') => JSON.stringify({ ...BASH, transcript_path: transcript, tool_input: { command } });

test('trail keep\'s check loads only node builtins and the transcript reader, never the CLI, telemetry, graph or cloud', () => {
  const { files, packages } = importClosure(join(SRC, 'init', 'keep-gate.ts'));
  assert.deepEqual(packages.filter((p) => !p.startsWith('node:')), [], 'no npm package');
  const names = files.map((f) => relative(SRC, f).split('\\').join('/'));
  for (const heavy of ['cli.ts', 'claude/hooks.ts', 'upkeep.ts', 'upkeep-run.ts', 'init/review.ts', 'init/look-back.ts']) assert.ok(!names.includes(heavy), `${heavy} stays out`);
  assert.ok(!names.some((n) => /^(telemetry|graph|ask|cloud)\//.test(n)), `nothing heavier: ${names.join(', ')}`);
});

test('an unanswered trail keep is denied through the real shim, with the reason; answered, a list no init record waits on is still denied (1b, R22)', () => {
  const p = project('pre-bash-keep');
  fakePackage(p.dir);
  const denied = runShim(p, keepCall(initTranscript(p.dir, false)));
  assert.equal(denied.status, 0, denied.stderr);
  const out = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /isn't the one waiting in this repo/);
  const answered = runShim(p, keepCall(initTranscript(p.dir, true)));
  assert.equal(answered.status, 0, answered.stderr);
  assert.match(JSON.parse(answered.stdout).hookSpecificOutput.permissionDecisionReason, /isn't the one waiting in this repo/);
});

test('any other shell command never loads trail keep\'s check', () => {
  const p = project('pre-bash-keep-lazy');
  const marker = join(p.dir, 'keep-gate-loaded');
  fakePackage(p.dir, { 'init/keep-gate.js': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport function keepDecision() { return null; }\n` });
  const transcript = initTranscript(p.dir, false);
  for (const command of ['npm test', 'git status', 'trail init']) {
    const r = runShim(p, keepCall(transcript, command));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
  assert.equal(existsSync(marker), false);
  runShim(p, keepCall(transcript));
  assert.equal(existsSync(marker), true, 'and trail keep does load it');
});

test('a broken trail keep check lets the command through', () => {
  const p = project('pre-bash-keep-broken');
  fakePackage(p.dir, { 'init/keep-gate.js': "throw new Error('boom');\n" });
  const r = runShim(p, keepCall(initTranscript(p.dir, false)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
