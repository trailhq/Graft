/** Transcript helpers for sampled input billing. */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { turnInputCostMicros, turnInputTokens } from '../context/price.js';

/**
 * How much of the transcript's end to read. Comfortably larger than any single
 * turn's worth of entries, small enough that the read cost is flat as the
 * session grows.
 */
const TAIL_BYTES = 1024 * 1024;

/** What the last turn's input tokens cost, alongside how many there were. The
 * pair is what a blended rate is made of; neither half means much alone. */
export interface TurnBilling {
  /** `uuid` of the last assistant entry, so a repeated Stop can't bill a turn twice. */
  uuid: string;
  /** Micro-dollars this turn's input tokens cost, cache multipliers applied. */
  costMicros: number;
  /** Input tokens billed this turn, cached and fresh alike. */
  tokens: number;
}

/** Read the last {@link TAIL_BYTES} of a file as utf8, dropping the leading
 * partial line a byte-offset read leaves behind. Returns '' on any I/O trouble —
 * a hook never fails over a metric. */
function readTail(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, size - len);
    const raw = buf.toString('utf8');
    return len < size ? raw.slice(raw.indexOf('\n') + 1) : raw;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** Is this entry a user's own prompt, rather than a tool result wearing the
 * `user` role? Tool results carry a `tool_result` part; a real prompt does not. */
function isUserPrompt(entry: any): boolean {
  if (entry?.type !== 'user' || entry?.isMeta) return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && !content.some((p: any) => p?.type === 'tool_result');
}

/**
 * What the turn the transcript ends on cost in input tokens.
 *
 * Costed per API response, not per turn, so a turn that switched models is
 * priced correctly rather than labelled with whichever model happened to go
 * last. Responses are deduped by `message.id`: one response is written to the
 * transcript as several entries (a `thinking` block and a `tool_use` block land
 * on their own lines) and every one of them repeats the same `usage`, so
 * summing the lines would bill the turn two or three times over.
 *
 * Null when there is nothing to bill — no transcript path (a host whose Stop
 * hook names none), an unreadable file, a turn whose entries carry no `usage`,
 * or a model with no price in {@link inputUsdPerMtok}. As everywhere in this
 * file, null means "not observed", never "zero".
 */
export function lastTurnBilling(transcriptPath: unknown): TurnBilling | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const tail = readTail(transcriptPath);
  if (!tail) return null;

  const entries: any[] = [];
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* clipped or partial line */ }
  }

  const seen = new Set<string>();
  let uuid: string | null = null;
  let costMicros = 0;
  let tokens = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.isSidechain) continue;
    if (isUserPrompt(e)) break;
    if (e?.type !== 'assistant') continue;
    if (uuid === null && typeof e?.uuid === 'string') uuid = e.uuid;
    const msg = e?.message;
    const id = msg?.id;
    if (typeof id !== 'string' || seen.has(id)) continue;
    const usage = msg?.usage;
    if (!usage) continue;
    seen.add(id);
    const turn = {
      model: String(msg?.model ?? ''),
      input: Number(usage.input_tokens) || 0,
      cacheCreate: Number(usage.cache_creation_input_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
    };
    const micros = turnInputCostMicros(turn);
    // An unpriced model contributes neither cost nor tokens: leaving its tokens
    // in the denominator alone would distort the blended rate.
    if (micros === null) continue;
    costMicros += micros;
    tokens += turnInputTokens(turn);
  }
  if (uuid === null || tokens === 0) return null;
  return { uuid, costMicros, tokens };
}
