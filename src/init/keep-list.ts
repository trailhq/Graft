/**
 * Where init's list is in a session's transcript, and what followed it
 * (design 4.9 steps 2 to 4, R22): shared by the PreToolUse keep gate, which
 * finds it, and `trail keep`'s CLI half, which reads it again from the
 * receipt's offset and must see the same.
 *
 * A list is either the tool_result of a Bash call that only runs
 * `trail init` (no pipe, no redirect, nothing but Trail), holding
 * RELAY_LINE and KEEP_LINE; or, for the session the record handed the list
 * to at its start, the transcript from the recorded offset. A RELAY_LINE in
 * any other result (an `echo`, a `cat` of a saved copy) is not a list. After
 * the list: the agent's text up to the first line the person typed, that
 * line, and whether any call since the list wrote Trail's or the host's
 * files (1a's tamper check).
 *
 * Reads at most the transcript's last 8 MB (the gate) or 8 MB from the list
 * (the CLI), as whole lines with their byte offsets; never a FIFO.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isTypedByPerson, typedText } from '../trace/claude.js';
import { leadingCds, onlyTrail, simpleCommands } from '../trace/shell.js';
import { tamperOf } from '../trace/tamper.js';
import { trailHome } from '../notes/trail-home.js';
import { claudeTranscript, openPlain } from './plain-file.js';
import { KEEP_LINE, RELAY_LINE } from './relay.js';

/** How much of the transcript is read: the list is printed moments before the answer. */
export const TAIL_BYTES = 8 * 1024 * 1024;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Whole lines with their byte offsets, from `from` (a line start) or the last `bytes` of the file; null when unreadable. */
export function linesFrom(path: string, opts: { from?: number; bytes?: number }): Array<{ line: string; offset: number }> | null {
  let fd: number;
  try {
    fd = openPlain(path, { follow: true });
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const bytes = opts.bytes ?? TAIL_BYTES;
    const start = opts.from !== undefined ? opts.from : Math.max(0, size - bytes);
    if (!Number.isSafeInteger(start) || start < 0 || start > size) return null;
    const end = Math.min(size, start + bytes);
    const buf = Buffer.allocUnsafe(end - start);
    const got = readSync(fd, buf, 0, buf.length, start);
    const out: Array<{ line: string; offset: number }> = [];
    let at = 0;
    // A window that opens mid-line starts at the next whole one; a list offset must be a line start.
    if (start > 0 && opts.from === undefined) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0 || nl >= got) return [];
      at = nl + 1;
    }
    while (at < got) {
      const nl = buf.indexOf(0x0a, at);
      if (nl < 0 || nl >= got) break;
      out.push({ line: buf.toString('utf8', at, nl), offset: start + at });
      at = nl + 1;
    }
    return out;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

type Entry = Record<string, unknown>;
const contentOf = (e: Entry): unknown[] => {
  const c = (e.message as { content?: unknown } | null | undefined)?.content;
  return Array.isArray(c) ? c : [];
};
const resultText = (part: Record<string, unknown>): string => {
  const c = part.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('\n');
  return '';
};

/**
 * A Bash command that only runs `trail init`: Trail's own (1a's `onlyTrail`), with no pipe that could cut its list,
 * and nothing else beside it but leading `cd`s (b6 review): `trail init; echo …`, `echo …; trail init --help` or
 * `trail init && cat saved.txt` would put text of the agent's own in the same result as the list.
 */
export function initOnly(command: string): boolean {
  // `onlyTrail` knows `npx @trailhq/trail-code` and `npx @nanonets/graft` itself; stripping `npx` first made those
  // `@trailhq/trail-code init`, which is no program, so an npx init was never a list (b6 review).
  return !/(?:^|[^|])\|(?!\|)/.test(command) && onlyTrail(command) && simpleCommands(leadingCds(command).rest).length === 1;
}

export interface ListAt {
  via: 'init-call' | 'handover';
  /** The tool_result line's offset (init call), or the handover's recorded offset. */
  offset: number;
  /** The tool result's text (init call); '' for a handover. */
  text: string;
}

/**
 * The newest list in the transcript's tail: a clean `trail init` call's result, or this session's handover offset.
 * `cut` when the newest `trail init` call is newer than any list and its output is not a list (a pipe, a redirect,
 * another command with it). Null when there is none, or the transcript can't be read.
 */
export function findList(path: string, isInit: (command: string) => boolean, handover: { offset: number } | null):
  { list: ListAt | null; cut: number | null } | null {
  const lines = linesFrom(path, {});
  if (!lines) return null;
  const calls = new Map<string, boolean>();
  let list: ListAt | null = handover ? { via: 'handover', offset: handover.offset, text: '' } : null;
  let cut: number | null = null;
  for (const { line, offset } of lines) {
    const use = line.includes('"tool_use"') && /\binit\b/.test(line);
    const result = line.includes('"tool_result"');
    if (!use && !result) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object' || e.isSidechain === true) continue;
    for (const raw of contentOf(e)) {
      const part = raw as Record<string, unknown> | null;
      if (!part || typeof part !== 'object') continue;
      if (e.type === 'assistant' && part.type === 'tool_use' && part.name === 'Bash') {
        const command = (part.input as { command?: unknown } | null)?.command;
        if (typeof command === 'string' && isInit(command) && typeof part.id === 'string') calls.set(part.id, initOnly(command));
      } else if (e.type === 'user' && part.type === 'tool_result' && typeof part.tool_use_id === 'string' && calls.has(part.tool_use_id)) {
        const text = resultText(part);
        const clean = calls.get(part.tool_use_id)!;
        if (clean && text.includes(RELAY_LINE) && text.includes(KEEP_LINE)) {
          if (!list || offset > list.offset) list = { via: 'init-call', offset, text };
          cut = null;
        } else if (!list || offset > list.offset) cut = offset;
      }
    }
  }
  if (cut !== null && list && list.offset > cut) cut = null;
  return { list, cut };
}

export interface AfterList {
  /** The agent's text between the list and the person's newest typed line, joined by newlines. */
  reply: string;
  replySha: string;
  typed: { offset: number; lineSha: string; text: string } | null;
  /** A call after the list wrote Trail's or the host's files. */
  tampered: boolean;
}

/**
 * What follows the list: read from its offset (an init call's result line is skipped). The answer is the person's
 * newest typed line after the list (b6 review): the relay itself invites "Show one in full", so a first line that asks
 * to see an item must not lock the list; a later change of mind ("actually none") wins over earlier numbers. The
 * reply is the agent's text from the list up to that line.
 */
export function afterList(path: string, list: { offset: number; via: 'init-call' | 'handover' }, env: NodeJS.ProcessEnv = process.env): AfterList | null {
  const lines = linesFrom(path, { from: list.offset });
  if (!lines) return null;
  const reply: string[] = [];
  let typed: AfterList['typed'] = null;
  /** How many reply parts came before the newest typed line. */
  let upTo = 0;
  let tampered = false;
  const ctx = { trailHome: trailHome(env), transcriptPath: path, home: env.HOME || homedir() };
  for (const [k, { line, offset }] of lines.entries()) {
    if (k === 0 && list.via === 'init-call') continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object' || e.isSidechain === true) continue;
    if (e.type === 'assistant') {
      for (const raw of contentOf(e)) {
        const part = raw as Record<string, unknown> | null;
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') reply.push(part.text);
        if (part.type === 'tool_use') {
          const input = part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {};
          const name = String(part.name ?? '');
          const raw2 = name === 'Bash' && typeof input.command === 'string' ? input.command : null;
          try {
            if (tamperOf(name, input, raw2, { ...ctx, folder: typeof e.cwd === 'string' ? e.cwd : null })) tampered = true;
          } catch { /* unreadable call: not counted */ }
        }
      }
    } else if (isTypedByPerson(e, env)) {
      // b7 (J02 leg C): a handed-over list is in the session's start context, so the person types first and the agent
      // shows the list in its reply; a typed line before any reply text is not the answer to the list.
      if (list.via === 'handover' && !reply.some((t) => t.trim())) continue;
      typed = { offset, lineSha: sha256(line), text: typedText(e, env) };
      upTo = reply.length;
    }
  }
  const text = reply.slice(0, upTo).join('\n');
  return { reply: text, replySha: sha256(text), typed, tampered };
}

/**
 * The person's line a pointer names, read again: replay-runs' `typedAt` rules (a transcript in Claude Code's projects
 * folder reached with no link, the line at the offset with the same sha, a line the person typed), in this light
 * file so the hook's keep check never loads the replay and compile (R11). Null otherwise.
 */
export function typedLine(ref: { t: string; o: number; s: string }, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (!Number.isSafeInteger(ref.o) || ref.o < 0 || !/^[0-9a-f]{64}$/.test(ref.s) || !claudeTranscript(ref.t, env)) return null;
    const [first] = linesFrom(ref.t, { from: ref.o, bytes: 2 * 1024 * 1024 }) ?? [];
    if (!first || first.offset !== ref.o) return null;
    if (ref.o > 0) {
      const [prev] = linesFrom(ref.t, { from: ref.o - 1, bytes: 1 }) ?? [];
      if (prev === undefined || prev.line !== '') return null;
    }
    if (sha256(first.line) !== ref.s) return null;
    return typedText(JSON.parse(first.line), env) || null;
  } catch {
    return null;
  }
}
