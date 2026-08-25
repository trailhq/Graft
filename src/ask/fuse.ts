/**
 * Scope-aware ranking for `graft ask`. Pure functions, no fs.
 *
 * The problem: lexical + graph scores are corpus-relative. In a multi-scope
 * repo (a monorepo's `frontend/` + `backend/`, sub-projects under one root),
 * scoring every node against one pooled corpus lets the biggest sub-project set
 * the score scale and drown the small one.
 *
 * This module solves it by keeping the scope PARTITION — each scope is scored
 * and walked separately — while making the resulting scores COMPARABLE, so the
 * combined order can be read straight off the score. Comparability has two
 * requirements, and both must hold or the order is meaningless:
 *
 *   1. shared corpus statistics — the caller scores every scope against the
 *      repo-wide IDF and length prior (see `ask.ts`), so the same term is worth
 *      the same everywhere;
 *   2. a shared normalization denominator — {@link rankScopesAndFuse} divides
 *      every scope by the best raw score in the REPO, not by each scope's own
 *      best (see `globalMaxLex` there).
 *
 * Issue #117 was the consequence of neither holding. Each scope divided by its
 * own maximum, so a barely-relevant scope's top hit normalized to ~1.0 exactly
 * like the genuinely relevant scope's top hit; RRF then fused by RANK, which
 * discards magnitude outright, so the weak scope's rank-1 tied the strong
 * scope's rank-1 and displaced its rank-2 — frequently the answer. Measurement
 * across four repositories and four ecosystems put 73% of missed files in that
 * bucket. RRF is retained for `federateAsk` (see `graph/workspace.ts`), where
 * the corpora really are separate repositories and no shared denominator
 * exists — that is the case rank fusion is for.
 *
 * Soft federation: a scope whose top hit is probably an incidental word
 * collision, not a second home for the query, is left out of the combined order
 * and reported in `alsoMatched` instead, so the output can say "also matched:
 * docs/ — narrow with --in docs/" rather than diluting the pack. With
 * comparable scores that gate is simply {@link PARTICIPATION_RATIO} — a scope
 * must reach a real share of the best score anywhere in the repo. Under
 * per-scope normalization that check was vacuous (every scope's top was ~1.0),
 * which is why a separate match-STRENGTH gate ({@link STRONG_FLOOR}/{@link
 * HIGH_FLOOR}) had to stand in for it; that signal is still exported and still
 * used by `federateAsk`, which normalizes per child repo and therefore still
 * needs it.
 */

/** One scored document, attributed to the ranking scope (path prefix, "" =
 * root) it was scored within. Scores must be per-scope-normalized (each
 * scope's best ≈ its own ceiling) — fusion compares ranks, not raw scores. */
export interface ScopedDoc {
  id: string;
  scope: string;
  score: number;
}

export interface FusionResult {
  /** fused order, best first; carries per-doc scope label + fused score.
   * Normalized so the top MULTI-scope fused doc is 1 — but the single-scoring-
   * scope degenerate case passes ORIGINAL (pre-fusion) scores through
   * unchanged, and those are not guaranteed to fall in [0,1]. */
  ranked: { id: string; scope: string; score: number }[];
  /** scopes that participated in fusion */
  federated: string[];
  /** scopes that matched weakly (≥1 scoring doc but below the participation gate) with their best doc */
  alsoMatched: { scope: string; bestId: string }[];
}

/** RRF smoothing constant — the standard value from the original RRF paper;
 * high enough that rank 1 vs 2 differ gently rather than by 2×. */
export const RRF_K = 60;

/** A scope federates only when its best doc scores at least this share of the
 * global best — below it the match is reported, not fused. Used by
 * `fuseScopes`'s own internal gate (a post-normalization safety net once a
 * caller has already applied the real match-strength gate — see
 * {@link STRONG_FLOOR}/{@link HIGH_FLOOR}). */
export const PARTICIPATION_RATIO = 0.25;

/** The single source of truth for the cross-scope participation gate shared
 * by `rankScopesAndFuse` (single-graph multi-scope) and `federateAsk`
 * (workspace federation, `src/graph/workspace.ts`) — the two paths that solve
 * the identical "a weak scope must not federate beside a strong one" problem.
 * They MUST use the same floors so they can never drift into inconsistent
 * behavior again.
 *
 * A scope federates iff its top hit matched a query term in a NAME/PATH field
 * at all (any strength ≥ `STRONG_FLOOR`) — the primary gate. Well below every
 * genuine fixture (≥0.45) yet strictly above a body-only collision's 0, so a
 * real partial-relevance hit on a common/low-idf term is never overcorrected
 * out. */
export const STRONG_FLOOR = 0.1;
/** …OR the overall (name+path+body) coverage is broad enough to be real even
 * body-only. A single incidental body-token collision measures ~0.29 and RISES
 * with corpus size (0.30+ at 200 nodes) but never approaches this, while a
 * genuinely broad match clears it. This is why the gate is on absolute,
 * scale-invariant floors, NOT a raw-lexical-score ratio (which — calibrated for
 * raw-lexical-SCORE space — was far too lenient in coverage/matched-fraction
 * space and leaked junk, worsening as the corpus grew). */
export const HIGH_FLOOR = 0.5;

/** Score-desc, id-asc ordering — the id tiebreak is what makes fusion
 * deterministic under input shuffle. */
function byScore(a: ScopedDoc, b: ScopedDoc): number {
  return b.score - a.score || a.id.localeCompare(b.id);
}

/**
 * Partition by scope, rank within scope (input scores are already
 * per-scope-normalized), gate by soft federation, fuse by RRF:
 * `fused(id) = Σ 1/(K + rank_in_scope(id))`, then normalized so the top fused
 * doc is 1. Non-scoring docs (score ≤ 0) are dropped entirely.
 *
 * Degenerate cases degrade to current behavior: zero scoring docs → empty
 * result; exactly one scoring scope → its docs pass through in score order
 * with their ORIGINAL scores (no RRF re-scoring, no gate) — byte-for-byte the
 * single-corpus ranking the caller would have produced anyway.
 */
export function fuseScopes(docs: ScopedDoc[]): FusionResult {
  const byScope = new Map<string, ScopedDoc[]>();
  for (const d of docs) {
    if (d.score <= 0) continue;
    const list = byScope.get(d.scope);
    if (list) list.push(d);
    else byScope.set(d.scope, [d]);
  }
  for (const list of byScope.values()) list.sort(byScore);

  if (byScope.size === 0) return { ranked: [], federated: [], alsoMatched: [] };
  if (byScope.size === 1) {
    const [scope, list] = byScope.entries().next().value as [string, ScopedDoc[]];
    return {
      ranked: list.map((d) => ({ id: d.id, scope, score: d.score })),
      federated: [scope],
      alsoMatched: [],
    };
  }

  // Gate: order scopes by their best doc (desc, scope-name tiebreak), split
  // into federated (≥ ratio × global best, inclusive) and alsoMatched.
  const scopesByBest = [...byScope.entries()].sort(
    (a, b) => b[1][0].score - a[1][0].score || a[0].localeCompare(b[0]),
  );
  const gate = PARTICIPATION_RATIO * scopesByBest[0][1][0].score;
  const federated: string[] = [];
  const alsoMatched: FusionResult["alsoMatched"] = [];
  for (const [scope, list] of scopesByBest) {
    if (list[0].score >= gate) federated.push(scope);
    else alsoMatched.push({ scope, bestId: list[0].id });
  }

  // RRF: each federated scope contributes 1/(K + rank) per doc; an id listed
  // in more than one scope sums its contributions and is attributed to the
  // scope where it ranked best.
  const acc = new Map<string, { scope: string; score: number; bestRank: number }>();
  for (const scope of federated) {
    byScope.get(scope)!.forEach((d, i) => {
      const contribution = 1 / (RRF_K + i + 1);
      const prev = acc.get(d.id);
      if (!prev) acc.set(d.id, { scope, score: contribution, bestRank: i });
      else {
        prev.score += contribution;
        if (i < prev.bestRank) {
          prev.scope = scope;
          prev.bestRank = i;
        }
      }
    });
  }

  let max = 0;
  for (const e of acc.values()) if (e.score > max) max = e.score;
  const ranked = [...acc.entries()].map(([id, e]) => ({
    id,
    scope: e.scope,
    score: e.score / max,
  }));
  ranked.sort(
    (a, b) => b.score - a.score || a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id),
  );
  return { ranked, federated, alsoMatched };
}

/**
 * Combine scopes whose scores are ALREADY comparable (shared corpus statistics
 * and a shared normalization denominator — see the module header). Same shape
 * and same gate as {@link fuseScopes}, but the combined order is read straight
 * off the score instead of from reciprocal rank, because with a common scale
 * the magnitude is exactly the signal rank fusion would throw away.
 *
 * Only {@link rankScopesAndFuse} may call this. `federateAsk` fuses separate
 * repositories, which have no common denominator, and must keep using
 * {@link fuseScopes}.
 */
export function combineComparableScopes(docs: ScopedDoc[]): FusionResult {
  const byScope = new Map<string, ScopedDoc[]>();
  for (const d of docs) {
    if (d.score <= 0) continue;
    const list = byScope.get(d.scope);
    if (list) list.push(d);
    else byScope.set(d.scope, [d]);
  }
  for (const list of byScope.values()) list.sort(byScore);

  if (byScope.size === 0) return { ranked: [], federated: [], alsoMatched: [] };
  // One scoring scope: pass through untouched. Identical to the single-scope
  // path by construction — the guarantee that a single-scope repo cannot move.
  if (byScope.size === 1) {
    const [scope, list] = byScope.entries().next().value as [string, ScopedDoc[]];
    return {
      ranked: list.map((d) => ({ id: d.id, scope, score: d.score })),
      federated: [scope],
      alsoMatched: [],
    };
  }

  // Gate on a real share of the best score in the repo. This is the same
  // ratio check `fuseScopes` runs, but here it MEANS something: the scores
  // being compared share a denominator.
  const scopesByBest = [...byScope.entries()].sort(
    (a, b) => b[1][0].score - a[1][0].score || a[0].localeCompare(b[0]),
  );
  const gate = PARTICIPATION_RATIO * scopesByBest[0][1][0].score;
  const federated: string[] = [];
  const alsoMatched: FusionResult["alsoMatched"] = [];
  for (const [scope, list] of scopesByBest) {
    if (list[0].score >= gate) federated.push(scope);
    else alsoMatched.push({ scope, bestId: list[0].id });
  }

  // An id can only belong to one scope (scope is a path prefix), but keep the
  // defensive max so a duplicate cannot double-count or flip its attribution.
  const acc = new Map<string, { scope: string; score: number }>();
  for (const scope of federated) {
    for (const d of byScope.get(scope)!) {
      const prev = acc.get(d.id);
      if (!prev || d.score > prev.score) acc.set(d.id, { scope, score: d.score });
    }
  }

  let max = 0;
  for (const e of acc.values()) if (e.score > max) max = e.score;
  const ranked = [...acc.entries()].map(([id, e]) => ({
    id,
    scope: e.scope,
    score: max > 0 ? e.score / max : 0,
  }));
  ranked.sort(
    (a, b) => b.score - a.score || a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id),
  );
  return { ranked, federated, alsoMatched };
}

/** The per-scope scoring hooks `rankScopesAndFuse` drives — the caller owns
 * the actual lexical math and graph walk (they need its corpus state); this
 * module owns the orchestration so the shape of "rank per scope, then fuse"
 * lives in one place. */
export interface ScopeRankOps {
  /** Lexical scores for the scope's own docs (positive entries only), computed
   * against the REPO-WIDE corpus statistics. Per-scope statistics would make
   * the returned numbers incomparable between scopes, which is exactly the
   * defect in #117 — see the module header. */
  lex(scope: string): Map<string, number>;
  /** Does ANY scoring doc in this scope match a query term in its NAME or PATH?
   *
   * Serves ONE narrow purpose: suppressing a scope whose entire claim on the
   * query is prose. Score cannot catch that on its own — BM25 rewards a term
   * repeated in comments, so a file mentioning "gateway" thirty times in a
   * banner can outscore the class actually named `GatewayTimeout`.
   *
   * Deliberately evaluated over the whole scope, not just its top hit, and as a
   * presence check rather than a share threshold. Both choices are load-bearing:
   * a share of the whole query is unreachable for long queries (which is how the
   * old gate ended up admitting one scope and hiding the rest), and judging a
   * scope by its single best doc suppressed any scope whose top hit was a file
   * node — measured at 7.6 points of pooled R@10. */
  hasIdentifierMatch?(scope: string): boolean;
  /** Graph walk restricted to the scope's subgraph, seeded by that scope's
   * lexical scores; returns top-normalized centrality (or an empty map). */
  walk(scope: string, seeds: Map<string, number>): Map<string, number>;
  /** Optional query-aware multiplier applied after lexical normalization and
   * graph blending. Use this for priors (such as test-file de-ranking) that
   * normalization must not erase. */
  rankFactor?(scope: string, id: string): number;
}

/**
 * Multi-scope orchestration for `ask`'s symbol ranking: for each scope, score
 * lexically (against the repo-wide statistics the caller supplies), walk the
 * scope's subgraph, blend exactly like the single-scope path (`lexN +
 * graphWeight·pr`, walk-rescued nodes joining above `rescueFloor`), then
 * combine the scopes with {@link combineComparableScopes}. A scope with zero
 * lexical matches contributes nothing (no seeds → no walk → no docs).
 *
 * The one thing that differs from the single-scope path: `lexN` divides by
 * `globalMaxLex`, the best raw lexical score across ALL scopes, rather than by
 * each scope's own best. That shared denominator is what makes the blended
 * scores comparable, and therefore what lets the combined order be read off the
 * score. Dividing per scope — as this did before #117 — pinned every scope's
 * top hit to ~1.0 regardless of how well it matched, which is the defect.
 *
 * Participation is then the {@link PARTICIPATION_RATIO} share check inside
 * {@link combineComparableScopes}: a scope must reach a real fraction of the
 * best score anywhere in the repo, else it is reported in `alsoMatched` for
 * `--in`. The match-STRENGTH floors ({@link STRONG_FLOOR}/{@link HIGH_FLOOR})
 * are no longer applied here — they existed to stand in for a share check that
 * per-scope normalization had made vacuous. `federateAsk` still normalizes per
 * child repo, so it still gates on strength; see `src/graph/workspace.ts`.
 */
export function rankScopesAndFuse(
  scopes: string[],
  ops: ScopeRankOps,
  graphWeight: number,
  rescueFloor: number,
): FusionResult {
  // Pass 1: lexical scoring only, per scope.
  const lexByScope = new Map<string, Map<string, number>>();
  for (const scope of scopes) {
    const lex = ops.lex(scope);
    if (lex.size === 0) continue;
    lexByScope.set(scope, lex);
  }

  const alsoMatched: FusionResult["alsoMatched"] = [];
  const scoped: ScopedDoc[] = [];

  // Per-scope raw best, plus the best raw score anywhere in the repo. That
  // repo-wide maximum is the shared denominator every scope normalizes by.
  const meta = new Map<string, { lex: Map<string, number>; maxLex: number; bestId: string }>();
  let globalMaxLex = 0;
  for (const [scope, lex] of lexByScope) {
    let maxLex = 0, bestId = "";
    for (const [id, v] of lex) if (v > maxLex || (v === maxLex && id < bestId)) { maxLex = v; bestId = id; }
    if (maxLex <= 0) continue;
    meta.set(scope, { lex, maxLex, bestId });
    if (maxLex > globalMaxLex) globalMaxLex = maxLex;
  }

  // Body-only suppression. With a shared denominator a weak scope simply
  // scores low, so participation is decided on score in
  // `combineComparableScopes` — no scope is excluded on a share threshold any
  // more. The single exception is a scope in which NO doc matched a query term
  // in a name or path while some other scope did: that is the comment-banner
  // collision (see `hasIdentifierMatch` above), and score cannot separate it
  // from a real match. Only applied when a genuine identifier match exists
  // somewhere, so a query that legitimately matches only prose still returns
  // something.
  const bodyOnly = new Set<string>();
  if (ops.hasIdentifierMatch) {
    const named = new Map<string, boolean>();
    for (const scope of meta.keys()) named.set(scope, ops.hasIdentifierMatch(scope));
    if ([...named.values()].some(Boolean)) {
      for (const [scope, ok] of named) if (!ok) bodyOnly.add(scope);
    }
  }
  for (const scope of bodyOnly) {
    alsoMatched.push({ scope, bestId: meta.get(scope)!.bestId });
    meta.delete(scope);
  }
  // The denominator must come from the scopes that actually rank, or a
  // suppressed scope could still set the scale for everyone else.
  globalMaxLex = 0;
  for (const { maxLex } of meta.values()) if (maxLex > globalMaxLex) globalMaxLex = maxLex;

  for (const [scope, { lex }] of meta) {
    const pr = ops.walk(scope, lex);
    const candidates = new Set(lex.keys());
    for (const [id, p] of pr) if (p >= rescueFloor) candidates.add(id);
    for (const id of candidates) {
      const lexN = globalMaxLex > 0 ? (lex.get(id) ?? 0) / globalMaxLex : 0;
      const blended = (lexN + graphWeight * (pr.get(id) ?? 0)) * (ops.rankFactor?.(scope, id) ?? 1);
      if (blended > 0) scoped.push({ id, scope, score: blended });
    }
  }

  const combined = combineComparableScopes(scoped);
  return {
    ranked: combined.ranked,
    federated: combined.federated,
    alsoMatched: [...alsoMatched, ...combined.alsoMatched],
  };
}
