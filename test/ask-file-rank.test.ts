import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rankFilesBounded,
  type FileRankCandidate,
} from "../src/ask/file-rank.js";

const weights = (...entries: Array<[string, number]>): Map<string, number> => new Map(entries);
const matched = (...terms: string[]): Set<string> => new Set(terms);

function candidate(
  value: Partial<FileRankCandidate> & Pick<FileRankCandidate, "id" | "file">,
): FileRankCandidate {
  const lexical = value.lexical ?? 0;
  const graph = value.graph ?? 0;
  const rankFactor = value.rankFactor ?? 1;
  return {
    kind: "symbol",
    rawLexical: value.rawLexical ?? lexical,
    lexical,
    graph,
    rankFactor,
    baselineScore: value.baselineScore ?? rankFactor * (lexical + 0.5 * graph),
    matchedTerms: value.matchedTerms ?? new Set(),
    eligible: value.eligible ?? lexical > 0,
    ...value,
  };
}

test("bounded residual pools one raw-lexical anchor and leaves every sibling queued at baseline", () => {
  const candidates = [
    candidate({
      id: "anchor", file: "a.ts", rawLexical: 10, lexical: 0.4, graph: 0.2,
      matchedTerms: matched("alpha"),
      matchedStrongTerms: matched("alpha"),
    }),
    candidate({
      id: "sibling", file: "a.ts", rawLexical: 8, lexical: 0.3, graph: 0.1,
      matchedTerms: matched("beta"),
      matchedStrongTerms: matched("beta"),
    }),
    candidate({
      id: "singleton", file: "b.ts", rawLexical: 9, lexical: 0.9,
      matchedTerms: matched("alpha", "beta"),
    }),
  ];

  const ranked = rankFilesBounded(candidates, weights(["alpha", 0.4], ["beta", 0.6]));
  const file = ranked.find((entry) => entry.file === "a.ts")!;
  const singleton = ranked.find((entry) => entry.file === "b.ts")!;

  assert.equal(file.lexicalAnchor?.id, "anchor");
  assert.equal(file.anchorCoverage, 0.4);
  assert.equal(file.unionCoverage, 1);
  assert.equal(file.unionStrongCoverage, 1);
  assert.ok(Math.abs(file.boundedResidual - 0.24) < 1e-12);
  assert.ok(Math.abs(file.pooledLexical - 0.544) < 1e-12);
  assert.ok(Math.abs(file.score - 0.644) < 1e-12);
  assert.equal(file.representative.id, "anchor");
  assert.equal(file.representativeReason, "pooled-anchor");
  assert.equal(singleton.score, candidates[2].baselineScore);

  assert.deepEqual(file.queue.map((candidate) => candidate.id), ["anchor", "sibling"]);
});

test("anchor coverage belongs to the raw-lexical anchor, not an independent coverage leader", () => {
  const candidates = [
    candidate({
      id: "raw-anchor", file: "a.ts", rawLexical: 10, lexical: 0.5,
      matchedTerms: matched("alpha"),
    }),
    candidate({
      id: "coverage-leader", file: "a.ts", rawLexical: 9, lexical: 0.45,
      matchedTerms: matched("beta", "gamma", "delta"),
    }),
  ];
  const queryWeights = weights(
    ["alpha", 0.25],
    ["beta", 0.25],
    ["gamma", 0.25],
    ["delta", 0.25],
  );

  const [file] = rankFilesBounded(candidates, queryWeights);
  assert.equal(file.lexicalAnchor?.id, "raw-anchor");
  assert.equal(file.anchorCoverage, 0.25);
  assert.equal(file.unionCoverage, 1);
  assert.ok(Math.abs(file.boundedResidual - 0.1875) < 1e-12);
  assert.ok(Math.abs(file.score - 0.59375) < 1e-12);
});

test("equal distributed evidence follows (m - 1) / m^2 and shrinks for large files", () => {
  let previousResidual = Number.POSITIVE_INFINITY;
  for (const count of [2, 3, 4, 8, 12, 20]) {
    const queryWeights = new Map<string, number>();
    const candidates: FileRankCandidate[] = [];
    for (let index = 0; index < count; index++) {
      const term = `t${index}`;
      queryWeights.set(term, 1 / count);
      candidates.push(candidate({
        id: `n${String(index).padStart(2, "0")}`,
        file: "monster.ts",
        rawLexical: 1,
        lexical: 0.1,
        matchedTerms: matched(term),
      }));
    }

    const [file] = rankFilesBounded(candidates, queryWeights);
    const expected = (count - 1) / (count * count);
    assert.ok(Math.abs(file.boundedResidual - expected) < 1e-12, `m=${count}`);
    assert.ok(file.boundedResidual <= previousResidual, `m=${count} does not grow`);
    assert.ok(Math.abs(file.pooledLexical - (0.1 + 0.9 * expected)) < 1e-12);
    previousResidual = file.boundedResidual;
  }
});

test("raw sibling magnitude cannot affect the bounded residual when term presence is unchanged", () => {
  const make = (siblingRaw: number) => [
    candidate({
      id: "anchor", file: "a.ts", rawLexical: 10, lexical: 0.6,
      matchedTerms: matched("alpha"),
    }),
    candidate({
      id: "sibling", file: "a.ts", rawLexical: siblingRaw, lexical: 0.2,
      matchedTerms: matched("beta"),
    }),
  ];
  const queryWeights = weights(["alpha", 0.5], ["beta", 0.5]);
  const [small] = rankFilesBounded(make(1), queryWeights);
  const [large] = rankFilesBounded(make(9), queryWeights);

  assert.equal(small.lexicalAnchor?.id, "anchor");
  assert.equal(large.lexicalAnchor?.id, "anchor");
  assert.equal(small.boundedResidual, large.boundedResidual);
  assert.equal(small.score, large.score);
});

test("duplicate terms and singleton files are exact baseline identities", () => {
  const candidates = [
    candidate({ id: "a1", file: "a.ts", rawLexical: 8, lexical: 0.8, graph: 0.2, matchedTerms: matched("same") }),
    candidate({ id: "a2", file: "a.ts", rawLexical: 6, lexical: 0.6, matchedTerms: matched("same") }),
    candidate({ id: "b1", file: "b.ts", rawLexical: 5, lexical: 0.5, graph: 0.4, matchedTerms: matched("only") }),
  ];
  const ranked = rankFilesBounded(candidates, weights(["same", 0.5], ["only", 0.5]));
  const repeated = ranked.find((file) => file.file === "a.ts")!;
  const singleton = ranked.find((file) => file.file === "b.ts")!;

  assert.equal(repeated.boundedResidual, 0);
  assert.equal(repeated.lexicalDelta, 0);
  assert.equal(repeated.score, candidates[0].baselineScore);
  assert.equal(singleton.boundedResidual, 0);
  assert.equal(singleton.score, candidates[2].baselineScore);
});

test("graph-only and residual winners stay exact baseline competitors", () => {
  const candidates = [
    candidate({ id: "lex-a", file: "a.ts", rawLexical: 4, lexical: 0.4, matchedTerms: matched("alpha") }),
    candidate({ id: "lex-b", file: "a.ts", rawLexical: 3, lexical: 0.3, matchedTerms: matched("beta") }),
    candidate({
      id: "residual", file: "a.ts", kind: "file", rawLexical: 8, lexical: 0.8, graph: 0.2,
      matchedTerms: matched("gamma"), eligible: false,
    }),
    candidate({
      id: "graph", file: "graph.ts", rawLexical: 0, lexical: 0, graph: 0.7,
      matchedTerms: new Set(), eligible: false,
    }),
  ];
  const ranked = rankFilesBounded(
    candidates,
    weights(["alpha", 0.4], ["beta", 0.4], ["gamma", 0.2]),
  );
  const residual = ranked.find((file) => file.file === "a.ts")!;
  const graph = ranked.find((file) => file.file === "graph.ts")!;

  assert.equal(residual.unionCoverage, 0.8, "residual gamma does not enter union coverage");
  assert.equal(residual.representative.id, "residual");
  assert.equal(residual.representativeReason, "baseline-residual");
  assert.equal(residual.score, candidates[2].baselineScore);
  assert.equal(graph.boundedResidual, 0);
  assert.equal(graph.representative.id, "graph");
  assert.equal(graph.score, candidates[3].baselineScore);
});

test("a graph-only baseline leader receives no complement from lexical siblings", () => {
  const candidates = [
    candidate({ id: "lex-a", file: "a.ts", rawLexical: 4, lexical: 0.4, matchedTerms: matched("alpha") }),
    candidate({ id: "lex-b", file: "a.ts", rawLexical: 3, lexical: 0.3, matchedTerms: matched("beta") }),
    candidate({
      id: "graph", file: "a.ts", rawLexical: 0, lexical: 0, graph: 1.6,
      matchedTerms: new Set(), eligible: false,
    }),
  ];
  const [file] = rankFilesBounded(candidates, weights(["alpha", 0.5], ["beta", 0.5]));

  assert.equal(file.representative.id, "graph");
  assert.equal(file.representativeReason, "baseline-symbol");
  assert.equal(file.score, candidates[2].baselineScore);
});

test("one real node owns the score; max lexical and max PPR are never combined", () => {
  const candidates = [
    candidate({ id: "lex-head", file: "a.ts", rawLexical: 10, lexical: 1, graph: 0.05, matchedTerms: matched("alpha") }),
    candidate({ id: "graph-head", file: "a.ts", rawLexical: 0.1, lexical: 0.01, graph: 1, matchedTerms: matched("beta") }),
  ];
  const [file] = rankFilesBounded(candidates, weights(["alpha", 0.5], ["beta", 0.5]));

  assert.equal(file.representative.id, "lex-head");
  assert.equal(file.lexicalDelta, 0, "a saturated anchor has no lexical headroom");
  assert.equal(file.score, 1.025);
  assert.ok(file.score < 1.5);
});

test("the existing test factor remains outside the complete pooled anchor score", () => {
  const rankFactor = 0.35;
  const candidates = [
    candidate({
      id: "test-a", file: "a.test.ts", rawLexical: 8, lexical: 0.8, graph: 0.2,
      rankFactor, baselineScore: rankFactor * 0.9, matchedTerms: matched("alpha"),
    }),
    candidate({
      id: "test-b", file: "a.test.ts", rawLexical: 4, lexical: 0.4,
      rankFactor, baselineScore: rankFactor * 0.4, matchedTerms: matched("beta"),
    }),
  ];
  const [file] = rankFilesBounded(candidates, weights(["alpha", 0.5], ["beta", 0.5]));

  assert.ok(Math.abs(file.boundedResidual - 0.25) < 1e-12);
  assert.ok(Math.abs(file.pooledLexical - 0.85) < 1e-12);
  assert.ok(Math.abs(file.score - rankFactor * (0.85 + 0.1)) < 1e-12);
});

test("file ranks and queues are deterministic under candidate permutation", () => {
  const candidates = [
    candidate({ id: "b", file: "z.ts", rawLexical: 4, lexical: 0.4, matchedTerms: matched("alpha"), spanStart: 8 }),
    candidate({ id: "a", file: "z.ts", rawLexical: 4, lexical: 0.4, matchedTerms: matched("beta"), spanStart: 2 }),
    candidate({ id: "c", file: "a.ts", rawLexical: 4, lexical: 0.4, matchedTerms: matched("alpha"), spanStart: 1 }),
  ];
  const queryWeights = weights(["alpha", 0.5], ["beta", 0.5]);
  const project = (input: FileRankCandidate[]) =>
    rankFilesBounded(input, queryWeights).map((file) => ({
      file: file.file,
      representative: file.representative.id,
      reason: file.representativeReason,
      anchor: file.lexicalAnchor?.id,
      queue: file.queue.map((candidate) => candidate.id),
      score: file.score,
    }));

  assert.deepEqual(project(candidates), project([candidates[2], candidates[0], candidates[1]]));
});
