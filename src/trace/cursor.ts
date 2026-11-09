/**
 * Reading only what a growing JSONL file gained since the last read. Hooks run
 * on every turn and one real transcript passed 233 MB; reading it from the top
 * costs seconds, so each read starts at a byte offset saved in a small cursor
 * file and stops at the last complete line. A half-written last line is left
 * for the next read. The cursor holds offsets, the file's identity and a hash
 * of the few bytes before the offset, never any of the file's text.
 *
 * When the cursor doesn't match the file (none yet, the file shrank, was
 * replaced, or was rewritten in place), the read starts over. A first read
 * takes at most the last `firstReadBytes` of the file, starting at a line
 * boundary, so a hook that meets a huge session late still finishes in time.
 * Pass `Infinity` to read a whole file (trail init over past sessions).
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { readJson } from "../util/state.js";
import { writePrivateJson } from "./state.js";

export interface ReadOptions {
  /** How much of the file a read with no usable cursor takes, from the end. Default 8 MB. */
  firstReadBytes?: number;
}

/** Small state a reader keeps between reads (open tool calls), saved with the cursor. */
export type Memo = Record<string, unknown>;

export const FIRST_READ_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Bytes before the offset hashed to notice a file rewritten in place. */
const PRINT_BYTES = 64;
const NEWLINE = 0x0a;

interface Cursor {
  offset: number;
  dev: number;
  ino: number;
  print: string;
  memo: Memo;
}

function parseCursor(v: unknown): Cursor | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Partial<Cursor>;
  if (typeof c.offset !== "number" || !Number.isSafeInteger(c.offset) || c.offset < 0) return null;
  const memo = c.memo && typeof c.memo === "object" && !Array.isArray(c.memo) ? c.memo : {};
  return { offset: c.offset, dev: Number(c.dev) || 0, ino: Number(c.ino) || 0, print: typeof c.print === "string" ? c.print : "", memo };
}

/** A short hash of the bytes just before `offset`: "" at the start of the file. */
function fingerprint(fd: number, offset: number): string {
  if (offset <= 0) return "";
  const len = Math.min(PRINT_BYTES, offset);
  const buf = Buffer.alloc(len);
  const got = readSync(fd, buf, 0, len, offset - len);
  return createHash("sha1").update(buf.subarray(0, got)).digest("hex").slice(0, 16);
}

/** Whether the byte just before `offset` ends a line. */
function endsLine(fd: number, offset: number): boolean {
  const b = Buffer.alloc(1);
  return readSync(fd, b, 0, 1, offset - 1) === 1 && b[0] === NEWLINE;
}

/**
 * Hand each complete line `path` gained since the last read to `onLine`, with
 * the byte offset where the line starts in the file, then save where the read
 * stopped under the `trace` key of the JSON at `cursorPath` (0600), keeping
 * any other keys there. `memo` starts empty whenever the read starts over.
 * Throws when `path` can't be read; the caller decides how to fail open.
 */
export function readAppended(path: string, cursorPath: string, onLine: (line: string, memo: Memo, offset: number) => void, opts: ReadOptions = {}): void {
  // O_NONBLOCK: a FIFO where the transcript should be is opened at once and then refused, never waited on (review).
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return;
    const size = st.size;
    const stored = readJson<unknown>(cursorPath);
    const box: Record<string, unknown> = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
    const saved = parseCursor(box.trace);
    const sameFile = (c: Cursor) => !c.ino || !st.ino || (c.ino === st.ino && c.dev === st.dev);
    const resume = saved !== null && saved.offset <= size && sameFile(saved) && fingerprint(fd, saved.offset) === saved.print;
    let start: number;
    let memo: Memo;
    if (resume) {
      if (saved.offset === size) return;
      start = saved.offset;
      memo = saved.memo;
    } else {
      const cap = opts.firstReadBytes ?? FIRST_READ_BYTES;
      start = size > cap ? size - cap : 0;
      memo = {};
    }

    // Starting mid-file, the first newline is where whole lines begin, unless
    // the window opens right after one.
    let aligned = start === 0 || resume || endsLine(fd, start);
    let consumed = start;
    let carry: Buffer = Buffer.alloc(0);
    let pos = start;
    while (pos < size) {
      const want = Math.min(CHUNK_BYTES, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const got = readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      pos += got;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      // Where data[0] sits in the file.
      const dataStart = pos - data.length;
      let from = 0;
      if (!aligned) {
        const nl = data.indexOf(NEWLINE);
        if (nl < 0) {
          carry = data;
          continue;
        }
        from = nl + 1;
        aligned = true;
      }
      for (let nl = data.indexOf(NEWLINE, from); nl !== -1; nl = data.indexOf(NEWLINE, from)) {
        if (nl > from) onLine(data.toString("utf8", from, nl), memo, dataStart + from);
        from = nl + 1;
      }
      carry = data.subarray(from);
      consumed = pos - carry.length;
    }
    // A window with no line boundary in it: nothing read, and no offset worth keeping.
    if (!aligned) return;
    // Other hooks keep their state in the same file and may have written it
    // while this read ran: read it again so only `trace` changes. A reader
    // that got further on the same file wins; the offset never goes back.
    const now = readJson<unknown>(cursorPath);
    const latest: Record<string, unknown> = now && typeof now === "object" && !Array.isArray(now) ? (now as Record<string, unknown>) : {};
    const theirs = parseCursor(latest.trace);
    const ahead = theirs !== null && sameFile(theirs) && theirs.offset > consumed && theirs.offset <= fstatSync(fd).size && fingerprint(fd, theirs.offset) === theirs.print;
    if (!ahead) {
      latest.trace = { offset: consumed, dev: st.dev, ino: st.ino, print: fingerprint(fd, consumed), memo };
    }
    writePrivateJson(cursorPath, latest);
  } finally {
    closeSync(fd);
  }
}
