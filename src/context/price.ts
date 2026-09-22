/**
 * What a saved token was actually worth, in dollars.
 *
 * `savings.ts` answers "how many input tokens did graft keep out of the
 * context"; this answers "what does an input token cost here". The two are
 * deliberately separate: the token count is arithmetic over file sizes and is
 * true everywhere, while the price depends on which model the session ran and
 * how much of its context was served from cache — facts only the host's
 * transcript knows.
 *
 * Nothing here guesses. There is no default rate and no env override: a model
 * we don't have a price for yields null, and the callers then render the token
 * count alone rather than a dollar figure we made up. A wrong number on the
 * statusline is worse than no number.
 */

/** Input $/Mtok, list price, per model family. Output tokens are irrelevant —
 * what graft saves is context the agent would otherwise have read IN. */
const INPUT_USD_PER_MTOK: ReadonlyArray<readonly [RegExp, number]> = [
  [/^claude-(fable|mythos)-5/, 10],
  [/^claude-opus-(5|4-[678])/, 5],
  [/^claude-sonnet-5/, 2],
  [/^claude-sonnet-4-6/, 3],
  [/^claude-haiku-4-5/, 1],
];

/** List input price for a model id, or null when we don't know it — a model
 * released after this table was written, or a host reporting something else
 * entirely. Null propagates all the way to "render tokens only". */
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

/**
 * Dollars saved, at the rate the session has actually been paying.
 *
 * `costMicros / tokensBilled` is the blended price of one input token here —
 * model and cache-hit ratio already folded in — so this re-blends as the
 * session goes rather than freezing turn one's rate. Returns null when nothing
 * has been sampled yet (turn one, or a host whose hooks name no transcript).
 */
export function dollarsSaved(
  savedTokens: number,
  costMicros: number | undefined,
  tokensBilled: number | undefined,
): number | null {
  if (!costMicros || !tokensBilled || savedTokens <= 0) return null;
  const usd = (savedTokens * (costMicros / tokensBilled)) / MICROS_PER_USD;
  // Belt and braces against a non-finite accumulator reaching a rendered
  // surface: "$NaN" on the statusline is worse than no dollar figure at all.
  return Number.isFinite(usd) ? usd : null;
}

/** `$1.23`, or `<$0.01` for a real but sub-cent saving. Never `$0.00`: a
 * rounded-to-nothing number reads as "graft saved you nothing", which is a
 * different claim from "graft saved you less than a cent". */
export function formatDollars(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
