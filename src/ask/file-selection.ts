/** One already-ranked result and the file/partition whose output queue owns it. */
export interface FileFirstCandidate<T> {
  group: string;
  value: T;
}

/**
 * Project an existing ranking through file-first round-robin selection.
 *
 * The input MUST already be in baseline rank order. Map insertion order makes
 * the first pass exactly the baseline first-occurrence order of groups; later
 * passes expose additional spans only after every group has contributed its
 * leader. Concepts can participate without pretending to be source files by
 * receiving singleton group keys.
 *
 * Values are returned by identity and are never mutated.
 */
export function fileFirstRoundRobin<T>(
  ranked: readonly FileFirstCandidate<T>[],
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  if (cap === 0) return [];

  const grouped = new Map<string, T[]>();
  for (const candidate of ranked) {
    const queue = grouped.get(candidate.group);
    if (queue) queue.push(candidate.value);
    else grouped.set(candidate.group, [candidate.value]);
  }

  const queues = [...grouped.values()];
  const out: T[] = [];
  for (let depth = 0; ; depth += 1) {
    let added = false;
    for (const queue of queues) {
      if (depth >= queue.length) continue;
      out.push(queue[depth]);
      added = true;
      if (out.length >= cap) return out;
    }
    if (!added) break;
  }
  return out;
}

/** Project already-grouped queues directly. Unlike {@link fileFirstRoundRobin}
 * this does not flatten and rebuild a grouping map, so a file-aware ranker can
 * stop as soon as `limit` hits without materializing every tail span twice. */
export function roundRobinQueues<T>(
  queues: readonly (readonly T[])[],
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const cap = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : Number.POSITIVE_INFINITY;
  if (cap === 0) return [];

  const out: T[] = [];
  for (let depth = 0; out.length < cap; depth += 1) {
    let added = false;
    for (const queue of queues) {
      if (depth >= queue.length) continue;
      out.push(queue[depth]);
      added = true;
      if (out.length >= cap) break;
    }
    if (!added) break;
  }
  return out;
}
