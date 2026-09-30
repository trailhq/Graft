/** Pricing helpers for sampled host-reported input usage. They support internal
 * billing observations only; they do not price the file-size baseline. */

/** Input $/Mtok, list price, per model family. */
const INPUT_USD_PER_MTOK: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude-(fable|mythos)-5/, 10],
  [/^claude-opus-(5|4-[678])/, 5],
  [/^claude-sonnet-5/, 2],
  [/^claude-sonnet-4-6/, 3],
  [/^claude-haiku-4-5/, 1],
];

/** List input price for a model id, or null when we do not know it. */
export function inputUsdPerMtok(model: unknown): number | null {
  if (typeof model !== 'string') return null;
  for (const [pattern, usd] of INPUT_USD_PER_MTOK) if (pattern.test(model)) return usd;
  return null;
}

/** One turn's input-token usage, as the host's transcript reports it. */
export interface TurnUsage {
  model: string;
  /** Fresh tokens, billed at the list rate. */
  input: number;
  /** Written to the cache this turn — a 25% premium over list. */
  cacheCreate: number;
  /** Served from cache — a tenth of list, and usually the bulk of a long turn. */
  cacheRead: number;
}

/** Cache-write costs 1.25x list, a cache read a tenth of it. The multipliers are
 * why a measured rate beats an assumed one: a session deep into a long
 * conversation pays nearer $0.50/Mtok than the $5.00 its model lists at. */
const CACHE_CREATE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Micro-dollars, so a running total stays an integer and never drifts. */
const MICROS_PER_USD = 1_000_000;

/** What this turn's input tokens cost, in micro-dollars, or null on a model we
 * have no price for. */
export function turnInputCostMicros(usage: TurnUsage): number | null {
  const list = inputUsdPerMtok(usage.model);
  if (list === null) return null;
  const weighted =
    usage.input +
    usage.cacheCreate * CACHE_CREATE_MULTIPLIER +
    usage.cacheRead * CACHE_READ_MULTIPLIER;
  return Math.round((weighted * list * MICROS_PER_USD) / 1_000_000);
}

/** Every input token this turn was billed for, cached or not — the denominator
 * of the blended rate. */
export function turnInputTokens(usage: TurnUsage): number {
  return usage.input + usage.cacheCreate + usage.cacheRead;
}

