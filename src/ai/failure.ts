/**
 * When to stop calling a provider that is failing (#127).
 *
 * Both LLM passes of `build --deep` — the per-file concept summaries
 * (`context/build.ts`) and the per-file crux pass (`graph/enrich.ts`) — used to
 * catch every error per file, keep going, and finish with a clean exit. On an
 * 884-file repo behind a gateway whose token quota was spent that produced 1,617
 * failed calls, a normal success footer, and a graph whose meaning tier was
 * missing; the degradation surfaced days later as bad `ask` results.
 *
 * One gate, shared by both passes, so they agree on what "the provider stopped
 * working" means and a caller can report it once.
 *
 * Content-quality misses (empty/unusable crux, #235) still count as failed files
 * so they are not cached as success (#177), but they do not increment the
 * consecutive-failure cutoff — the provider is answering, just not usefully for
 * those files. Quota/auth stay immediately terminal (#127).
 */

/** Consecutive failures that end a pass. One flaky file is normal; five in a row is
 * a provider that is not going to start working, and each further call is spend
 * with no chance of a result. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Errors no amount of retrying fixes: the key is wrong, or the account/quota is
 * spent. Matched on the message because that is all a provider-neutral transport
 * carries — over-matching costs a build that was going to fail anyway, while
 * under-matching just falls back to the consecutive-failure cutoff.
 */
export function terminalReason(message: string): string | null {
  const m = message.toLowerCase();
  if (/quota|insufficient[_ ]funds|insufficient[_ ]quota|billing|payment required|402/.test(m)) {
    return "the provider reports the quota/credit for this key is exhausted";
  }
  if (/\b401\b|\b403\b|unauthorized|invalid api key|invalid_api_key|authentication/.test(m)) {
    return "the provider rejected the API key";
  }
  return null;
}

/**
 * Failure bookkeeping for one LLM pass: how many units failed, how many were
 * skipped once it gave up, and the human-readable reason it did.
 *
 * Single-threaded by construction — every mutation happens between awaits in the
 * pass's own worker — so no locking is needed despite the concurrency above it.
 */
export class LlmFailureGate {
  /** Units (files) whose call failed. */
  failed = 0;
  /** Units never attempted because the pass had already given up. */
  skipped = 0;
  /** Why the pass stopped, when it did. */
  fatal?: string;
  private consecutive = 0;

  /** True once the pass should stop issuing calls. */
  get stopped(): boolean {
    return this.fatal !== undefined;
  }

  /**
   * Record a failed unit; sets {@link fatal} when this failure is the last straw.
   * Pass `{ quality: true }` for a content-quality miss (#235): counted, not fatal,
   * unless the message is quota/auth (those still stop immediately).
   */
  record(message: string, opts?: { quality?: boolean }): void {
    this.failed++;
    const terminal = terminalReason(message);
    if (terminal) {
      this.fatal = `${terminal} — stopped after ${this.failed} failed file(s). First error: ${message}`;
      return;
    }
    if (opts?.quality) return;
    this.consecutive++;
    if (this.consecutive >= MAX_CONSECUTIVE_FAILURES) {
      this.fatal = `${this.consecutive} files in a row failed, so the pass stopped rather than keep calling. Last error: ${message}`;
    }
  }

  /** Record a success — a failure run only counts while it is unbroken. */
  succeeded(): void {
    this.consecutive = 0;
  }

  /** Record a unit that was not attempted because the pass had stopped. */
  skip(): void {
    this.skipped++;
  }
}
