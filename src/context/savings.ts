/**
 * Shared file-read-size estimate for retrieval-style graft commands.
 *
 * This is a rough whole-file-size baseline: the `chars` the build stored on
 * each selected file node. It is useful as an estimated file-read token
 * equivalent, not as a measurement of tokens actually read, avoided, or billed.
 * When no file in the baseline has a known size (a pre-`chars` graph), the
 * estimate is omitted rather than faked.
 *
 * This is structured estimate data only. It is intentionally not rendered as a
 * token-savings claim: the calculation compares whole file sizes with output
 * length and does not measure tokens actually read or billed.
 */
import type { GraphV1 } from '../graph/types.js';

export interface Savings {
  /** How many source files the rough baseline covers. */
  files: number;
  /** Total chars of those files — their whole-file-size baseline. */
  baselineChars: number;
}
/** Rough token equivalent for a character length (≈ 4 chars/token). */
export function toTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** path → char size, from the file nodes the build sized. Skips nodes with no
 * `chars` (pre-upgrade graphs), so an old index just yields a smaller baseline
 * rather than a wrong one. */
function fileSizes(graph: GraphV1): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of graph.nodes)
    if (n.kind === 'file' && typeof n.chars === 'number') m.set(n.path, n.chars);
  return m;
}

/** Whole-file-size baseline for distinct `paths`, summed from file-node sizes.
 * Returns undefined when not a single path has a known size. */
export function savingsFor(graph: GraphV1, paths: Iterable<string>): Savings | undefined {
  const sizes = fileSizes(graph);
  let baselineChars = 0;
  let files = 0;
  for (const p of new Set(paths)) {
    const c = sizes.get(p);
    if (c === undefined) continue;
    baselineChars += c;
    files++;
  }
  return files > 0 ? { files, baselineChars } : undefined;
}

