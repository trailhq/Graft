/**
 * Pure tests for `fuseScopes` (src/ask/fuse.ts) — per-scope ranking +
 * reciprocal-rank fusion. No fs, no graph build: these pin the fusion math
 * that keeps a big sub-project from drowning a small one in `graft ask`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fuseScopes,
  rankScopesAndFuse,
  RRF_K,
  PARTICIPATION_RATIO,
  STRONG_FLOOR,
  HIGH_FLOOR,
  type ScopedDoc,
  type ScopeRankOps,
} from "../src/ask/fuse.js";
import { formatAsk, type AskHit, type AskResult } from "../src/ask/ask.js";

/** A scope's docs with per-scope-normalized-looking scores, best first. */
function scopeDocs(scope: string, scores: number[]): ScopedDoc[] {
  return scores.map((score, i) => ({ id: `${scope}${i + 1}`, scope, score }));
}

test("fusion constants match the spec", () => {
  assert.equal(RRF_K, 60);
  assert.equal(PARTICIPATION_RATIO, 0.25);
  assert.equal(STRONG_FLOOR, 0.1);
  assert.equal(HIGH_FLOOR, 0.5);
});

test("10-doc scope vs 2-doc scope: top-6 of the fused order contains both scopes' best", () => {
  const huge = scopeDocs("h", [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);
  const tiny = scopeDocs("t", [1.0, 0.4]);
  const { ranked, federated } = fuseScopes([...huge, ...tiny]);
  const top6 = ranked.slice(0, 6).map((d) => d.id);
  assert.ok(top6.includes("h1"), `huge scope's best in top-6, got ${top6}`);
  assert.ok(top6.includes("t1"), `tiny scope's best in top-6, got ${top6}`);
  assert.deepEqual([...federated].sort(), ["h", "t"], "both scopes federated");
});

test("rank-1 of the tiny scope fuses equal to rank-1 of the huge scope, by construction", () => {
  const { ranked } = fuseScopes([
    ...scopeDocs("huge", [1.0, 0.9, 0.8, 0.7, 0.6, 0.5]),
    ...scopeDocs("tiny", [0.9]),
  ]);
  const byId = new Map(ranked.map((d) => [d.id, d.score]));
  assert.equal(byId.get("huge1"), byId.get("tiny1"), "equal fused score for both rank-1 docs");
  assert.equal(byId.get("huge1"), 1, "fused scores are normalized to [0,1], top = 1");
  assert.ok(byId.get("huge2")! < 1, "rank-2 fuses strictly below rank-1");
});

test("participation gate: a scope whose best is < 0.25 × global best is excluded but reported in alsoMatched", () => {
  const strong = scopeDocs("a", [1.0, 0.5, 0.3]);
  const weak = scopeDocs("b", [0.2, 0.1]); // 0.2 < 0.25 × 1.0
  const r = fuseScopes([...strong, ...weak]);
  assert.deepEqual(r.federated, ["a"]);
  assert.deepEqual(r.alsoMatched, [{ scope: "b", bestId: "b1" }]);
  assert.ok(r.ranked.every((d) => d.scope === "a"), "gated scope's docs are not in the fused order");
});

test("a scope at exactly the gate participates (gate is inclusive)", () => {
  const r = fuseScopes([...scopeDocs("a", [1.0]), ...scopeDocs("b", [0.25])]);
  assert.deepEqual([...r.federated].sort(), ["a", "b"]);
  assert.deepEqual(r.alsoMatched, []);
});

test("single-scope input returns the docs unchanged in order, with their original scores", () => {
  const docs = scopeDocs("only", [1.4, 0.9, 0.2, 0.05]); // below-gate scores stay too: no gate with one scope
  const r = fuseScopes(docs);
  assert.deepEqual(
    r.ranked,
    docs.map((d) => ({ id: d.id, scope: "only", score: d.score })),
    "order and scores pass through untouched — degrades to current single-scope behavior",
  );
  assert.deepEqual(r.federated, ["only"]);
  assert.deepEqual(r.alsoMatched, []);
});

test("non-scoring docs (score <= 0) never rank, federate, or report", () => {
  const r = fuseScopes([
    ...scopeDocs("a", [1.0, 0.6]),
    { id: "z1", scope: "z", score: 0 },
    { id: "z2", scope: "z", score: -1 },
  ]);
  assert.deepEqual(r.federated, ["a"]);
  assert.deepEqual(r.alsoMatched, []);
  assert.ok(r.ranked.every((d) => d.scope === "a"));
});

test("empty input fuses to an empty result", () => {
  assert.deepEqual(fuseScopes([]), { ranked: [], federated: [], alsoMatched: [] });
});

test("deterministic under input shuffle, including score ties", () => {
  const docs: ScopedDoc[] = [
    ...scopeDocs("api", [1.0, 0.8, 0.8, 0.3]), // tie inside a scope
    ...scopeDocs("web", [1.0, 0.5]),
    ...scopeDocs("docs", [0.1]), // gated out — must still be reported identically
  ];
  const baseline = fuseScopes(docs);
  const shuffles = [
    [...docs].reverse(),
    [docs[3], docs[6], docs[0], docs[5], docs[2], docs[1], docs[4]],
  ];
  for (const shuffled of shuffles) {
    assert.deepEqual(fuseScopes(shuffled), baseline, "same result regardless of input order");
  }
});

// ── rankScopesAndFuse: since #117, scopes are scored against REPO-WIDE corpus
// statistics and normalized by a shared denominator, so their scores are
// directly comparable. Participation is therefore the PARTICIPATION_RATIO
// share check — a scope must reach 0.25× the best score anywhere in the repo —
// and gated-out scopes still go to `alsoMatched` for `--in`.
//
// Historical note, because it looks like a reversal: this ratio check WAS
// previously rejected as "far too lenient, leaks junk", and a match-STRENGTH
// gate (STRONG_FLOOR/HIGH_FLOOR) replaced it. That judgement was correct at the
// time and is now obsolete for a specific reason — back then every scope was
// normalized by its OWN best, so each scope's top doc sat at ~1.0 and the ratio
// compared 1.0 against 1.0, which is vacuous. Against a shared denominator the
// same ratio compares real magnitudes and does the job it was designed for. The
// strength floors are still exported and still gate `federateAsk`, which fuses
// separate repositories and so genuinely has no shared denominator.
//
// These drive `rankScopesAndFuse` end to end through its `lex`/`walk` callback
// seam — the same seam `ask.ts` drives it through. ─────────────────────────

/** Scope "a": five docs with a real raw-lex spread (best = 10). Scope "b": one
 * doc whose raw score is the probe knob, since raw magnitude is now what
 * decides participation. No graph walk (PR rescue isn't what's under test). */
function makeOps(bBest: number): ScopeRankOps {
  const aLex = new Map([
    ["a1", 10],
    ["a2", 8],
    ["a3", 6],
    ["a4", 4],
    ["a5", 2],
  ]);
  const bLex = new Map([["b1", bBest]]);
  return {
    lex: (s) => (s === "a" ? new Map(aLex) : new Map(bLex)),
    walk: () => new Map(),
  };
}

test("rankScopesAndFuse: post-normalization rank factors cannot be erased by a top test match", () => {
  const ops: ScopeRankOps = {
    // The test remains the strongest raw match even after lexical de-ranking.
    // Normalization therefore restores it to 1.0 while source lands at 0.4.
    lex: () => new Map([["source", 4], ["test", 10]]),
    walk: () => new Map(),
    rankFactor: (_scope, id) => (id === "test" ? 0.35 : 1),
  };
  const r = rankScopesAndFuse(["app"], ops, 0.5, 0.05);
  assert.deepEqual(
    r.ranked.map((d) => d.id),
    ["source", "test"],
    "the final test prior must survive per-scope normalization",
  );
});

test("rankScopesAndFuse: optional collapse sees components and supplies the docs combined across scopes", () => {
  let hookCalled = false;
  const ops: ScopeRankOps = {
    lex: () => new Map([["a1", 10], ["a2", 4]]),
    walk: () => new Map([["a2", 0.8]]),
    rankFactor: (_scope, id) => (id === "a2" ? 0.5 : 1),
    collapseCandidates: (candidates) => {
      hookCalled = true;
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      assert.deepEqual(
        {
          lexical: byId.get("a1")?.lexical,
          graph: byId.get("a1")?.graph,
          rankFactor: byId.get("a1")?.rankFactor,
          baseline: byId.get("a1")?.score,
        },
        { lexical: 1, graph: 0, rankFactor: 1, baseline: 1 },
      );
      assert.deepEqual(
        {
          lexical: byId.get("a2")?.lexical,
          graph: byId.get("a2")?.graph,
          rankFactor: byId.get("a2")?.rankFactor,
          baseline: byId.get("a2")?.score,
        },
        { lexical: 0.4, graph: 0.8, rankFactor: 0.5, baseline: 0.4 },
      );
      return [{ id: "file-a", scope: "app", score: 1.1 }];
    },
  };

  const result = rankScopesAndFuse(["app"], ops, 0.5, 0.05);
  assert.equal(hookCalled, true);
  assert.deepEqual(result.ranked, [
    { id: "file-a", scope: "app", score: 1.1 },
  ]);
});

test("rankScopesAndFuse: a scope whose best hit is a weak incidental match is excluded from ranked and reported in alsoMatched", () => {
  // b's only hit scores 1 against a repo best of 10 — 0.1, well under the 0.25
  // participation ratio. An incidental body-comment collision, same shape as
  // the monorepo junk/ repro.
  const r = rankScopesAndFuse(["a", "b"], makeOps(1), 0.5, 0.05);
  assert.deepEqual(r.federated, ["a"], "b must not federate on a weak match");
  assert.deepEqual(r.alsoMatched, [{ scope: "b", bestId: "b1" }]);
  assert.ok(
    r.ranked.every((d) => d.scope === "a"),
    "b's junk match must not appear anywhere in the fused order",
  );
  assert.deepEqual(
    r.ranked.map((d) => d.id),
    ["a1", "a2", "a3", "a4", "a5"],
    "sole surviving scope passes through in score order",
  );
});

test("rankScopesAndFuse: positive — a scope with a genuinely competitive match federates", () => {
  const r = rankScopesAndFuse(["a", "b"], makeOps(9), 0.5, 0.05);
  assert.deepEqual([...r.federated].sort(), ["a", "b"], "b federates on a strong score");
  assert.deepEqual(r.alsoMatched, []);
  assert.ok(
    r.ranked.some((d) => d.id === "b1"),
    "b's doc appears in the combined order",
  );
  // Comparability: b's 9 sits between a's 10 and a's 8, which is precisely what
  // per-scope normalization could not express — it put b1 level with a1.
  assert.deepEqual(r.ranked.slice(0, 3).map((d) => d.id), ["a1", "b1", "a2"]);
});

test("rankScopesAndFuse: a scope exactly at the participation ratio federates (inclusive)", () => {
  const r = rankScopesAndFuse(["a", "b"], makeOps(10 * PARTICIPATION_RATIO), 0.5, 0.05);
  assert.deepEqual([...r.federated].sort(), ["a", "b"]);
  assert.deepEqual(r.alsoMatched, []);
  assert.ok(r.ranked.some((d) => d.id === "b1"));
});

test("formatAsk: 'also matched … --in …' actually renders for a scope gated out of participation", () => {
  const fusion = rankScopesAndFuse(["a", "b"], makeOps(1), 0.5, 0.05);
  const hits: AskHit[] = fusion.ranked.map((d) => ({
    kind: "symbol",
    title: d.id,
    pointer: d.id,
    snippet: "",
    score: d.score,
    scope: d.scope,
  }));
  const scopes =
    fusion.federated.length > 1 || fusion.alsoMatched.length > 0
      ? { federated: fusion.federated, alsoMatched: fusion.alsoMatched }
      : undefined;
  const result: AskResult = { query: "weak-scope probe", mode: "lexical", hits, scopes };
  const out = formatAsk(result);
  assert.match(
    out,
    /also matched: b\/ — narrow with --in b\//,
    `expected an "also matched" footer line for b/, got:\n${out}`,
  );
});
