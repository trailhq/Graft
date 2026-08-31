/**
 * The local event queue: one NDJSON line per event in `~/.graft/`.
 *
 * The queue exists because graft is a CLI, not an app. Every other tool we
 * studied sends from a process that is already running and can afford to wait;
 * `graft ask` lives for two seconds and its whole value proposition is being
 * faster than reading files. So nothing is ever sent inline — events are
 * appended here, and a detached child (`graft _telemetry-flush`, once a day)
 * does the network. A user who is offline for a week loses nothing; a user on a
 * hostile network never notices, because no command ever waits on a socket.
 *
 * Concurrency: appends are a single `appendFileSync` of one short line to a file
 * opened `O_APPEND`, which POSIX makes atomic below PIPE_BUF (4 KB — an event is
 * ~300 bytes). Two graft processes interleaving cannot produce a torn line.
 *
 * Draining renames the file first and reads the renamed copy, so events appended
 * during a flush land in a fresh queue instead of being dropped by the truncate.
 */
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

/**
 * The ceiling on the queue. An unflushable machine — permanently offline, or a
 * key that never works — must not grow a file in someone's home forever.
 *
 * Bytes are the bound, because size is the only thing cheap enough to check on
 * every append (one `statSync`); counting lines would mean reading the whole
 * file each time. {@link TRIM_TO_EVENTS} is not a second ceiling — it is how
 * FAR a trim cuts back, so a queue of unusually small events sheds a worthwhile
 * amount rather than one line at a time. Between trims the file can hold more
 * than that many events, and can exceed the byte bound by one append.
 */
export const MAX_QUEUE_BYTES = 256 * 1024;
export const TRIM_TO_EVENTS = 500;

export function queuePath(home: string = homedir()): string {
  return join(home, '.graft', 'telemetry-queue.ndjson');
}

/**
 * Append one event. Never throws — a full disk or a read-only home must not fail
 * the command the user actually ran.
 */
export function enqueue(event: unknown, home?: string): void {
  const path = queuePath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + '\n');
    trim(path);
  } catch { /* unwritable home, full disk — telemetry is never worth an error */ }
}

/**
 * Enforce the cap by dropping the OLDEST events. Newest-wins because the recent
 * ones describe the version the user is on now; a year-old queue from 0.9
 * answers nothing. Only rewrites when actually over, so the common path is one
 * `statSync`.
 */
function trim(path: string): void {
  let size: number;
  try { size = statSync(path).size; } catch { return; }
  if (size <= MAX_QUEUE_BYTES) return;
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    // Walk backwards from the newest, taking lines while both budgets hold, so
    // the file left behind always satisfies the byte bound — a count-only trim
    // would leave 500 large events well over it.
    const kept: string[] = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0 && kept.length < TRIM_TO_EVENTS; i--) {
      bytes += Buffer.byteLength(lines[i]) + 1;
      if (bytes > MAX_QUEUE_BYTES) break;
      kept.push(lines[i]);
    }
    kept.reverse();
    writeFileSync(path, kept.length ? kept.join('\n') + '\n' : '');
  } catch { /* leave it; the next drain clears it anyway */ }
}

/**
 * Take everything pending, leaving an empty queue behind.
 *
 * The rename is what makes this safe against a concurrent append: from the
 * instant it returns, other processes are writing to a brand-new file. Malformed
 * lines are skipped rather than poisoning the batch — a torn write from a crash
 * mid-append should cost one event, not the whole queue.
 */
export function drain(home?: string): unknown[] {
  const path = queuePath(home);
  const taken = `${path}.${process.pid}.sending`;
  try { renameSync(path, taken); } catch { return []; } // nothing queued
  let text = '';
  try { text = readFileSync(taken, 'utf8'); } catch { /* fall through to cleanup */ }
  try { rmSync(taken, { force: true }); } catch { /* best effort */ }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line — skip just this one */ }
  }
  return out;
}

/** Read without draining, for `graft telemetry debug`. */
export function peek(home?: string): unknown[] {
  const out: unknown[] = [];
  let text = '';
  try { text = readFileSync(queuePath(home), 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

/** Put a failed batch back, so a flush that could not reach the network does not
 *  silently discard a week of events. Oldest-first, ahead of anything queued
 *  since the drain. */
export function requeue(events: unknown[], home?: string): void {
  if (events.length === 0) return;
  const path = queuePath(home);
  try {
    const pending = (() => { try { return readFileSync(path, 'utf8'); } catch { return ''; } })();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n' + pending);
    trim(path);
  } catch { /* best effort */ }
}
