/**
 * The sure-fail guardrail on the PreToolUse fast path (design 4.11): when
 * the person kept the no-timeout guardrail, a `timeout N ...` command is
 * denied, but only when no `timeout` program exists on this machine, so the
 * command would fail anyway. Nothing else is ever denied here, and anything
 * odd (no file, a retired or edited one, a read that throws) allows.
 *
 * The caller decides whether skills are on (0 rule 1); this file only reads
 * `<trail home>/learnings/no-timeout.md` (one small file, R56).
 *
 * Fast-path safe (0 rule 8): static imports are node:path, node:os and the
 * shell lexer files already on the path; node:fs and node:crypto come from
 * `process.getBuiltinModule`. TRAIL_HOME is resolved as gate-file.ts does.
 */
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type * as Fs from 'node:fs';
import type * as Crypto from 'node:crypto';
import { sessionPath, trailHomeFast } from './gate-file.js';
import { normalizeCommand, stripTimeout } from './shell.js';
import { afterTimeout, simpleCommands } from './shell-words.js';
import { ASSIGN, words } from './shell-scan.js';

/** J16's words, then the way out (R29), as information about the denied command (D88). */
export const SURE_FAIL_REASON = '[trail] Trail, the tool this person installed, stopped this command before it ran: '
  + 'this Mac has no timeout program (an always-follow learning this person kept), so it would fail with "timeout: command not found". '
  + "The usual fix is the same command without timeout, using the Bash tool's own timeout parameter or run_in_background. "
  + 'If timeout is installed here now, the person can drop this learning with trail forget no-timeout.';

/**
 * Where `timeout` lives when the hook's PATH is narrower than the shell's (4.11 step 3, R29). `$HOME` is env.HOME,
 * `$USER` env.USER. Review: nix-darwin's per-user profile joins 4.11's list. /usr/bin and /bin stay out: a hook's
 * PATH always holds them, and on Linux (where coreutils puts timeout there) they would hide the deny path from CI.
 */
export const FIXED_DIRS: readonly string[] = Object.freeze([
  '/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/opt/coreutils/libexec/gnubin', '/usr/local/opt/coreutils/libexec/gnubin',
  '/opt/local/bin', '/opt/local/libexec/gnubin', '$HOME/.nix-profile/bin', '/run/current-system/sw/bin',
  '/nix/var/nix/profiles/default/bin', '$HOME/bin', '$HOME/.local/bin',
  '/etc/profiles/per-user/$USER/bin',
]);

const MAX_FILE = 4 * 1024;
/** A longer command is allowed unread: the deny is only for when Trail is sure, and parsing 2 MB took 150 ms here. */
const MAX_COMMAND = 64 * 1024;
const MAX_DENIED = 4 * 1024;
const fs = (): typeof Fs => process.getBuiltinModule('node:fs') as typeof Fs;
const crypto = (): typeof Crypto => process.getBuiltinModule('node:crypto') as typeof Crypto;

/** A front-matter value: quotes and padding gone, lower case. */
const value = (raw: string) => raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase();

/** The guardrail file says: active, check no-timeout, enforce sure-fail (2.5). Anything else, or a read error: false. */
function guardrailKept(env: NodeJS.ProcessEnv): boolean {
  const f = fs();
  let text: string;
  try {
    const path = join(trailHomeFast(env), 'learnings', 'no-timeout.md');
    // O_NONBLOCK: a FIFO planted here would otherwise hold the hook until its 5 s run out.
    const fd = f.openSync(path, f.constants.O_RDONLY | (f.constants.O_NOFOLLOW ?? 0) | (f.constants.O_NONBLOCK ?? 0));
    try {
      const st = f.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_FILE) return false;
      const buf = Buffer.alloc(st.size);
      const n = f.readSync(fd, buf, 0, st.size, 0);
      text = buf.toString('utf8', 0, n);
    } finally {
      f.closeSync(fd);
    }
  } catch {
    return false;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return false;
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([a-z]+):(.*)$/.exec(line);
    if (kv) fm[kv[1]!] = value(kv[2]!);
  }
  return (fm.status ?? 'active') === 'active' && fm.check === 'no-timeout' && fm.enforce === 'sure-fail';
}

/** The words of a simple command after env prefixes (`A=1`, `env [-i] [-u N] A=1`). */
function afterEnv(simple: string): string[] {
  let w = words(simple);
  while (w.length && ASSIGN.test(w[0]!)) w = w.slice(1);
  if (w[0] === 'env') {
    let i = 1;
    while (i < w.length && (w[i]!.startsWith('-') || ASSIGN.test(w[i]!))) i += /^-[uCS]$/.test(w[i]!) ? 2 : 1;
    w = w.slice(i);
  }
  return w;
}

/** `timeout() {`, `function timeout`, `alias timeout=` anywhere in the command: its own timeout, so not sure (R29). */
const OWN_TIMEOUT = /(?:^|[\s;&|({])(?:timeout\s*\(\s*\)|function\s+timeout\b|alias\s+(?:-\S+\s+)*['"]?timeout=)/;

/**
 * The command may find a `timeout` the hook can't see: it changes PATH, or loads the person's shell setup
 * (`source`, `.`, `eval`, `hash`), whose PATH, alias or function Trail can't read. Not sure, so allow.
 */
const CHANGES_LOOKUP = /(?:^|[\s;&|({`])(?:(?:export|typeset|declare|local|readonly)\s+(?:-\S+\s+)*)?(?:PATH|path)\+?=|(?:^|[\s;&|({`])(?:source|eval|hash|rehash)(?:\s|$)|(?:^|[\s;&|({`])\.\s+\S/;

/** How many simple commands run `timeout DURATION ...` (after env prefixes). `gtimeout` never. */
function timeoutRuns(command: string): number {
  let n = 0;
  for (const s of simpleCommands(command)) {
    const w = afterEnv(s);
    if (w[0] === 'timeout' && afterTimeout(w) !== null) n++;
  }
  return n;
}

/**
 * Sure only when every `timeout` in the command is one of those runs. Any other (`command -v timeout &&`,
 * `which timeout`, `[[ -x …/timeout ]]`, `ln -s … ~/bin/timeout`, a function or alias) means the command looks for
 * one, falls back, or puts one in place: it may well not fail, so it is allowed (R29).
 */
function onlyRunsTimeout(command: string): boolean {
  const runs = timeoutRuns(command);
  return runs > 0 && (command.match(/\btimeout\b/g) ?? []).length === runs;
}

/** The PATH's folders, split on the platform's delimiter (';' on Windows), absolute ones only. */
export function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return String(env.PATH ?? '').split(delimiter).filter((d) => d !== '' && isAbsolute(d));
}

/** The file names a program can have: itself, and on Windows with each PATHEXT ending too (git.exe, npm.cmd). */
export function programFiles(name: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [name];
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => /^\.[a-z0-9]{1,8}$/.test(e));
  return [name, ...exts.map((e) => name + e)];
}

/** An executable regular file at `dir/timeout` (on Windows, which has no exec bit, any timeout.exe and the like). */
function executableIn(dir: string, env: NodeJS.ProcessEnv): boolean {
  if (!dir) return false;
  const f = fs();
  return programFiles('timeout', env).some((name) => {
    try {
      const p = join(dir, name);
      if (!f.statSync(p).isFile()) return false;
      f.accessSync(p, f.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** PATH dirs from env, then the fixed folders of 4.11. */
export function timeoutOnPath(env: NodeJS.ProcessEnv): boolean {
  const home = env.HOME || homedir();
  let user = env.USER || env.LOGNAME || '';
  if (!user) try { user = userInfo().username; } catch { /* none */ }
  const dirs = pathDirs(env);
  for (const d of FIXED_DIRS) {
    if (d.startsWith('$HOME')) dirs.push(join(home, d.slice('$HOME'.length)));
    else if (d.includes('$USER')) { if (/^[\w.-]{1,64}$/.test(user)) dirs.push(d.replace('$USER', user)); }
    else dirs.push(d);
  }
  return [...new Set(dirs)].some((d) => executableIn(d, env));
}

/** Reads <trail home>/learnings/no-timeout.md (under 1 KB) when it exists. Deny only when sure (4.11). */
export function sureFail(command: string, env: NodeJS.ProcessEnv): { deny: string; check: 'no-timeout' } | null {
  try {
    if (typeof command !== 'string' || command.length > MAX_COMMAND || !/\btimeout\b/.test(command)) return null;
    if (!onlyRunsTimeout(command) || OWN_TIMEOUT.test(command) || CHANGES_LOOKUP.test(command)) return null;
    if (!guardrailKept(env)) return null;
    if (timeoutOnPath(env)) return null;
    return { deny: SURE_FAIL_REASON, check: 'no-timeout' };
  } catch {
    return null;
  }
}

/** Appends {at, restSha} to sessions/<id>.denied.jsonl (O_APPEND, 0600, 4 KB cap) for the avoided credit. */
export function markDenied(sessionId: string, command: string, env: NodeJS.ProcessEnv, now: Date = new Date()): void {
  try {
    const f = fs();
    const path = sessionPath(String(sessionId), '.denied.jsonl', env);
    const rest = normalizeCommand(stripTimeout(String(command ?? '')));
    const line = `${JSON.stringify({ at: now.toISOString(), restSha: `sha256:${crypto().createHash('sha256').update(rest).digest('hex')}` })}\n`;
    const dir = dirname(path);
    f.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = f.constants;
    // O_NONBLOCK: a FIFO planted here would otherwise hold the hook until its 5 s run out (with no reader, ENXIO).
    const fd = f.openSync(path, O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0), 0o600);
    try {
      const st = f.fstatSync(fd);
      if (!st.isFile() || st.size + Buffer.byteLength(line) > MAX_DENIED) return;
      f.fchmodSync(fd, 0o600);
      f.writeSync(fd, line);
    } finally {
      f.closeSync(fd);
    }
  } catch {
    /* the avoided count is best effort */
  }
}
