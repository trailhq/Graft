/**
 * Multi-scope score comparability (issue #117).
 *
 * The failure these pin: inside ONE repo, each scope used to be scored against
 * its own corpus statistics and then normalized by its OWN best hit, so every
 * scope's top document came out at ~1.0 no matter how weakly it actually
 * matched. Reciprocal-rank fusion then combined those orderings by RANK, which
 * discards magnitude entirely — a barely-relevant scope's rank-1 file tied the
 * genuinely-relevant scope's rank-1 file, and pushed that scope's rank-2 file
 * (frequently the answer) down the list.
 *
 * The fix makes scores comparable across scopes — global corpus statistics, one
 * shared normalization denominator — and then ranks by score. These tests drive
 * `rankScopesAndFuse` through the same `lex`/`strength`/`walk` seam `ask.ts`
 * uses, so they exercise the production path rather than a reimplementation.
 *
 * Deliberately free of benchmark-specific assumptions: the fixtures are raw
 * lexical scores, not files, languages, or repository shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankScopesAndFuse, PARTICIPATION_RATIO, type ScopeRankOps } from "../src/ask/fuse.js";

/**
 * Two scopes, both passing the match-strength signal, with a large RAW score
 * gap between them:
 *
 *   core/    best 10  — the query genuinely belongs here; `core2` is the answer
 *   samples/ best  3  — a real but far weaker match
 *
 * Under per-scope normalization both scopes' rank-1 normalize to 1.0 and fuse
 * to an identical RRF contribution, so `samples1` lands above `core2`. Under a
 * shared denominator `samples1` scores 0.3 against `core2`'s 0.8 and the order
 * is right. No graph walk: PR rescue is not what is under test.
 */
function twoScopeOps(samplesBest = 3): ScopeRankOps {
  const core = new Map([
    ["core1", 10],
    ["core2", 8],
    ["core3", 6],
    ["core4", 4],
    ["core5", 2],
  ]);
  const samples = new Map([["samples1", samplesBest]]);
  return {
    lex: (s) => new Map(s === "core" ? core : samples),
    // Both scopes clear the strength signal — this test is about magnitude,
    // not about whether a scope matched a name field.
    strength: () => ({ coverage: 1, coverageStrong: 1 }),
    walk: () => new Map(),
  };
}

test("#117: a weak scope's best hit must not outrank a strong scope's second hit", () => {
  const r = rankScopesAndFuse(["core", "samples"], twoScopeOps(), 0.5, 0.05);
  const order = r.ranked.map((d) => d.id);
  const core2 = order.indexOf("core2");
  const weak = order.indexOf("samples1");

  assert.ok(core2 >= 0, `core2 must be ranked at all, got ${order.join(" > ")}`);
  assert.ok(weak >= 0, `samples1 federates on strength, so it must appear, got ${order.join(" > ")}`);
  assert.ok(
    core2 < weak,
    `core2 (raw 8, strong scope) must outrank samples1 (raw 3, weak scope).\n` +
      `  got: ${order.join(" > ")}\n` +
      `  this is #117: per-scope normalization made both scopes' rank-1 equal, ` +
      `so the weak scope's only hit displaced the strong scope's second hit.`,
  );
});

test("#117: cross-scope order follows score magnitude, not per-scope rank", () => {
  const r = rankScopesAndFuse(["core", "samples"], twoScopeOps(), 0.5, 0.05);
  const order = r.ranked.map((d) => d.id);
  assert.deepEqual(
    order.slice(0, 4),
    ["core1", "core2", "core3", "core4"],
    `the strong scope's run must not be interleaved by a weaker scope's rank-1, got ${order.join(" > ")}`,
  );
});

test("#117: scores stay comparable across scopes — the weak scope's best scores strictly below the strong scope's best", () => {
  const r = rankScopesAndFuse(["core", "samples"], twoScopeOps(), 0.5, 0.05);
  const byId = new Map(r.ranked.map((d) => [d.id, d.score]));
  assert.ok(
    byId.get("samples1")! < byId.get("core1")!,
    `a weaker raw match must carry a strictly lower fused score ` +
      `(samples1=${byId.get("samples1")}, core1=${byId.get("core1")})`,
  );
});

// ── invariants that must survive the change ────────────────────────────────

test("small-scope discoverability: a SMALL but genuinely strong scope still ranks near the top", () => {
  // The property per-scope ranking exists to protect. `tiny` holds one file and
  // would be buried by raw pooling; it matches nearly as well as the huge
  // scope's best, so it must stay visible.
  const ops: ScopeRankOps = {
    lex: (s) =>
      s === "huge"
        ? new Map([["h1", 10], ["h2", 9], ["h3", 8], ["h4", 7], ["h5", 6]])
        : new Map([["t1", 9.5]]),
    strength: () => ({ coverage: 1, coverageStrong: 1 }),
    walk: () => new Map(),
  };
  const r = rankScopesAndFuse(["huge", "tiny"], ops, 0.5, 0.05);
  const order = r.ranked.map((d) => d.id);
  assert.ok(
    order.indexOf("t1") >= 0 && order.indexOf("t1") <= 2,
    `a one-file scope with a near-best match must stay in the top 3, got ${order.join(" > ")}`,
  );
  assert.deepEqual([...r.federated].sort(), ["huge", "tiny"], "both scopes federate");
});

test("alsoMatched: a scope too weak to federate is excluded from the order and reported for --in", () => {
  // With comparable scores the PARTICIPATION_RATIO gate is meaningful again:
  // 1 / 10 = 0.1, below the 0.25 floor. Before comparability every scope's top
  // normalized to ~1.0, which made this gate vacuous.
  const r = rankScopesAndFuse(["core", "samples"], twoScopeOps(1), 0.5, 0.05);
  assert.deepEqual(r.federated, ["core"], "the weak scope must not federate");
  assert.deepEqual(
    r.alsoMatched,
    [{ scope: "samples", bestId: "samples1" }],
    "it must still be reported so the caller can suggest --in samples/",
  );
  assert.ok(
    r.ranked.every((d) => d.scope === "core"),
    "a gated scope contributes nothing to the fused order",
  );
});

test("a scope exactly at the participation ratio still federates (gate stays inclusive)", () => {
  const r = rankScopesAndFuse(["core", "samples"], twoScopeOps(10 * PARTICIPATION_RATIO), 0.5, 0.05);
  assert.deepEqual([...r.federated].sort(), ["core", "samples"]);
  assert.deepEqual(r.alsoMatched, []);
});

test("single-scope repos are untouched: raw score order, original scores, no gate", () => {
  const ops: ScopeRankOps = {
    lex: () => new Map([["only1", 4], ["only2", 2], ["only3", 0.1]]),
    strength: () => ({ coverage: 1, coverageStrong: 1 }),
    walk: () => new Map(),
  };
  const r = rankScopesAndFuse(["only"], ops, 0.5, 0.05);
  assert.deepEqual(r.ranked.map((d) => d.id), ["only1", "only2", "only3"]);
  assert.deepEqual(r.federated, ["only"]);
  assert.deepEqual(r.alsoMatched, []);
  // One scope means its own best IS the shared denominator, so normalization is
  // unchanged and the top doc still lands at exactly 1.0 after the blend.
  assert.equal(r.ranked[0].score, 1);
});

test("post-normalization rank factors still survive (test de-ranking is not erased)", () => {
  const ops: ScopeRankOps = {
    lex: () => new Map([["source", 4], ["test", 10]]),
    strength: () => ({ coverage: 1, coverageStrong: 1 }),
    walk: () => new Map(),
    rankFactor: (_scope, id) => (id === "test" ? 0.35 : 1),
  };
  const r = rankScopesAndFuse(["app"], ops, 0.5, 0.05);
  assert.deepEqual(r.ranked.map((d) => d.id), ["source", "test"]);
});

test("deterministic under scope-order shuffle", () => {
  const a = rankScopesAndFuse(["core", "samples"], twoScopeOps(), 0.5, 0.05);
  const b = rankScopesAndFuse(["samples", "core"], twoScopeOps(), 0.5, 0.05);
  assert.deepEqual(a.ranked, b.ranked, "fused order must not depend on scope iteration order");
  assert.deepEqual([...a.federated].sort(), [...b.federated].sort());
});
