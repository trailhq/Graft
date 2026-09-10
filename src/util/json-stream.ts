/**
 * Streamed, atomic file writes and line iteration over a Buffer.
 *
 * Every graft artifact used to be one `JSON.stringify` and one `JSON.parse`.
 * V8 caps a string at ~512 MiB (`buffer.constants.MAX_STRING_LENGTH`); a
 * 65k-file repo's extract cache is ~1 GB and its wiring.json ~0.5 GB, so the
 * cold build threw `Invalid string length` at the very end, and a graph that
 * did get written threw `ERR_STRING_TOO_LONG` on read. The writers here take
 * one element at a time; the reader decodes one line at a time.
 */
import { closeSync, constants, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface AtomicWriter {
  write(chunk: string): void;
  commit(): void;
  abort(): void;
}

/** Pending text is flushed once it reaches this many UTF-16 units: one syscall per
 * ~1 MiB instead of one per element (a large graph is ~1M lines). */
const FLUSH_AT = 1 << 20;

/** Write to a scratch file next to `path`, then rename over `path` on commit().
 * Same discipline as `writeJsonAtomic` in util/state.ts (D85): a pid plus a random
 * suffix keeps two concurrent writers off each other's scratch file, and it is
 * opened new-only and never through a link, so a link planted where the temp file
 * goes is neither written through nor renamed into place. */
export function openAtomic(path: string): AtomicWriter {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o666);
  let pending = "";
  const flush = (): void => {
    if (fd === null || pending === "") return;
    // writeSync may write fewer bytes than asked (pipes, some filesystems):
    // loop on the byte count, so a multi-megabyte element is never truncated.
    const bytes = Buffer.from(pending, "utf8");
    pending = "";
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
  };
  const cleanup = (): void => {
    pending = "";
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } fd = null; }
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
  };
  return {
    write(chunk) {
      if (fd === null) throw new Error("atomic writer is closed");
      pending += chunk;
      if (pending.length >= FLUSH_AT) flush();
    },
    commit() {
      if (fd === null) throw new Error("atomic writer is closed");
      try {
        flush();
        closeSync(fd);
        fd = null;
        renameSync(tmp, path);
      } catch (e) {
        cleanup();
        throw e;
      }
    },
    abort() { cleanup(); },
  };
}

/** Call `fn` for each line of `buf`. A trailing line without "\n" is still a line;
 * an empty buffer yields none. Each line is decoded on its own, so the Buffer may
 * be larger than any string V8 can hold. */
export function forEachLine(buf: Buffer, fn: (line: string, index: number) => void): void {
  let start = 0;
  let index = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    fn(buf.toString("utf8", start, end), index++);
    start = end + 1;
  }
}
