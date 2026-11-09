/**
 * Context epochs: the stretches of a session the agent saw whole. One starts
 * at the session's start and another at every compaction, after which the
 * agent knows the earlier stretch only from a summary. Runs, repairs and
 * skill use are counted per epoch.
 */
import type { TraceEvent } from "./claude.js";

/** `events` cut at each compaction, which opens the epoch it starts. Empty epochs are left out. */
export function splitEpochs(events: TraceEvent[]): TraceEvent[][] {
  const out: TraceEvent[][] = [];
  let current: TraceEvent[] = [];
  for (const e of events) {
    if (e.kind === "compaction" && current.length) {
      out.push(current);
      current = [];
    }
    current.push(e);
  }
  if (current.length) out.push(current);
  return out;
}
