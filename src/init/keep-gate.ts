/**
 * The PreToolUse check for `trail keep` (design 4.9, PreToolUse half): an
 * agent may keep init's items only with the numbers the person typed after
 * seeing the list.
 *
 * 1. `trail keep --help` / `-h` pass, nothing else checked (B4, P36).
 * 2. The list (keep-list.ts, R22): the newest clean `trail init` call's own
 *    result, or this session's handover offset from the init record. A
 *    `trail init | tail` (or a redirect) is denied with words that say to run
 *    it plainly. No list: phase 0's wait reason.
 * 3. The agent's text between the list and the person's next typed line
 *    names every pending item as `{n}.` and its name words.
 * 4. That typed line is a whole-message answer (numbers, all, none).
 * 5. The command's numbers are within it.
 * 6. On allow it writes the KeepReceipt `trail keep`'s CLI half needs (R23)
 *    and returns null. The write is idempotent: both registered copies of the
 *    hook may run it, and the second finds the same receipt there.
 *
 * Loaded lazily by `pre-bash.ts` `keepReply`, only for a command that says
 * `keep`. Fails open (null) on a payload that isn't Claude Code's or a
 * transcript it can't read; then no receipt is written and the CLI holds.
 */
import { createHash } from 'node:crypto';
import type { PreBashDecision } from '../claude/pre-bash.js';
import type { KeepReceipt } from '../skills/types.js';
import { detectHost } from '../trace/host.js';
import { readJsonSafe, trailPath, writePrivate } from '../util/private-fs.js';
import { listInitRecords, type InitRecord } from './init-record.js';
import { answerWords, keepArgs, keepWords, leadWords, parseKeepAnswer, replyNamesList, withinAnswer } from './keep-answer.js';
import { afterList, findList, typedLine } from './keep-list.js';
import { prefText } from './prefs.js';
import type { KeepAnswer } from './types.js';

export { TAIL_BYTES } from './keep-list.js';

/** `trail <sub> …` however it's spelled: through a path, npx, node on the built file, inside `bash -c "…"`, after env assignments or `cd … &&`, with global options before the subcommand. */
const run = (sub: string) =>
  new RegExp(`(?:^|[\\s;&|(\`'"/=])(?:trail|graft|trail-code)(?:\\.[cm]?[jt]s)?['"]?\\s+(?:--?[\\w-]+(?:=\\S+|\\s+(?!${sub}\\b)[^\\s-]\\S*)?\\s+)*${sub}(?=$|[\\s;&|)'"\`])`);
const KEEP = run('keep');
const INIT = run('init');

export function isKeepCommand(command: string): boolean {
  return KEEP.test(command);
}

/** Whether a shell command runs `trail init`. */
export function isInitCommand(command: string): boolean {
  return INIT.test(command);
}

export const WAIT =
  "Wait for the person's answer before running trail keep: show them the list trail init printed, as written, and run trail keep only with the numbers they choose. Don't choose for them.";
export const CUT = 'Show the person the list trail init printed: run trail init again without a pipe or redirect, then ask them.';
export const SHOW_LIST = 'Show the person the whole list as trail init printed it, numbers and names, then ask which to keep.';
export const NEED_NUMBERS = 'Trail needs the numbers the person typed. Ask them which numbers to keep, or none.';
export const NOT_THIS_LIST = "That list isn't the one waiting in this repo: run trail init again, show the person its list as written, then ask them.";
export const CHANGED = "This session changed Trail's own files after the list, so Trail won't keep anything from it. Run trail init again and show the person its list.";
const typedOnly = (a: KeepAnswer) => `The person typed ${answerWords(a)}; keep only those.`;

/** What `trail keep` asks for in this command, or null when its words aren't numbers, all or none. */
/** Every `trail keep` in the command, as the words each one gets (keepWords: redirections and trailing commands read past). */
function keepCalls(command: string): string[][] {
  const all = new RegExp(KEEP.source, 'g');
  return [...String(command).slice(0, 64 * 1024).matchAll(all)].slice(0, 8).map((m) => keepWords(command.slice(m.index! + m[0].length)).words);
}

/**
 * What `trail keep` asks for in this command, or null when its words aren't numbers, all or none. `trail keep 1 2>&1`
 * and `trail keep 1 | cat` ask for 1 (fix-lab5); a second `trail keep` asking for something else is no answer.
 */
export function keepCommandAnswer(command: string): KeepAnswer | null {
  const calls = keepCalls(command);
  if (!calls.length) return null;
  const answers = calls.map((w) => keepArgs(w));
  const first = answers[0]!;
  return first && answers.every((a) => JSON.stringify(a) === JSON.stringify(first)) ? first : null;
}

/** `trail keep --help` or `-h`, with or without a redirect or a reader after it: usage only, never denied (B4, P36). Not when another `trail keep` is chained on. */
export function keepHelp(command: string): boolean {
  const calls = keepCalls(command);
  return calls.length === 1 && calls[0]!.length === 1 && /^(?:--help|-h)$/.test(calls[0]![0]!);
}

/** The pending items with their name words; a preference's rebuilt from the person's line, read again by its pointer. */
export function pendingNames(r: InitRecord, env: NodeJS.ProcessEnv): Array<{ n: number; nameWords: string[] }> {
  return r.pending.map((p) => {
    if (p.kind !== 'preference') return { n: p.n, nameWords: p.nameWords };
    const ref = p.pref?.refs[0];
    const text = ref ? typedLine(ref, env) : null;
    return { n: p.n, nameWords: text ? leadWords(prefText(text).slice(0, 120)) : [] };
  });
}

const fileId = (sessionId: string) =>
  /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(sessionId) ? sessionId : `h-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;

/** receipts/<session-id>.keep.json */
export function keepReceiptPath(sessionId: string, env?: NodeJS.ProcessEnv): string {
  return trailPath(env, 'receipts', `${fileId(sessionId)}.keep.json`);
}

const sameAnswer = (a: KeepReceipt, b: KeepReceipt) =>
  a.session === b.session && a.toolUseId === b.toolUseId && a.list.offset === b.list.offset && a.list.initRunId === b.list.initRunId
  && a.typed.offset === b.typed.offset && a.typed.lineSha === b.typed.lineSha && a.replySha === b.replySha && JSON.stringify(a.numbers) === JSON.stringify(b.numbers);

/** Writes the receipt unless the same one, unused, is already there (the other hook copy wrote it). */
function writeKeepReceipt(r: KeepReceipt, env: NodeJS.ProcessEnv): void {
  const path = keepReceiptPath(r.session, env);
  const cur = readJsonSafe<KeepReceipt>(path);
  if (cur && cur.usedAt === null && sameAnswer(cur, r)) return;
  writePrivate(path, `${JSON.stringify(r, null, 2)}\n`);
}

const deny = (reason: string): PreBashDecision => ({ permissionDecision: 'deny', reason });

/** The decision for a Bash call: deny a `trail keep` the person hasn't answered for, null (and a receipt) to let it run. Never throws. */
export function keepDecision(input: unknown, _dir: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): PreBashDecision | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const payload = input as Record<string, unknown>;
    const command = (payload.tool_input as { command?: unknown } | null | undefined)?.command;
    if (typeof command !== 'string' || !isKeepCommand(command)) return null;
    // Another host's transcript isn't Claude Code's to read.
    if (detectHost(payload).host !== 'claude') return null;
    if (keepHelp(command) && !isInitCommand(command)) return null;
    if (isInitCommand(command)) return deny(WAIT);
    const path = payload.transcript_path;
    const session = typeof payload.session_id === 'string' ? payload.session_id : '';
    if (typeof path !== 'string' || !path || !session) return null;
    // Every record on this machine, not the cwd's repo: resolving the repo would load the notes layer on the hook's path.
    const records = listInitRecords(env);
    const handed = records.filter((x) => x.record.handover?.session === session && x.record.pending.length && x.record.pendingFrom)
      .sort((a, b) => b.record.handover!.offset - a.record.handover!.offset)[0];
    const found = findList(path, isInitCommand, handed ? { offset: handed.record.handover!.offset } : null);
    if (!found) return null;
    if (found.cut !== null) return deny(CUT);
    const list = found.list;
    if (!list) return deny(WAIT);
    let record: InitRecord | null = null;
    let items: Array<{ n: number; nameWords: string[] }> = [];
    if (list.via === 'handover') {
      record = handed!.record;
      items = pendingNames(record, env);
    } else {
      // The record whose waiting list is the one this call printed, newest first.
      for (const x of records.filter((r) => r.record.pending.length && r.record.pendingFrom).sort((a, b) => String(b.record.shownAt).localeCompare(String(a.record.shownAt)))) {
        const names = pendingNames(x.record, env);
        if (replyNamesList(list.text, names)) {
          record = x.record;
          items = names;
          break;
        }
      }
    }
    if (!record || !record.pendingFrom) return deny(NOT_THIS_LIST);
    const after = afterList(path, list, env);
    if (!after) return null;
    if (after.tampered) return deny(CHANGED);
    if (!after.typed) return deny(WAIT);
    if (!replyNamesList(after.reply, items)) return deny(SHOW_LIST);
    const typed = parseKeepAnswer(after.typed.text);
    if (!typed) return deny(NEED_NUMBERS);
    const asked = keepCommandAnswer(command);
    if (!asked) return deny(NEED_NUMBERS);
    if (!withinAnswer(asked, typed, record.pending.map((p) => p.n))) return deny(typedOnly(typed));
    writeKeepReceipt({
      v: 1, kind: 'keep', session, transcriptPath: path, toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '',
      list: { offset: list.offset, initRunId: record.pendingFrom, via: list.via },
      typed: { offset: after.typed.offset, lineSha: after.typed.lineSha }, replySha: after.replySha,
      numbers: 'none' in asked ? 'none' : 'all' in asked ? 'all' : asked.numbers, at: now.toISOString(), verdict: 'live', usedAt: null,
    }, env);
    return null;
  } catch {
    return null;
  }
}
