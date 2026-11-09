/**
 * The repair detector (design 4.12, research v3): a call that failed on a
 * known wall, and the retry of the same command within 10 calls that worked
 * because of what changed around it. The change (the fix delta) is an env
 * variable set, a flag added, a wrapper from a fixed list put in front, or a
 * step of another program that ran between them (`colima start`).
 *
 * Some failures never count (`ignoredFailure`): a hook or host deny, a CI
 * log read (the log is a failure), SQL and GraphQL query errors (data, not
 * tooling), a flake, a chain whose failing tail was dropped, and look-only
 * calls.
 *
 * A delta's text can become a lesson the agent reads as "what fixed it", and
 * an agent chooses the retry, so every delta passes the rules a skill step
 * passes (R26): no secret, nothing on the never-save list, nothing gated.
 * Any delta that fails them drops the whole repair.
 *
 * Pure: reads only the run's calls (commands already secret-checked by the
 * fold). Never throws.
 */
import { homedir } from 'node:os';
import { secretReason } from '../notes/secrets.js';
import { gatedKind } from '../skills/risk.js';
import { neverSave } from '../skills/never-save.js';
import { OWN_FILES, RISKY_STEP, riskyDelta } from '../skills/risk-delta.js';
import { callText } from './checks.js';
import { commandKind, leadingCds, normalizeCommand, relativizePaths, splitTop, stripLeadingSleep, stripOutputFilters, stripTrailingEcho } from './shell.js';
import { afterTimeout, programOfText } from './shell-words.js';
import { ASSIGN, base, unquote, words } from './shell-scan.js';
import type { FixDelta, RepairEvent, RunCall, RunState } from './types.js';

/** Where relativized delta text points: `$HOME` for home, `./` for the repo root (4.12 step 5). */
export interface RepairOpts { home?: string; root?: string }

/** The retry is one of the next 10 calls (4.12 step 3). */
const WINDOW = 10;
/** At most 5 repairs a run (RunState.repairs). */
const MAX_REPAIRS = 5;

/* ------------------------------------------------------------ ignored rows */

/** A hook or the host refused the call; Trail's own sure-fail deny is one. errorLine is flatLine'd, so `[trail]` may be gone. */
const DENIED: readonly RegExp[] = [
  /^\w+:\w+ hook (?:error|returned blocking error)/,
  /^(?:\[trail\]\s*)?Trail, the tool this person installed, stopped this command\b/,
  /^trail(?::| ·) /, // Trail's gated-step deny and the save gate's refusals (b2 review)
  /^Permission (?:for this (?:action|command)|to use \S+(?: with command .*?)?) (?:was|has been) denied/,
  /^The user doesn't want to proceed with this tool use/,
  /^<tool_use_error>/,
];
/** Bounded between `view` and `--log`, so a long run of `gh run view` words can't make it quadratic (b2 review). */
const CI_LOG = /\bgh\s+run\s+view\b[^;&|\n]{0,400}?\s--log(?:-failed)?(?=\s|$|[;&|)])/;
/** A query client (also through `docker exec`), or GraphQL through gh. */
const QUERY_CLIENT = /(?:^|[\s;&|(/])(?:psql|mysql|mariadb|sqlite3|duckdb|clickhouse(?:-client)?|snowsql|cqlsh|mongosh)(?=\s|$)|\bbq\s+query\b|\bcockroach\s+sql\b|\bgh\s+api\s+graphql\b/;
/** What a query error says first: Postgres, MySQL, SQLite, GraphQL. */
const QUERY_ERROR = /^(?:ERROR|error):\s+(?:syntax error|relation|column|function|operator|permission denied for|duplicate key|invalid input syntax|null value)\b|^ERROR \d{4} \(\w+\)|^(?:Parse|Runtime) error near\b|^Error: (?:near|no such (?:table|column))\b|^GraphQL(?:Error)?:|\bdoesn't exist on type\b|"errors":\s*\[/i;

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');

/** How far a dropped tail is looked for: the retry's own length plus this, and at most this many pieces (linear, b2 review). */
const TAIL_SLACK = 2048;
const TAIL_PIECES = 64;

/** `A && B` failed and `A` alone then passed: the failure was the dropped tail's (4.12 step 1). */
function droppedTail(cmd: string, next: string): boolean {
  const want = normalizeCommand(next);
  const segs = splitTop(cmd);
  let head = '';
  for (let k = 0; k < segs.length - 1 && k < TAIL_PIECES; k++) {
    const seg = segs[k]!;
    if (seg.sep !== '&&' && seg.sep !== ';') return false;
    head = head ? `${head} ${seg.text}` : seg.text;
    if (head.length > next.length + TAIL_SLACK) return false;
    if (normalizeCommand(head) === want) return true;
    head = `${head} ${seg.sep}`;
  }
  return false;
}

/**
 * A failure that never counts as a wall or a repair (4.12 step 1). `next` is the call right after it (or the
 * retry), for the two rows about what followed: an identical retry that passed (a flake), and the same chain
 * with its failing `&&` tail dropped. The other rows read the call alone, and also hold for an exit-0 call: a
 * CI log read or a query is never a wall, failed or not.
 */
export function ignoredFailure(call: RunCall, next: RunCall | null): boolean {
  try {
    if (call.kind === 'look' || call.kind === 'plumbing') return true;
    const cmd = callText(call);
    if (CI_LOG.test(cmd) || QUERY_CLIENT.test(cmd)) return true;
    const line = typeof call.errorLine === 'string' ? call.errorLine : '';
    if (DENIED.some((re) => re.test(line)) || QUERY_ERROR.test(line)) return true;
    if (!call.failed || !next || next.failed || typeof next.cmd !== 'string') return false;
    return collapse(cmd) === collapse(next.cmd) || droppedTail(cmd, next.cmd);
  } catch {
    return true;
  }
}

/* -------------------------------------------------------------- the core */

interface Part { name: string; text: string }
/** A command with its leading cds, sleeps, output filters and trailing echo gone, then its env and wrappers taken off. */
interface Core { env: Part[]; wrappers: Part[]; words: string[]; text: string }

const PLACEHOLDER = /\$\{[A-Za-z_]\w*:\?set /;
/** Wrappers that only change how the same command runs; any of these added in a retry drops the repair unless it is on ALLOWED. */
const WRAPPERS = new Set(['sudo', 'doas', 'nice', 'nohup', 'time', 'exec', 'command', 'caffeinate', 'stdbuf', 'ionice', 'chrt']);
const TWO_WORD_FLAG = /^-[nuCgDhprtUTwc]$/;

function strip(cmd: string): string {
  let s = String(cmd ?? '').trim();
  for (let n = 0; n < 20; n++) {
    const next = stripLeadingSleep(leadingCds(stripTrailingEcho(stripOutputFilters(s))).rest);
    if (next === s) break;
    s = next;
  }
  return s;
}

function envPart(word: string): Part | null {
  const w = unquote(word);
  return ASSIGN.test(w) ? { name: w.slice(0, w.indexOf('=')), text: w } : null;
}

function coreOf(cmd: string): Core | null {
  const s = strip(cmd);
  let w = words(s);
  const env: Part[] = [];
  const wrappers: Part[] = [];
  for (let n = 0; n < 24 && w.length; n++) {
    while (w.length && ASSIGN.test(w[0]!)) env.push(envPart(w.shift()!)!);
    const p = w[0] ?? '';
    if (p === 'env') {
      let i = 1;
      for (; i < w.length; i++) {
        const e = envPart(w[i]!);
        if (e) env.push(e);
        else if (/^(?:-u|--unset|-C|--chdir|-S|--split-string)$/.test(w[i]!)) i++;
        else if (!w[i]!.startsWith('-')) break;
      }
      w = w.slice(i);
    } else if (p === 'noglob') {
      wrappers.push({ name: p, text: p });
      w = w.slice(1);
    } else if (p === 'timeout' || p === 'gtimeout') {
      const rest = afterTimeout(w);
      if (!rest) break;
      wrappers.push({ name: p, text: w.slice(0, w.length - rest.length).join(' ') });
      w = rest;
    } else if (p === 'colima' && w[1] === 'ssh' && w[2] === '--') {
      wrappers.push({ name: 'colima ssh --', text: 'colima ssh --' });
      w = w.slice(3);
    } else if (WRAPPERS.has(base(p)) && !(p === 'command' && /^-[vV]$/.test(w[1] ?? ''))) {
      let i = 1;
      while (i < w.length && w[i]!.startsWith('-')) i += TWO_WORD_FLAG.test(w[i]!) ? 2 : 1;
      wrappers.push({ name: base(p), text: w.slice(0, i).join(' ') });
      w = w.slice(i);
    } else break;
  }
  if (!w.length) return null;
  return { env, wrappers, words: w.map(unquote), text: w.join(' ') };
}

const isFlag = (w: string) => w.length > 1 && w.startsWith('-') && w !== '--';

/** The flags the retry added, when the retry is the failed command once they, its env and its wrappers are off; else null. */
function addedFlags(failed: Core, retry: Core): string[] | null {
  const had = new Set(failed.words);
  const added = retry.words.filter((w) => isFlag(w) && !had.has(w));
  const rest = retry.words.filter((w) => !(isFlag(w) && !had.has(w)));
  if (rest.length !== failed.words.length || rest.some((w, i) => w !== failed.words[i])) return null;
  return added;
}

const programOf = (c: Core) => programOfText(c.text).prog ?? base(c.words[0] ?? '');

/** A wrapper a retry may add: noglob, `colima ssh --`, and gtimeout where timeout failed (4.12 step 4). */
function allowedWrapper(name: string, failed: Core): boolean {
  if (name === 'noglob' || name === 'colima ssh --') return true;
  return name === 'gtimeout' && failed.wrappers.some((w) => w.name === 'timeout');
}

/** No secret, nothing never-save, nothing gated (4.12 steps 5, 6; R26). */
const safe = (text: string) => secretReason(text) === null && !PLACEHOLDER.test(text) && neverSave(text) === null && gatedKind(text) === null;

/** A call with a whole command whose outcome is known: a result in the transcript, or a PostToolUse mark (an open call reads as not failed); a background call's result says only that it started. */
const usable = (c: RunCall) => typeof c.cmd === 'string' && !c.truncated && c.bg !== true && (c.src?.result != null || c.fromMark === true);

/**
 * The delta between a failing call and its retry (4.12 step 4), with the enabling calls between them: enabling
 * steps first (in the order they ran), then wrappers, env and flags. [] when there is none, when `retry` is not
 * a passing retry of the same command, or when any part fails the secret or risk rules: [] means no repair.
 */
export function fixDelta(failed: RunCall, retry: RunCall, between: RunCall[], opts: RepairOpts = {}): FixDelta[] {
  try {
    if (!usable(failed) || !usable(retry) || retry.failed) return [];
    // An edit, or a call that changed files, between them may be the fix: the delta alone isn't (b2 review).
    if ((retry.editsBefore ?? 0) !== (failed.editsBefore ?? 0)) return [];
    if ((Array.isArray(between) ? between : []).some((c) => c.kind === 'work')) return [];
    const f = coreOf(failed.cmd!);
    const r = coreOf(retry.cmd!);
    if (!f || !r) return [];
    const flags = addedFlags(f, r);
    if (!flags) return [];
    const home = opts.home ?? homedir();
    const root = opts.root ?? '';
    const rel = (t: string) => relativizePaths(t, root, home);
    const out: FixDelta[] = [];
    const prog = programOf(f);
    for (const c of Array.isArray(between) ? between : []) {
      if (c.failed || !usable(c) || c.kind !== 'step' || commandKind(c.cmd!) !== 'step') continue;
      const core = coreOf(c.cmd!);
      if (!core || programOf(core) === prog) continue;
      out.push({ kind: 'enable-step', name: programOf(core), text: rel(strip(c.cmd!)), callId: c.id });
    }
    const hadWrap = new Set(f.wrappers.map((w) => w.name));
    for (const w of r.wrappers) {
      if (hadWrap.has(w.name)) continue;
      if (!allowedWrapper(w.name, f)) return [];
      out.push({ kind: 'wrapper', name: w.name, text: w.text, callId: retry.id });
    }
    const hadEnv = new Set(f.env.map((e) => e.name));
    for (const e of r.env) if (!hadEnv.has(e.name)) out.push({ kind: 'env', name: e.name, text: rel(e.text), callId: retry.id });
    for (const flag of flags) out.push({ kind: 'flag', name: flag.split('=')[0]!, text: rel(flag), callId: retry.id });
    if (!out.length) return [];
    // The retry as it ran (its cds, filters and echo included) and each delta's own text. The step rules read it
    // relativized, as the deltas are: a path inside a checkout that sits in /tmp (Linux CI, a scratch clone) is `./`.
    const whole = rel(retry.cmd!);
    if (!safe(retry.cmd!) || RISKY_STEP.test(whole) || OWN_FILES.test(whole) || out.some((d) => !safe(d.text) || riskyDelta(d))) return [];
    return out;
  } catch {
    return [];
  }
}

/**
 * A wall hit that failed: the call failed, or its wall's words came out of a top-level pipe (`go test 2>&1 | tail`),
 * whose exit code is the filter's, so 0 says nothing (fix-lab5). matchWall already drops planted and log-read text.
 */
function wallFailed(c: RunCall): boolean {
  if (c.failed) return true;
  return !!c.wall && typeof c.cmd === 'string' && splitTop(c.cmd).some((s) => s.sep === '|');
}

/**
 * Every failed call with a `wall` in the run that a later call (within 10) of the same command fixed with a
 * delta (4.12). One repair per retry, the earliest failure's; at most 5, oldest first.
 */
export function detectRepairs(run: RunState, opts: RepairOpts = {}): RepairEvent[] {
  const out: RepairEvent[] = [];
  try {
    const calls = Array.isArray(run?.calls) ? run.calls : [];
    const used = new Set<string>();
    for (let i = 0; i < calls.length && out.length < MAX_REPAIRS; i++) {
      const f = calls[i]!;
      if (!f.wall || !wallFailed(f) || !usable(f) || ignoredFailure(f, calls[i + 1] ?? null)) continue;
      const fc = coreOf(f.cmd!);
      if (!fc) continue;
      for (let j = i + 1; j <= i + WINDOW && j < calls.length; j++) {
        const r = calls[j]!;
        if (r.failed || r.wall || !usable(r) || used.has(r.id)) continue;
        const rc = coreOf(r.cmd!);
        if (!rc || !addedFlags(fc, rc)) continue;
        const delta = fixDelta(f, r, calls.slice(i + 1, j), opts);
        if (delta.length) {
          used.add(r.id);
          out.push({ cls: f.wall, program: programOf(fc), failCallId: f.id, fixCallId: r.id, delta, epoch: run.epoch, runId: run.id ?? null, at: r.at });
        }
        break;
      }
    }
  } catch {
    /* fail open: what was found so far */
  }
  return out;
}

/** At run close (runs.ts): `run.repairs` from its calls, while it still has them; left alone once they are emptied. */
export function noteRepairs(run: RunState, opts: RepairOpts = {}): void {
  if (!Array.isArray(run?.calls) || !run.calls.length) return;
  const found = detectRepairs(run, opts);
  if (found.length) run.repairs = found;
  else delete run.repairs;
}
