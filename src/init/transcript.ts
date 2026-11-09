/**
 * Reading one past Claude Code transcript for `trail init`'s look-back: what
 * the person typed (g4's shared filter decides, so IDE tags and reminders are
 * stripped and the prompt kept, pastes become a marker), each with its own
 * time and the end of Claude's reply before it, plus the tool calls, so a
 * session started in a folder above the repo can be judged by how much of its
 * work was in the repo.
 *
 * Files are read in chunks, line by line, never whole: one real transcript
 * passed 233 MB. Tool results are never parsed (they are most of the bytes
 * and hold nothing the person typed), and neither is any line over 2 MB.
 */
import { closeSync, readSync } from "node:fs";
import { basename } from "node:path";
import { openPlain } from "./plain-file.js";
import { ownText, textOf, typedText } from "../trace/claude.js";
import { labInteractive } from "../skills/host-facts.js";

/** Where a past session was found, as `trail init` counts them. */
export type SessionSource = "own" | "worktree" | "clone" | "ancestor";

/** One message the person wrote, with the end of what Claude said just before it. */
export interface PastPrompt {
  text: string;
  /** The tail of Claude's last reply before this message, so "no, use a worktree" reads on its own. */
  before?: string;
  /** ISO time it was sent, when the transcript says. */
  at?: string;
}

export interface PastSession {
  id: string;
  /** ISO time of the first message. */
  at: string;
  branch?: string;
  prompts: PastPrompt[];
  source?: SessionSource;
  /** The transcript file. */
  path?: string;
  /** The byte range the repo's work is in: the whole file, or an ancestor session's in-repo stretch (design 4.1). */
  stretch?: { from: number; to: number };
}

const PROMPT_CHARS = 1200;
const BEFORE_CHARS = 240;
/** How much of a file's start is read to find where its session began. */
const HEAD_BYTES = 256 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
/** No typed message or tool call worth reading is this long: a line over it is skipped unparsed. */
const MAX_LINE = 2 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * The date an ISO time fell on where the person lives (this machine's time
 * zone), `2026-10-09`; "" for anything else. Not the UTC date: UTC midnight
 * is mid-afternoon in California, so a restart at 4:55 and 5:05 pm would
 * count as two days.
 */
export function dayOf(iso: string | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  if (!/T\d{2}:\d{2}/.test(iso)) return iso.slice(0, 10);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * Each complete line of `path`, in order, read in chunks, with the byte offset it starts at. `range` reads only
 * the lines that start at or after `from` and before `to` (`from` must be a line start). Lines over 2 MB are
 * skipped unread. Throws when the file can't be opened or isn't a plain file (a FIFO would hang the read).
 */
export function eachLine(path: string, onLine: (line: string, offset: number) => void, range?: { from: number; to: number }): void {
  // Never a FIFO or a device, even one swapped in after discovery's stat (b5 review).
  const fd = openPlain(path, { follow: true });
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const end = range ? Math.max(0, range.to) : Infinity;
    let pos = range ? Math.max(0, range.from) : 0;
    let carry: Buffer = Buffer.alloc(0);
    // A line longer than MAX_LINE is dropped as it streams by, never held whole.
    let skipping = false;
    // Past `to`, read on only to finish a line that started before it.
    while (pos < end || (!skipping && carry.length > 0 && pos - carry.length < end)) {
      const got = readSync(fd, buf, 0, CHUNK_BYTES, pos);
      if (got <= 0) break;
      const dataStart = pos - carry.length;
      pos += got;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      let from = 0;
      for (let nl = data.indexOf(NEWLINE, from); nl !== -1; nl = data.indexOf(NEWLINE, from)) {
        const at = dataStart + from;
        if (at >= end) return;
        if (!skipping && nl > from && nl - from <= MAX_LINE) onLine(data.toString("utf8", from, nl), at);
        skipping = false;
        from = nl + 1;
      }
      if (data.length - from > MAX_LINE) {
        skipping = true;
        carry = Buffer.alloc(0);
      } else carry = Buffer.from(data.subarray(from));
    }
    const at = pos - carry.length;
    if (!skipping && carry.length && carry.length <= MAX_LINE && at < end) onLine(carry.toString("utf8"), at);
  } finally {
    closeSync(fd);
  }
}

/** The first `cwd` in the first 256 KB of a transcript: the folder its session started in. Null when there's none or the file can't be read. */
export function firstCwd(path: string): string | null {
  let text: string;
  try {
    const fd = openPlain(path, { follow: true });
    try {
      const buf = Buffer.allocUnsafe(HEAD_BYTES);
      text = buf.toString("utf8", 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}

/** One message's words, cut at PROMPT_CHARS; null when there are none. */
function capped(t: string): string | null {
  if (!t) return null;
  return t.length > PROMPT_CHARS ? `${t.slice(0, PROMPT_CHARS)}…` : t;
}

/** The person's message with what isn't theirs taken out (trace/claude.ts decides), or null when nothing of theirs is left. */
export function ownWords(raw: string): string | null {
  return capped(ownText(raw));
}

interface Entry {
  type?: string;
  cwd?: string;
  entrypoint?: string;
  timestamp?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  message?: { content?: unknown } | null;
}

/** Everything the look-back takes from one transcript, in the order it happened. */
export interface Scan {
  /** A headless run (`claude -p`, the SDKs): its prompts were written once and replayed. */
  headless: boolean;
  branch?: string;
  /** The person's messages; `i` is the order among prompts and calls, `o` the byte offset of its line. */
  prompts: (PastPrompt & { i: number; o: number })[];
  /** Tool calls; `inRepo` only when a `touches` test was given; `o` the byte offset of its line. */
  calls: { i: number; o: number; inRepo: boolean }[];
}

/**
 * One transcript's typed messages and tool calls. `touches(cwd, name, input)`
 * says whether a tool call worked in the repo; without it every call counts
 * as out of the repo. `env` decides only whether an sdk run is read (a lab home with the switch, D99). Never throws:
 * an unreadable file scans as empty.
 */
export function scanTranscript(path: string, touches?: (cwd: string, name: string, input: unknown) => boolean,
  env: NodeJS.ProcessEnv = process.env): Scan {
  const scan: Scan = { headless: false, prompts: [], calls: [] };
  let i = 0;
  let lastReply = "";
  try {
    eachLine(path, (line, o) => {
      // Tool output is most of a transcript and never the person's words.
      if (scan.headless || line.includes('"type":"tool_result"')) return;
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        return;
      }
      if (!e || typeof e !== "object") return;
      // A script's run, unless a lab home has the switch (D99, D136 (2)), as the hooks read it.
      if (typeof e.entrypoint === "string" && e.entrypoint.startsWith("sdk") && !labInteractive(env)) {
        scan.headless = true;
        return;
      }
      if (e.isSidechain) return;
      if (e.type === "assistant") {
        const content = e.message?.content;
        const said = textOf(content).trim();
        if (said) lastReply = said;
        if (!Array.isArray(content)) return;
        for (const part of content as Array<Record<string, unknown> | null>) {
          if (!part || typeof part !== "object" || part.type !== "tool_use") continue;
          let inRepo = false;
          try {
            inRepo = touches ? touches(typeof e.cwd === "string" ? e.cwd : "", String(part.name ?? ""), part.input) : false;
          } catch {
            /* a call that can't be judged isn't in the repo */
          }
          scan.calls.push({ i: i++, o, inRepo });
        }
        return;
      }
      // The one typed-words filter every learning path shares.
      const words = capped(typedText(e, env));
      if (!words) return;
      scan.branch ||= e.gitBranch;
      const before = lastReply ? lastReply.slice(-BEFORE_CHARS).replace(/\s+/g, " ").trim() : undefined;
      const at = typeof e.timestamp === "string" ? e.timestamp : undefined;
      scan.prompts.push({ text: words, ...(before ? { before } : {}), ...(at ? { at } : {}), i: i++, o });
      lastReply = "";
    });
  } catch {
    /* unreadable: nothing in it */
  }
  return scan;
}

/** A session from scanned prompts, or null when none is left. */
export function sessionOf(path: string, scan: Scan, prompts: Array<PastPrompt & { i: number; o?: number }> = scan.prompts, source?: SessionSource): PastSession | null {
  if (scan.headless || !prompts.length) return null;
  return {
    id: basename(path, ".jsonl"),
    path,
    at: prompts.find((p) => p.at)?.at ?? "",
    branch: scan.branch,
    prompts: prompts.map(({ i: _i, o: _o, ...p }) => p),
    ...(source ? { source } : {}),
  };
}

/**
 * One transcript's messages from the person, oldest first. Headless runs
 * (`claude -p`, scripts) are skipped whole: their prompts were written once
 * and replayed, so a repeat there isn't the person repeating themselves.
 */
export function readSession(path: string): PastSession | null {
  return sessionOf(path, scanTranscript(path));
}
