/**
 * Attach a brain's rules to an `ask` answer.
 *
 * The join is the symbol: a rule is mined against a graft node id, and an
 * answer is a set of hits that point at spans. Resolving the hits back to node
 * ids gives the rules that govern exactly what the agent is about to read.
 *
 * Staleness is decided HERE, on the machine that has the code: the rule carries
 * the symbol's body hash from when it was mined, and the local graph carries
 * the hash now. A mismatch means the code moved out from under the rule, which
 * is worth saying rather than hiding — a rule that describes code that no
 * longer exists is the failure mode this whole mechanism exists to catch.
 */
import type { GraphV1 } from '../graph/types.js';
import type { BrainRule } from './link.js';

/** One rule, resolved against the current graph. */
export interface AppliedRule {
  rule: string;
  /** The symbol it governs, as a `path:span` pointer the agent can open. */
  pointer: string;
  /** True when the symbol's body hash no longer matches what the rule was mined at. */
  stale: boolean;
  sourceUrl?: string;
}

/** Most rules to attach to one answer. */
export const MAX_ATTACHED_RULES = 6;

/**
 * The rules governing the symbols in `pointers`, resolved against `graph`.
 *
 * Scoped to the answer, not the repo: attaching every rule a brain holds would
 * turn a token-saving pack into a token-spending one, and `ask` prints the
 * saving it claims. Capped for the same reason.
 */
export function rulesForPointers(
  pointers: string[],
  rules: BrainRule[],
  graph: GraphV1 | null,
): AppliedRule[] {
  if (!rules.length || !graph) return [];

  // node id → its current pointer and body hash. One pass over the graph; the
  // caller does this once per ask, not once per hit.
  const byId = new Map<string, { pointer: string; hash: string }>();
  for (const n of graph.nodes) {
    byId.set(n.id, { pointer: `${n.path}:${n.span}`, hash: n.body_hash });
  }

  const wanted = new Set(pointers);
  const out: AppliedRule[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    const node = byId.get(r.symbol);
    if (!node || !wanted.has(node.pointer)) continue;
    // The same rule can be mined against two symbols in one answer; show it once.
    if (seen.has(r.rule)) continue;
    seen.add(r.rule);
    out.push({
      rule: r.rule,
      pointer: node.pointer,
      // No recorded fingerprint means the rule was mined before hashing existed
      // (or against a symbol graft could not hash). Unknown is not stale: a
      // false "the code moved" is worse than saying nothing about freshness.
      stale: r.fingerprint !== '' && r.fingerprint !== node.hash,
      sourceUrl: r.sourceUrl,
    });
    if (out.length === MAX_ATTACHED_RULES) break;
  }
  return out;
}

/**
 * Render the rules block appended to an `ask` pack.
 *
 * Deliberately terse. This rides along on every answer, so it has to earn its
 * tokens: one line per rule, the pointer it governs, and a link only when there
 * is one. The `[graft]` prefix is avoided — `sumSavingsFooters` scans for
 * `[graft] tokens saved ≈` and nothing here should look like a savings line.
 */
export function formatRules(applied: AppliedRule[]): string[] {
  if (!applied.length) return [];
  const lines = ['', 'rules that govern these symbols'];
  for (const a of applied) {
    const flag = a.stale ? ' (STALE — the code changed since this was decided)' : '';
    lines.push(`- ${a.rule}${flag}`);
    lines.push(`  ${a.pointer}${a.sourceUrl ? ` · ${a.sourceUrl}` : ''}`);
  }
  return lines;
}
