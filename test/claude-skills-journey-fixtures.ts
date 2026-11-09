/**
 * A sandbox for driving the real hooks end to end (design 5, g7-wiring):
 * every call goes through `main(event)` with the `GRAFT_TEST_STDIN` seam, a
 * Trail home and a person home of their own (a test home, so the test clock
 * `TRAIL_TEST_NOW` works), and a synthetic Claude Code transcript that grows
 * between calls. Made-up repos and prompts only. Not a test file itself.
 *
 * Where things are: the made-up checkout (acme/shop, a `.git` with its
 * origin) sits in the temp folder, which the skills gate reads as a scratch
 * folder (no learning there), so the payloads name a `cwd` of
 * `/home/dev/shop` and the Trail home's repo index points that folder's key
 * at acme/shop, the record Trail keeps for a moved repo. The transcript's
 * own rows carry the real checkout as their `cwd`, as Claude Code writes
 * them. Nothing in the hooks is swapped out.
 */
import { accessSync, appendFileSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { tmpRepo } from './helpers.js';
import { jsonl, said, toolResult, toolUse, typed } from './trace-fixtures.js';
import { main as hooksMain } from '../src/claude/hooks.js';
import { main as preBashMain } from '../src/claude/pre-bash.js';
import { sessionPath } from '../src/trace/gate-file.js';
import { cliAdd } from '../src/skills/save-gate.js';
import { repoPlace } from '../src/notes/home.js';
import { timeoutOnPath } from '../src/trace/guard-fast.js';
import type { SkillSessionState } from '../src/trace/types.js';

export const SHOP = 'github.com/acme/shop';
export const CWD = '/home/dev/shop';

export interface Box {
  root: string; repo: string; home: string; trail: string; project: string; stub: string;
  /** Extra env for every hook call of this box (TRAIL_HOST_FACTS, CLAUDE_CODE_ENTRYPOINT, ...). */
  env: Record<string, string>;
  /** Extra keys on every transcript row of this box (`entrypoint: 'sdk-cli'` for a headless-shaped transcript). */
  row: Record<string, unknown>;
  ids: number;
}

export interface Session { b: Box; sid: string; tx: string; mode: string; payload: Record<string, unknown> }

let noTimeout: string | null = null;
/**
 * This process's PATH with no `timeout` on it, for the J16 tests: a folder that holds one (Linux's /usr/bin)
 * is swapped for a folder of links to everything else in it, so git and the rest still run.
 */
export function pathWithoutTimeout(): string {
  if (noTimeout !== null) return noTimeout;
  const root = mkdtempSync(join(tmpdir(), 'no-timeout-path-'));
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d, i) => {
    try {
      const t = join(d, 'timeout');
      if (!statSync(t).isFile()) return d;
      accessSync(t, constants.X_OK);
    } catch {
      return d;
    }
    const mirror = join(root, String(i));
    mkdirSync(mirror);
    for (const name of readdirSync(d)) if (name !== 'timeout') symlinkSync(join(d, name), join(mirror, name));
    return mirror;
  });
  noTimeout = dirs.join(delimiter);
  return noTimeout;
}

/**
 * Why the no-timeout guardrail can't deny on this machine, or false: Trail still finds a `timeout` once PATH is
 * cleared of the ones a test can hide (and with a home of no folders). A system folder of 4.11 holds one (Homebrew's
 * coreutils), or this is Windows, which ships System32\timeout.exe on every PATH: a `timeout N` command never
 * surely fails there, so the deny never comes, by design.
 */
export function timeoutSeen(): string | false {
  const home = join(tmpdir(), 'no-timeout-home-none');
  const env = { PATH: pathWithoutTimeout(), PATHEXT: process.env.PATHEXT, HOME: home, USER: process.env.USER };
  if (!timeoutOnPath(env)) return false;
  return process.platform === 'win32' ? 'Windows has System32\\timeout.exe on every PATH' : 'this machine has a timeout in a system folder';
}

let boxes = 0;

/** Skills on since August, offers on, the repo index pointing /home/dev/shop at acme/shop. */
export function box(tag: string, opts: { settings?: Record<string, unknown>; env?: Record<string, string>; row?: Record<string, unknown> } = {}): Box {
  const root = tmpRepo(`g7j-${tag}`);
  const repo = join(root, 'src', 'shop');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/shop.git\n');
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const home = join(root, 'home');
  const trail = join(root, 'trail-home');
  const project = join(root, 'project');
  for (const d of [home, join(trail, 'repos'), project]) mkdirSync(d, { recursive: true });
  writeFileSync(join(trail, 'settings.json'), JSON.stringify({ v: 1, skills: 'on', onSince: '2026-08-01T00:00:00.000Z', ...opts.settings }));
  // CWD's own key, as Trail makes it here: `local/home-dev-shop`, or `local/d-home-dev-shop` on Windows (the drive).
  const local = repoPlace(CWD, { TRAIL_HOME: trail }).key;
  writeFileSync(join(trail, 'repos', 'index.json'), JSON.stringify({ aliases: { [local]: SHOP }, roots: {} }));
  // The prompt hook's graph ask: answers nothing, at once.
  const stub = join(root, 'ask-stub.mjs');
  writeFileSync(stub, 'process.stdout.write("null");\n');
  return { root, repo, home, trail, project, stub, env: { ...opts.env }, row: { ...opts.row }, ids: 0 };
}

/** A new Claude Code session in the shop checkout. */
export function session(b: Box, opts: { mode?: string; payload?: Record<string, unknown> } = {}): Session {
  const sid = `3c9d2e1f-0a1b-4c2d-8e3f-${String(++boxes).padStart(12, '0')}`;
  const tx = join(b.home, '.claude', 'projects', '-home-dev-shop', `${sid}.jsonl`);
  mkdirSync(join(tx, '..'), { recursive: true });
  writeFileSync(tx, '');
  const mode = opts.mode ?? 'default';
  return { b, sid, tx, mode, payload: { session_id: sid, transcript_path: tx, cwd: CWD, permission_mode: mode, ...opts.payload } };
}

/** `2026-10-<day>T12:00:00Z` plus `sec` seconds (noon UTC: the same local date across most time zones). */
export const at = (day: number, sec = 0) => new Date(Date.UTC(2026, 9, day, 12, 0, 0) + sec * 1000).toISOString();

const where = (s: Session, iso: string) => ({ cwd: s.b.repo, gitBranch: 'main', sessionId: s.sid, timestamp: iso, ...s.b.row });
export const grow = (s: Session, entries: object[]) => appendFileSync(s.tx, jsonl(entries));
export const nextId = (s: Session) => `toolu_${s.sid.slice(-4)}${String(++s.b.ids).padStart(5, '0')}`;

/** The person typed `text` (the line Claude Code writes, before the prompt hook runs). */
export function typedLine(s: Session, iso: string, text: string): void {
  grow(s, [typed(text, where(s, iso))]);
}
/** A Bash call and its result in the transcript. */
export function ran(s: Session, iso: string, command: string, output: string, isError?: boolean, id = nextId(s)): string {
  grow(s, [toolUse(id, 'Bash', { command, description: 'run it' }, where(s, iso)), toolResult(id, output, isError, where(s, iso))]);
  return id;
}
/** Only the tool_use line: the result isn't in the transcript yet. */
export function calling(s: Session, iso: string, command: string, id = nextId(s)): string {
  grow(s, [toolUse(id, 'Bash', { command, description: 'run it' }, where(s, iso))]);
  return id;
}
export const resultOf = (s: Session, iso: string, id: string, output: string, isError?: boolean) => grow(s, [toolResult(id, output, isError, where(s, iso))]);
export const reply = (s: Session, iso: string, text: string) => grow(s, [said(text, where(s, iso))]);

const SAVED_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'TRAIL_HOME', 'CLAUDE_CODE_ENTRYPOINT', 'TRAIL_TEST_NOW', 'CLAUDE_PROJECT_DIR', 'GRAFT_TEST_STDIN', 'GRAFT_TEST_CLI',
  'TRAIL_HOST_FACTS', 'CLAUDE_CONFIG_DIR', 'CI', 'GITHUB_ACTIONS', 'TRAIL_NO_HOOKS', 'TRAIL_LAB_INTERACTIVE', 'TRAIL_INVOKED_AS', 'DO_NOT_TRACK',
  'CODEX_HOME', 'TRAIL_TIER_CODEX', 'GRAFT_POSTHOG_KEY', 'GRAFT_POSTHOG_HOST'];

/** Runs one hook in this process the way the shim does (`main(event)`), with its stdout captured. */
export async function hook(s: Session, event: string, payload: Record<string, unknown>, nowIso: string, env: Record<string, string> = {}): Promise<string> {
  const saved = Object.fromEntries(SAVED_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ['CLAUDE_CONFIG_DIR', 'CI', 'GITHUB_ACTIONS', 'TRAIL_NO_HOOKS', 'TRAIL_LAB_INTERACTIVE', 'TRAIL_HOST_FACTS', 'CODEX_HOME', 'TRAIL_TIER_CODEX']) delete process.env[k];
  Object.assign(process.env, {
    HOME: s.b.home, USERPROFILE: s.b.home, TRAIL_HOME: s.b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: nowIso, CLAUDE_PROJECT_DIR: s.b.project,
    GRAFT_TEST_CLI: s.b.stub, DO_NOT_TRACK: '1', GRAFT_TEST_STDIN: JSON.stringify({ ...s.payload, ...payload }), ...s.b.env, ...env,
  });
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  // The hooks write strings; the test runner's own reports (a child's events to the parent) are bytes and pass through.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    typeof chunk === 'string' ? ((out += chunk), true) : (write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  try {
    await (event === 'pre-bash' ? preBashMain('pre-bash') : hooksMain(event));
  } finally {
    process.stdout.write = write;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return out;
}

/** The one JSON object a hook wrote, or null when it wrote nothing; throws on anything else. */
export function one(out: string): Record<string, any> | null {
  if (out === '') return null;
  return JSON.parse(out);
}

/* ---- the hooks, by event, with Claude Code's payloads ---- */

export const startHook = (s: Session, iso: string, source = 'startup', extra: Record<string, unknown> = {}) =>
  hook(s, 'session-start', { hook_event_name: 'SessionStart', source, ...extra }, iso);

/** UserPromptSubmit after the typed line is in the transcript (`lineFirst`, Claude Code's usual order). */
export async function promptHook(s: Session, iso: string, text: string, opts: { lineFirst?: boolean; extra?: Record<string, unknown> } = {}): Promise<string> {
  if (opts.lineFirst !== false) typedLine(s, iso, text);
  const out = await hook(s, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: text, ...opts.extra }, iso);
  if (opts.lineFirst === false) typedLine(s, iso, text);
  return out;
}

export const stopHook = (s: Session, iso: string, last: string | null, active = false, extra: Record<string, unknown> = {}) =>
  hook(s, 'stop', { hook_event_name: 'Stop', stop_hook_active: active, ...(last === null ? {} : { last_assistant_message: last }), ...extra }, iso);

export const preBashHook = (s: Session, iso: string, command: string, id: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
  hook(s, 'pre-bash', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'run it' }, tool_use_id: id, ...extra }, iso, env);

export const postBashHook = (s: Session, iso: string, command: string, id: string, stdout: string, stderr = '') =>
  hook(s, 'tool-savings', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, tool_response: { stdout, stderr, interrupted: false } }, iso);

export const postBashFailHook = (s: Session, iso: string, command: string, id: string, error: string) =>
  hook(s, 'post-bash-fail', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, error, is_interrupt: false, duration_ms: 1200 }, iso);

/**
 * The agent runs `command` as Claude Code does it: the tool_use line, PreToolUse, then (when it was let
 * through) the command's output from `run`, its result line and PostToolUse (or PostToolUseFailure).
 */
export async function agentRuns(s: Session, iso: string, command: string, run: () => { out: string; failed?: boolean } = () => ({ out: '' })): Promise<{ id: string; decision: Record<string, any> | null; out: string }> {
  const id = calling(s, iso, command);
  const decision = one(await preBashHook(s, iso, command, id));
  const verdict = decision?.hookSpecificOutput?.permissionDecision;
  if (verdict === 'deny') {
    resultOf(s, iso, id, decision!.hookSpecificOutput.permissionDecisionReason, true);
    return { id, decision, out: '' };
  }
  const r = run();
  resultOf(s, iso, id, r.out, r.failed);
  if (r.failed) await postBashFailHook(s, iso, command, id, r.out);
  else await postBashHook(s, iso, command, id, r.out);
  return { id, decision, out: r.out };
}

/* ---- the jobs ---- */

/** `trail skills add` as the agent's shell runs it: g5's CLI half, in the checkout. */
export function cli(b: Box, nowIso: string, command: string, extraEnv: Record<string, string> = {}) {
  return () => {
    const m = /skills add (\S+) --run (\S+)/.exec(command)!;
    const env = { PATH: process.env.PATH, HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: nowIso, ...extraEnv };
    const r = cliAdd(m[1]!, m[2]!, env, new Date(Date.parse(nowIso) + 1000), b.repo);
    last = r;
    return { out: r.lines.join('\n'), failed: r.exit !== 0 };
  };
}
let last: ReturnType<typeof cliAdd> | null = null;
/** What the last `cli` step returned. */
export const lastCli = () => last;

/** A release that worked: build, publish, and npm shows the version. `failedFirst`: a publish that failed first (a costly day). */
export async function release(s: Session, day: number, version: string, opts: { failedFirst?: boolean; ask?: string } = {}): Promise<void> {
  await promptHook(s, at(day, 0), opts.ask ?? `publish ${version}`);
  await agentRuns(s, at(day, 10), 'npm run build', () => ({ out: 'built in 2.1s' }));
  if (opts.failedFirst) await agentRuns(s, at(day, 15), `npm publish acme-cli-${version}.tgz`, () => ({ out: 'Exit code 1\nnpm error code E403\nnpm error 403 Forbidden', failed: true }));
  await agentRuns(s, at(day, 20), `npm publish acme-cli-${version}.tgz --access public`, () => ({ out: `+ acme-cli@${version}` }));
  await agentRuns(s, at(day, 30), 'npm view acme-cli version', () => ({ out: version }));
}

/** A test run that worked: install, build, then the suite passes. `failedFirst`: the suite failed first (a costly day). */
export async function testsJob(s: Session, day: number, opts: { failedFirst?: boolean; sec?: number } = {}): Promise<void> {
  const t = opts.sec ?? 0;
  await promptHook(s, at(day, t), 'run the test suite');
  await agentRuns(s, at(day, t + 10), 'npm ci', () => ({ out: 'added 212 packages in 3s' }));
  await agentRuns(s, at(day, t + 15), 'npm run build', () => ({ out: 'built in 2.1s' }));
  if (opts.failedFirst) await agentRuns(s, at(day, t + 20), 'npm test', () => ({ out: 'Exit code 1\nTests: 1 failed, 11 passed, 12 total', failed: true }));
  await agentRuns(s, at(day, t + 30), 'npm test', () => ({ out: 'Tests: 12 passed, 12 total' }));
}

/** The job's last words, the reply, and Stop with it: what Stop answered. */
export async function finish(s: Session, day: number, said: string, sec = 40): Promise<Record<string, any> | null> {
  reply(s, at(day, sec), said);
  return one(await stopHook(s, at(day, sec + 1), said));
}

/** The continued turn after a Stop block: the reply ends with the offer's 2 lines, and Stop (active) says nothing. */
export async function sayOfferLines(s: Session, day: number, lines: string[], sec = 45, before = 'Done.'): Promise<Record<string, any> | null> {
  const text = `${before}\n\n${lines[0]}\n${lines[1]}`;
  reply(s, at(day, sec), text);
  return one(await stopHook(s, at(day, sec + 1), text, true));
}

/* ---- what Trail kept ---- */

export function stateOf(s: Session): SkillSessionState {
  return JSON.parse(readFileSync(sessionPath(s.sid, '.json', { TRAIL_HOME: s.b.trail }), 'utf8')).skills;
}
export function ls(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}
export const skillsKept = (b: Box) => ls(join(b.trail, 'skills'));
export const heldKept = (b: Box) => ls(join(b.trail, 'held'));
export function offersLog(b: Box): Array<Record<string, any>> {
  try {
    return readFileSync(join(b.trail, 'offers.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
export function done(b: Box): void {
  rmSync(b.root, { recursive: true, force: true });
}
