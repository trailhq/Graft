/**
 * One Bash call as the fold keeps it (design 4.1): the command with secrets
 * named or refused (4.10), the folder it really ran in, what kind of call it
 * is. The tamper check is in `tamper.ts`.
 *
 * The folder is the transcript entry's `cwd`, which follows a `cd` from an
 * earlier call (the agent's shell keeps its folder between calls), then the
 * command's own leading `cd`s. A call whose folder can't be known (`cd "$X"`,
 * `cd -`) has none, so compile refuses it rather than guess.
 *
 * Interpreter heredocs (D51): `python3 - <<'EOF' ... EOF` that writes files is
 * `work`, left out of skills like a file edit; one that only reads or prints
 * is `look`; one that runs programs or the network stays a `step`.
 *
 * A result where the host refused to run the command (the person said no, a
 * classifier or hook blocked it, D51) counts as never run.
 */
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { flatLine } from '../notes/flatten.js';
import { secretReason } from '../notes/secrets.js';
import { callKind } from './checks.js';
import { redactSecrets } from './redact.js';
import { ignoredFailure } from './repairs.js';
import { loginFeed } from '../skills/answers-prompt.js';
import { ASSIGN, base, scan, words } from './shell-scan.js';
import { bareCommand, heredocInterpreter, isMultiLine, leadingCds, normalizeCommand, scriptKind, simpleCommands, splitTop, type Segment } from './shell.js';
import { programWords } from './shell-words.js';
import { matchWall } from './walls.js';
import type { CallKind, JobClass, RunCall, RunCallPart, RunState } from './types.js';

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Longer raw commands are never compiled or kept (redactSecrets refuses them, 4.10). */
export const MAX_RAW = 2000;
const TAIL_CHARS = 200;

/** Where a folder is: its repo key and checkout root, or nulls outside git. */
export type PlaceOf = (folder: string) => { key: string | null; root: string | null };

/* ------------------------------------------------------------------ folder */

/** A `cd` argument as a path relative to `folder`, or null when only the shell could know it. */
function cdTarget(arg: string, folder: string, home: string): string | null {
  let a = arg;
  if (a === '~' || a === '') return home;
  if (a.startsWith('~/')) a = home + a.slice(1);
  a = a.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (a === '-' || /[$`*?]/.test(a)) return null;
  return resolve(folder, a);
}

/**
 * The entry's folder, then each leading `cd` in order; null when unknown. `cd -` goes back to the folder
 * before the last `cd` of this call; with none before it, that folder was the shell's, so it is unknown.
 */
export function effectiveFolder(entryCwd: string | null, raw: string, home: string = homedir()): string | null {
  if (!entryCwd) return null;
  let folder: string | null = entryCwd;
  let prev: string | null = null;
  for (const arg of leadingCds(raw).cds) {
    const next: string | null = arg === '-' ? prev : cdTarget(arg, folder, home);
    if (next === null) return null;
    prev = folder;
    folder = next;
  }
  return folder;
}

/** `key` and `cwd` (relative to the checkout root, '' at the root) of a folder; nulls outside git. */
export function placeFields(folder: string | null, placeOf: PlaceOf): { key: string | null; cwd: string | null } {
  if (!folder) return { key: null, cwd: null };
  const p = placeOf(folder);
  if (!p.key || !p.root) return { key: null, cwd: null };
  const rel = relative(p.root, folder);
  if (rel.startsWith('..') || isAbsolute(rel)) return { key: p.key, cwd: null };
  return { key: p.key, cwd: rel.split(sep).join('/') };
}

/* ------------------------------------------------------------------- kinds */

export const INTERPRETERS = /^(?:python[\d.]*|node|ruby|perl|deno|bun|php)$/;
/**
 * The kind of an interpreter's heredoc program (D51, D58 e): work when it writes files, starts programs or
 * sends to the network, a look when it only reads or prints; never a step. One reader for the fold and compile:
 * shell.ts `scriptKind`.
 */
export function interpreterKind(body: string): CallKind {
  return scriptKind(body) === 'look' ? 'look' : 'work';
}

/** An interpreter fed its program by a heredoc (`python3 - <<'EOF'`, `node <<EOF`), not data for a script: shell.ts reads it. */
function heredocProgram(head: string): boolean {
  return heredocInterpreter(programWords(head)) !== null;
}

/** 4.1 kinds, with interpreter heredocs judged by their program (D51). */
export function foldKind(raw: string, job: JobClass | null): CallKind {
  const kind = callKind(raw, job);
  if (kind !== 'step' || !raw.includes('<<')) return kind;
  const { segs } = scan(raw);
  if (!segs.some((p) => p.bodies.length && !p.group && heredocProgram(raw.slice(p.start, p.end)))) return kind;
  const kinds = segs.map((p) => {
    const head = raw.slice(p.start, p.end);
    if (p.bodies.length && !p.group && heredocProgram(head)) return interpreterKind(p.bodies.map(([a, b]) => raw.slice(a, b)).join('\n'));
    return callKind(head, job);
  });
  if (kinds.every((k) => k === 'plumbing')) return 'plumbing';
  if (kinds.includes('step')) return 'step';
  return kinds.includes('work') ? 'work' : 'look';
}

/* --------------------------------------------------------------- refusals */

const REFUSED = [
  /^The user doesn't want to proceed with this tool use/,
  /^Permission (?:for this (?:action|command)|to use \S+(?: with command [\s\S]*?)?) (?:was|has been) denied/,
  /^\S+ is temporarily unavailable\b[\s\S]{0,60}\bso auto mode cannot\b/,
  /^<tool_use_error>(?:Blocked:|Error: No such tool available)/,
  /^\w+:\w+ hook (?:error|returned blocking error)/,
  /^This session is isolated in the worktree\b[\s\S]*\bRefusing to run it/,
  /^\S+ in '[^']*' was blocked\b/,
  /^Claude requested permissions to use\b/,
];

/** The host refused to run the call (D51): the person said no, a classifier, a safety check or a hook blocked it. */
export function hostRefused(text: string): boolean {
  const t = String(text ?? '').trimStart();
  return REFUSED.some((re) => re.test(t));
}

/**
 * Claude Code's own result for a command that went to the background (fix-lab5): one run past its Bash timeout
 * ("Command did not complete within its 300s timeout and was moved to the background (ID: …)"), or a
 * `run_in_background` start ("Command running in background with ID: …"). It says the command started, never that it
 * worked, so no check passes on it. Only a result that is that text (from its start, or a mark's one-line tail of
 * it): a log quoting it is something else.
 */
const BACKGROUNDED = /^(?:Command did not complete within its \d+m?s timeout and was moved to the background\b|Command running in background with ID: )/;
/** How the same text ends: a PostToolUse mark keeps only a result's last 200 characters. */
const BACKGROUNDED_END = /\/tasks\/[\w-]{1,40}\.output\. You will be notified when it completes\.(?: To check interim output, use Read on that file path\.)?$/;
export function wentToBackground(text: string): boolean {
  const t = String(text ?? '').trim();
  return BACKGROUNDED.test(t) || (t.length <= 400 && BACKGROUNDED_END.test(t) && !/\n/.test(t));
}

/* -------------------------------------------------------------- the call */

/**
 * The last 200 characters of a result, each line cleaned (flatLine), line
 * breaks kept: the run facts read pushes and publishes line by line
 * (`+ pkg@1.2.3`, `abc..def  main -> beta`). Undefined when it holds a secret.
 */
export function cleanTail(text: string): string | undefined {
  const t = String(text ?? '').slice(-TAIL_CHARS);
  if (secretReason(t) !== null) return undefined;
  const out = t.split(/\r?\n/).map((l) => flatLine(l, TAIL_CHARS)).filter(Boolean).join('\n');
  return out && secretReason(out) === null ? out : undefined;
}

export interface CallEvent { id: string; at: string; input: unknown; offset?: number; cwd?: string }

/** At most this many pieces of a long call are kept; the rest is one work marker. */
const MAX_PARTS = 200;

/**
 * A call over 2,000 characters, piece by piece (D58c): each top-level piece redacted on its own, a piece
 * over 2,000 characters (a heredoc body, an inline edit) a work marker that keeps nothing of it.
 */
export function callParts(segs: Segment[], job: JobClass | null): RunCallPart[] {
  const out: RunCallPart[] = [];
  for (const [i, seg] of segs.entries()) {
    if (i === MAX_PARTS - 1 && segs.length > MAX_PARTS) {
      out.push({ cmd: null, sep: '', kind: 'work', long: true });
      break;
    }
    const text = seg.text.trim();
    if (text.length > MAX_RAW) {
      out.push({ cmd: null, sep: seg.sep, kind: 'work', long: true });
      continue;
    }
    const red = redactSecrets(text);
    const part: RunCallPart = { cmd: red.cmd, sep: seg.sep, kind: foldKind(text, job) };
    if (red.secret) part.secret = red.secret;
    out.push(part);
  }
  return out;
}

/** A RunCall from a Bash tool_call (4.1), before its result. */
export function makeCall(ev: CallEvent, raw: string, job: JobClass | null, placeOf: PlaceOf, fallbackCwd: string | null, home: string = homedir()): RunCall {
  const input = ev.input && typeof ev.input === 'object' ? (ev.input as Record<string, unknown>) : {};
  const segs = splitTop(raw);
  const truncated = raw.length > MAX_RAW;
  const parts = truncated ? callParts(segs, job) : null;
  // D116 item 5: a call that only feeds keystrokes into a login keeps the login alone, never what was fed.
  const feed = parts ? null : loginFeed(raw);
  const red = feed ? { cmd: feed.login, secret: undefined } : parts ? { cmd: null, secret: worstSecret(parts) } : redactSecrets(raw);
  const call: RunCall = {
    id: ev.id,
    at: ev.at,
    cmd: red.cmd, // null when it holds a secret, or is long and kept as `parts` (D58c)
    ...placeFields(effectiveFolder(ev.cwd || fallbackCwd, raw, home), placeOf),
    bg: input.run_in_background === true || segs[segs.length - 1]?.sep === '&',
    failed: false,
    isError: false,
    kind: foldKind(raw, job),
    src: { use: ev.offset ?? -1, result: null },
  };
  if (red.secret) call.secret = red.secret;
  if (feed) call.loginFeed = feed.service;
  if (truncated) call.truncated = true;
  if (isMultiLine(raw)) call.multiLine = true;
  if (parts) call.parts = parts;
  return call;
}

/**
 * A call's wall class (b2, R8), set from its result where the fold still holds the text: `makeCall` runs before
 * the result exists, so the fold calls this once `failed` and `errorLine` are known. matchWall's own rules hold
 * (the program a class needs, exit-0 only for three classes, never a look-only call); a failure that never
 * counts (`ignoredFailure`: a deny, a CI log read, a query, a look) or a result the host refused gets none.
 */
export function setWall(call: RunCall, raw: string, text: string): void {
  delete call.wall;
  if (hostRefused(text) || ignoredFailure(call, null)) return;
  const wall = matchWall(text, raw, call.failed);
  if (wall) call.wall = wall;
}

/** A deployment status tool call over MCP (D59b): a look with no folder, its check filled from its result. */
export function makeToolCall(ev: CallEvent, name: string): RunCall {
  return {
    id: ev.id, at: ev.at, cmd: null, tool: name, key: null, cwd: null, bg: false, failed: false, isError: false, kind: 'look',
    src: { use: ev.offset ?? -1, result: null },
  };
}

const GREPS = /^(?:grep|egrep|fgrep|zgrep|rg|ag|ack)$/;

/**
 * D59d: a grep that found nothing. grep and rg exit 1 when nothing matched; with nothing printed (the host
 * writes only `Exit code 1`, a mark's tail is empty) that is an answer, not a failure, also when it stopped a
 * chain of reads (`grep -n A f && echo --- && grep -n B f`). Exit 2, any message, or a call with no grep in it
 * keeps the call failed. The fold asks this for look and plumbing calls only.
 */
export function grepNoMatch(raw: string, text: string): boolean {
  if (String(text ?? '').trim().replace(/^(?:Error: )?Exit code 1$/, '') !== '') return false;
  return simpleCommands(raw).some((simple) => {
    const w = words(bareCommand(simple));
    return GREPS.test(base(w[0] ?? '')) || (w[0] === 'git' && w[1] === 'grep');
  });
}

function worstSecret(parts: RunCallPart[]): RunCallPart['secret'] {
  if (parts.some((p) => p.secret === 'refused')) return 'refused';
  return parts.some((p) => p.secret === 'named') ? 'named' : undefined;
}

/** Calls whose result keeps a tail: checks, polls, `git rev-parse`, `git push`, publishes (4.1). */
export function keepsTail(raw: string, isCheck: boolean, poll: boolean): boolean {
  if (isCheck || poll) return true;
  if (!/\b(?:rev-parse|push|publish)\b/.test(raw)) return false;
  return simpleCommands(raw).some((s) => /^(?:git (?:rev-parse|push)|(?:npm|pnpm|yarn(?: npm)?) publish)\b/.test(normalizeCommand(s).replace(/^(?:\w+=\S+\s+)+/, '')));
}

/** Calls a poll looks back over: enough for a wait loop, bounded for a long run. */
const POLL_LOOKBACK = 20;

/**
 * The same command (normalized) as an earlier call, with only look, plumbing or work calls between (a
 * poll). `normOf` gives a call's normalized command (the fold caches it).
 */
export function isPoll(me: string, calls: RunCall[], normOf: (c: RunCall) => string): boolean {
  for (let i = calls.length - 1; i >= Math.max(0, calls.length - POLL_LOOKBACK); i--) {
    const c = calls[i]!;
    if (normOf(c) === me) return true;
    if (c.kind === 'step') return false;
  }
  return false;
}

/* ----------------------------------------------------------------- helpers */

function scratchRoots(): string[] {
  return [tmpdir(), process.env.TMPDIR ?? '', '/tmp', '/private/tmp', '/var/folders'].filter(Boolean).map((p) => resolve(p));
}

const POSIX_SCRATCH = ['/tmp', '/private/tmp', '/var/folders'];

function inScratch(p: string): boolean {
  if (/\/scratchpad\//.test(p) || scratchRoots().some((r) => p === r || p.startsWith(r + sep))) return true;
  if (process.platform !== 'win32') return false;
  // Windows: a path may use either slash and any case, and Git Bash's /tmp is the person's temp folder.
  const fwd = p.replace(/\\/g, '/').toLowerCase();
  if (fwd.includes('/scratchpad/') || POSIX_SCRATCH.some((r) => fwd === r || fwd.startsWith(`${r}/`))) return true;
  const q = resolve(p).toLowerCase();
  return scratchRoots().some((r) => q === r.toLowerCase() || q.startsWith(r.toLowerCase() + sep));
}

/** Absolute paths of helper scripts the run executed from scratch folders (4.5 step 7), from its ok step calls. */
export function runHelpers(run: Pick<RunState, 'calls'>): string[] {
  const out: string[] = [];
  for (const c of run.calls) {
    if (!c.cmd || c.failed || c.kind !== 'step') continue;
    for (const simple of simpleCommands(leadingCds(c.cmd).rest || c.cmd)) {
      const w = words(simple).filter((x) => !ASSIGN.test(x)).map((x) => x.replace(/^(['"])(.*)\1$/, '$2'));
      const runner = /^(?:ba|z|da)?sh$|^node$|^python3?$/.test(base(w[0] ?? ''));
      const script = runner ? w.slice(1).find((a) => !a.startsWith('-')) : w[0];
      if (script && isAbsolute(script) && inScratch(script) && !out.includes(script)) out.push(script);
    }
  }
  return out;
}

/* ------------------------------------------------------------ shared words */

const STOP = new Set(('a an the to and then please can could would you we i it its this that now also just so okay ok yes lets let\'s do some me my '
  + 'our for of on in at first again too as well be is are will').split(' '));

/** The ask's content words (4.6 stop words dropped), 3 characters or more. */
export function contentWords(typed: string): string[] {
  const out: string[] = [];
  for (const w of String(typed ?? '').toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out;
}

/** Words both in the ask and in the command, added to `into` up to 6 (4.1 `sharedWords`). */
export function addSharedWords(into: string[], typed: string, raw: string): void {
  const cmdWords = new Set(String(raw).toLowerCase().split(/\W+/));
  for (const w of contentWords(typed)) {
    if (into.length >= 6) return;
    if (cmdWords.has(w) && !into.includes(w)) into.push(w);
  }
}
