/**
 * Pure bounded file ranking.
 *
 * Binary IDF coverage supplies a bounded residual to one raw-lexical anchor.
 * Every other real candidate keeps its exact baseline score, and PageRank is
 * never recomputed or amplified by a file-level multiplier.
 */

export interface FileRankCandidate {
  id: string;
  /** Exact repository-relative source path. */
  file: string;
  /** Residual module node, or an exact symbol span. */
  kind: "file" | "symbol";
  /** Existing raw lexical score, before the shared normalization denominator. */
  rawLexical: number;
  /** Existing normalized lexical component, expected in [0, 1]. */
  lexical: number;
  /** Existing normalized PPR component, expected in [0, 1]. */
  graph: number;
  /** Existing query-aware final multiplier (for example test de-ranking). */
  rankFactor: number;
  /** Exact current score, retained for every non-winning candidate. */
  baselineScore: number;
  /** Existing final-list tie key. When present, equal-score candidates keep
   * the caller's baseline ordering before file-specific fallbacks apply. */
  baselineTieKey?: string;
  /** Exact query terms that the existing lexical scorer awarded to this node. */
  matchedTerms: ReadonlySet<string>;
  /** Query terms matched in the symbol NAME field only. File/residual nodes
   * leave this empty so workspace strength gating cannot be cleared by a
   * coincidental filename or body token. */
  matchedStrongTerms?: ReadonlySet<string>;
  /** Only real lexical symbol spans may donate complementary evidence. */
  eligible: boolean;
  /** Deterministic anchor/queue tie-break inputs. */
  emittedTokens?: number;
  spanStart?: number;
}

export type FileRepresentativeReason =
  | "pooled-anchor"
  | "baseline-symbol"
  | "baseline-residual";

export interface RankedFile {
  file: string;
  /** Concrete existing node that owns the returned file score. */
  representative: FileRankCandidate;
  representativeReason: FileRepresentativeReason;
  /** Raw-lexical symbol that alone may receive the bounded residual. */
  lexicalAnchor?: FileRankCandidate;
  /** Existing candidates in deterministic baseline order, representative first. */
  queue: FileRankCandidate[];
  unionCoverage: number;
  unionStrongCoverage: number;
  anchorCoverage: number;
  /** A_F * (U_F - A_F) / U_F. */
  boundedResidual: number;
  pooledLexical: number;
  lexicalDelta: number;
  score: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}

function tokenCost(candidate: FileRankCandidate): number {
  return Number.isFinite(candidate.emittedTokens) && candidate.emittedTokens! >= 0
    ? candidate.emittedTokens!
    : Number.POSITIVE_INFINITY;
}

function startOf(candidate: FileRankCandidate): number {
  return Number.isFinite(candidate.spanStart) && candidate.spanStart! >= 0
    ? candidate.spanStart!
    : Number.POSITIVE_INFINITY;
}

function coverage(
  candidate: FileRankCandidate,
  queryWeights: ReadonlyMap<string, number>,
): number {
  let share = 0;
  for (const term of candidate.matchedTerms) {
    const weight = queryWeights.get(term);
    if (finitePositive(weight ?? 0)) share += weight!;
  }
  return clamp01(share);
}

function baselineOrder(a: FileRankCandidate, b: FileRankCandidate): number {
  const scoreOrder = b.baselineScore - a.baselineScore;
  if (scoreOrder !== 0) return scoreOrder;
  if (a.baselineTieKey !== undefined && b.baselineTieKey !== undefined)
    return a.baselineTieKey.localeCompare(b.baselineTieKey);
  return (
    b.rawLexical - a.rawLexical ||
    tokenCost(a) - tokenCost(b) ||
    startOf(a) - startOf(b) ||
    a.id.localeCompare(b.id)
  );
}

function lexicalAnchorOrder(
  a: FileRankCandidate,
  b: FileRankCandidate,
  queryWeights: ReadonlyMap<string, number>,
): number {
  return (
    b.rawLexical - a.rawLexical ||
    coverage(b, queryWeights) - coverage(a, queryWeights) ||
    tokenCost(a) - tokenCost(b) ||
    startOf(a) - startOf(b) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Rank exact files using the bounded anchor formula:
 *
 *   a_F = argmax rawLexical among eligible lexical symbols
 *   A_F = coverage(a_F)
 *   U_F = union coverage of eligible lexical symbols
 *   r_F = A_F (U_F - A_F) / U_F
 *   P_F = d_a [ell_a + (1 - ell_a) r_F + 0.5 p_a]
 *   S_F = max(P_F, max_j baseline_j)
 *
 * The anchor is the only pooled candidate. Graph-only symbols, residual nodes,
 * and all other lexical symbols remain exact baseline competitors.
 */
export function rankFilesBounded(
  candidates: readonly FileRankCandidate[],
  queryWeights: ReadonlyMap<string, number>,
): RankedFile[] {
  const groups = new Map<string, FileRankCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.file || !finitePositive(candidate.baselineScore)) continue;
    const list = groups.get(candidate.file);
    if (list) list.push(candidate);
    else groups.set(candidate.file, [candidate]);
  }

  const ranked: RankedFile[] = [];
  for (const [file, members] of groups) {
    const donors = members.filter(
      (candidate) =>
        candidate.kind === "symbol" &&
        candidate.eligible &&
        finitePositive(candidate.rawLexical) &&
        finitePositive(candidate.lexical),
    );
    donors.sort((a, b) => lexicalAnchorOrder(a, b, queryWeights));
    const lexicalAnchor = donors[0];

    let unionCoverage = 0;
    let unionStrongCoverage = 0;
    let anchorCoverage = 0;
    let boundedResidual = 0;
    let pooledLexical = lexicalAnchor ? clamp01(lexicalAnchor.lexical) : 0;

    if (lexicalAnchor) {
      const unionTerms = new Set<string>();
      for (const donor of donors)
        for (const term of donor.matchedTerms) unionTerms.add(term);
      for (const term of unionTerms) {
        const weight = queryWeights.get(term);
        if (finitePositive(weight ?? 0)) unionCoverage += weight!;
      }
      unionCoverage = clamp01(unionCoverage);
      const unionStrongTerms = new Set<string>();
      for (const donor of donors)
        for (const term of donor.matchedStrongTerms ?? []) unionStrongTerms.add(term);
      for (const term of unionStrongTerms) {
        const weight = queryWeights.get(term);
        if (finitePositive(weight ?? 0)) unionStrongCoverage += weight!;
      }
      unionStrongCoverage = clamp01(unionStrongCoverage);
      anchorCoverage = coverage(lexicalAnchor, queryWeights);
      boundedResidual = unionCoverage > 0
        ? clamp01(
            anchorCoverage * Math.max(0, unionCoverage - anchorCoverage) /
              unionCoverage,
          )
        : 0;
      pooledLexical = clamp01(
        lexicalAnchor.lexical +
          (1 - clamp01(lexicalAnchor.lexical)) * boundedResidual,
      );
    }

    const lexicalDelta = lexicalAnchor
      ? Math.max(0, pooledLexical - clamp01(lexicalAnchor.lexical))
      : 0;
    const ordered = [...members].sort(baselineOrder);
    const baselineRepresentative = ordered[0]!;
    const pooledAnchorScore = lexicalAnchor
      ? clamp01(lexicalAnchor.rankFactor) *
        (pooledLexical + 0.5 * clamp01(lexicalAnchor.graph))
      : 0;

    const pooledWins = Boolean(
      lexicalAnchor && pooledAnchorScore > baselineRepresentative.baselineScore,
    );
    const representative = pooledWins ? lexicalAnchor! : baselineRepresentative;
    const score = pooledWins ? pooledAnchorScore : baselineRepresentative.baselineScore;
    const representativeReason: FileRepresentativeReason = pooledWins
      ? "pooled-anchor"
      : representative.kind === "file"
        ? "baseline-residual"
        : "baseline-symbol";
    const queue = [
      representative,
      ...ordered.filter((candidate) => candidate.id !== representative.id),
    ];

    ranked.push({
      file,
      representative,
      representativeReason,
      lexicalAnchor,
      queue,
      unionCoverage,
      unionStrongCoverage,
      anchorCoverage,
      boundedResidual,
      pooledLexical,
      lexicalDelta,
      score,
    });
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      baselineOrder(a.representative, b.representative) ||
      a.file.localeCompare(b.file),
  );
  return ranked;
}
