/**
 * Receipts (design 2.7, 4.9): what the PreToolUse save gate decided about one
 * `trail skills add`, for the CLI that runs right after it. One per session
 * (`~/.trail/receipts/<session-id>.json`), replaced by the next add, found
 * only for its run and name while fresh, and used once: the CLI sets `usedAt`
 * when it acts on it, and a used receipt never counts again.
 *
 * A receipt is a hint, never proof. The CLI re-decides from the transcript
 * (4.9 CLI half); a receipt the agent wrote itself is caught there.
 *
 * `lineAt` is the one positioned read the gate makes of the transcript: the
 * line that starts at a byte offset the fold recorded, so the gate checks the
 * person's typed line and each step's call and result without reading the
 * whole file.
 */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Receipt } from './types.js';
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { sessionPath } from '../trace/gate-file.js';
import { dialectFor } from '../trace/dialect.js';

/** A receipt older than this is stale: the CLI runs right after its PreToolUse. */
const FRESH_MS = 10 * 60_000;
/** Clock skew allowed between the hook and the CLI. */
const AHEAD_MS = 5_000;
const DEFAULT_MAX_LINE = 1024 * 1024;
const TIERS = new Set(['A', 'B', 'C', 'D']);
const CONSENTS = new Set(['offer-yes', 'asked', 'none']);
const ASKED = new Set(['this repo', 'every repo', 'repo', 'team']);

/** A session id as a file name, as phase 0's state.ts does it: anything odd is hashed. */
function fileId(sessionId: string): string {
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return sessionId;
  return `h-${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)}`;
}

const receiptsDir = (env?: NodeJS.ProcessEnv) => trailPath(env, 'receipts');

/** <home>/receipts/<session-id>.json */
export function receiptPath(sessionId: string, env?: NodeJS.ProcessEnv): string {
  return join(receiptsDir(env), `${fileId(String(sessionId))}.json`);
}

/** Replaces the session's previous receipt. */
export function writeReceipt(r: Receipt, env?: NodeJS.ProcessEnv): void {
  writePrivate(receiptPath(r.session, env), `${JSON.stringify(r, null, 2)}\n`);
}

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The receipt as Trail writes it, or null: a file of any other shape is not one. */
function asReceipt(v: unknown): Receipt | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Receipt;
  if (r.v !== 1 || !str(r.session) || !str(r.transcriptPath) || !str(r.toolUseId) || !str(r.runId) || !str(r.name) || !str(r.at)) return null;
  if (!str(r.host) || !TIERS.has(r.tier) || !CONSENTS.has(r.consent) || (r.offerId !== null && !str(r.offerId))) return null;
  if (r.typed !== null && (!r.typed || typeof r.typed !== 'object' || !num(r.typed.offset) || !str(r.typed.lineSha))) return null;
  if (typeof r.typedYes !== 'boolean' || typeof r.typedSave !== 'boolean' || (r.asked !== null && !ASKED.has(r.asked))) return null;
  if (!num(r.stepsTotal) || !num(r.stepsVerified) || (r.verdict !== 'live' && r.verdict !== 'held')) return null;
  if (r.usedAt !== null && !str(r.usedAt)) return null;
  if (r.checkout !== undefined && !str(r.checkout)) return null;
  return r;
}

/** One receipt file, read only when it is a regular file (never through a link). */
function readReceiptFile(path: string): Receipt | null {
  try {
    if (!lstatSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return asReceipt(readJsonSafe<unknown>(path));
}

/** The unused receipt (usedAt null) for this run and name, fresh (<= 10 min old, not > 5 s in the future). Scans receipts/*.json. */
export function findReceipt(runId: string, name: string, now: Date = new Date(), env?: NodeJS.ProcessEnv): Receipt | null {
  let names: string[];
  try {
    names = readdirSync(receiptsDir(env));
  } catch {
    return null;
  }
  let best: Receipt | null = null;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const r = readReceiptFile(join(receiptsDir(env), n));
    if (!r || r.usedAt !== null || r.runId !== runId || r.name !== name) continue;
    const age = now.getTime() - Date.parse(r.at);
    if (Number.isNaN(age) || age > FRESH_MS || age < -AHEAD_MS) continue;
    if (!best || Date.parse(r.at) > Date.parse(best.at)) best = r;
  }
  return best;
}

const sameReceipt = (a: Receipt, b: Receipt) =>
  a.session === b.session && a.toolUseId === b.toolUseId && a.runId === b.runId && a.name === b.name && a.at === b.at;

/** Sets usedAt on the receipt on disk, when it is still this one (a newer add replaces it, and stays unused). */
export function markReceiptUsed(r: Receipt, now: Date = new Date(), env?: NodeJS.ProcessEnv): void {
  const path = receiptPath(r.session, env);
  withLock(path, () => {
    const cur = readReceiptFile(path);
    if (!cur || !sameReceipt(cur, r) || cur.usedAt !== null) return;
    writePrivate(path, `${JSON.stringify({ ...cur, usedAt: now.toISOString() }, null, 2)}\n`);
  }, 1000);
}

/**
 * The transcript line that starts at offset: one positioned read of at most maxBytes (default 1 MB), from the
 * byte before it, so an offset inside a line is refused. null past the end, with no newline within maxBytes, or
 * unreadable.
 */
export function lineAt(transcriptPath: string, offset: number, maxBytes: number = DEFAULT_MAX_LINE): string | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || !(maxBytes > 0)) return null;
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const from = offset === 0 ? 0 : offset - 1;
    const lead = offset - from;
    const buf = Buffer.alloc(lead + Math.floor(maxBytes));
    const n = readSync(fd, buf, 0, buf.length, from);
    if (n <= lead) return null;
    if (lead === 1 && buf[0] !== 0x0a) return null;
    const end = buf.indexOf(0x0a, lead);
    if (end < 0 || end >= n) return null;
    return buf.subarray(lead, end).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The whole lines that end right before `offset` (which must be a line start), oldest first: one positioned read of
 * at most maxBytes (default 1 MB) back from it. A line cut by the window is left out. [] at offset 0, inside a
 * line, or unreadable.
 */
export function linesBefore(transcriptPath: string, offset: number, maxBytes: number = DEFAULT_MAX_LINE): string[] {
  if (!Number.isSafeInteger(offset) || offset <= 0 || !(maxBytes > 0)) return [];
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return [];
  }
  try {
    const from = Math.max(0, offset - Math.floor(maxBytes));
    const buf = Buffer.alloc(offset - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    if (n !== buf.length || buf[n - 1] !== 0x0a) return [];
    const lines = buf.subarray(0, n - 1).toString('utf8').split('\n');
    return from > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** sha256 hex of the whole line, as read (no newline). */
export function lineSha(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

export function typedLineStillThere(transcriptPath: string, typed: { offset: number; lineSha: string }): boolean {
  const line = lineAt(transcriptPath, typed.offset);
  return line !== null && lineSha(line) === typed.lineSha;
}

/**
 * The receipt names the host's own transcript for its session (g7, D74), as its host's dialect knows it (4.16):
 * for Claude Code `<projects>/<folder>/<session_id>.jsonl`, for Codex `CODEX_HOME/sessions/.../rollout-*-<session>.jsonl`
 * whose first line names the session, each compared through realpath, so a link to a file elsewhere, a copy in /tmp
 * or another session's file is not it. A host with no dialect can't save live; its receipt can only be held for its
 * host, so it passes as it is, unless it claims tier A.
 */
export function receiptTranscriptOk(r: Receipt, env: NodeJS.ProcessEnv = process.env): boolean {
  const d = dialectFor(r.host);
  if (!d) return r.tier !== 'A';
  return d.transcriptOk(r, env);
}

/**
 * The receipt names the very file the hooks read for its session (g7 review): the session state's cursor keeps the
 * transcript's device and inode, from the path Claude Code itself gave the hooks. The path check above trusts the
 * projects folders, and `$CLAUDE_CONFIG_DIR` comes from the env of `trail skills add`, which is the agent's; a copy
 * under a folder the agent names, or in another project folder, is not the file the hooks read. A hard link to it
 * is (same inode). No cursor (the hooks never read this session): no. Another host's receipt is held anyway: passes.
 */
export function receiptTranscriptRead(r: Receipt, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!dialectFor(r.host)) return r.tier !== 'A';
  const cur = readJsonSafe<{ trace?: { dev?: unknown; ino?: unknown } }>(sessionPath(r.session, '.json', env))?.trace;
  if (!cur || typeof cur.ino !== 'number' || typeof cur.dev !== 'number' || !cur.ino) return false;
  try {
    const st = statSync(realpathSync(r.transcriptPath));
    return st.isFile() && st.ino === cur.ino && st.dev === cur.dev;
  } catch {
    return false;
  }
}
