/**
 * Phase 0's init review, as 1b leaves it (design 0.1): the v2 record
 * (init-record.ts), the screen and relay (review-screen.ts, review-tty.ts)
 * and the keep (keep.ts) replaced its pending list, picker and
 * `trail keep`. Phase 0's quotes on disk are gone with it (P4, B3).
 */
export { KEEP_LINE, RELAY_LINE } from "./relay.js";

/** Where a phase 0 item went, in words (kept for its callers; 1b's items use review-screen.ts scopeWords). */
export function scopeWords(item: { scope: "personal" | "repo" }): string {
  return item.scope === "personal" ? "just for you, in this repo" : "added to this repo";
}
