/**
 * Whole-file BM25 for the file-first retrieval surface.
 *
 * This deliberately mirrors the benchmark baseline: path and raw source are
 * one document, query terms are binary, identifiers keep both their complete
 * token and camel/snake sub-parts, and files above 400 kB are excluded. Graph
 * structure remains available for navigation and span selection, but it does
 * not alter file relevance order.
 */

export const FILE_BM25_MAX_BYTES = 400_000;

const K1 = 1.2;
const B = 0.75;

export interface FileBm25Doc {
  path: string;
  terms: [string, number][];
  pathTerms: [string, number][];
  length: number;
}

export interface FileBm25Index {
  avgLength: number;
  df: [string, number][];
  docs: FileBm25Doc[];
}

export interface RankedFileBm25 {
  path: string;
  score: number;
  normalized: number;
  coverage: number;
  coverageStrong: number;
}

function identifierParts(name: string): string[] {
  return String(name)
    .replace(/\.[A-Za-z0-9]+$/, "")
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .flatMap((part) => part.split(/(?<=[A-Z])(?=[A-Z][a-z])/))
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3);
}

/** Benchmark-compatible code tokenization. */
export function tokenizeFileBm25(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text).split(/[^A-Za-z0-9_]+/)) {
    if (raw.length < 3) continue;
    out.push(raw.toLowerCase());
    const parts = identifierParts(raw);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

function counts(tokens: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1);
  return out;
}

function pairs(map: ReadonlyMap<string, number>): [string, number][] {
  return [...map.entries()];
}

export function buildFileBm25Index(
  sources: Iterable<readonly [string, string]>,
): FileBm25Index {
  const docs: FileBm25Doc[] = [];
  for (const [path, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    if (Buffer.byteLength(source, "utf8") > FILE_BM25_MAX_BYTES) continue;
    const pathTerms = counts(tokenizeFileBm25(path));
    const terms = counts(tokenizeFileBm25(`${path} ${source}`));
    let length = 0;
    for (const frequency of terms.values()) length += frequency;
    docs.push({ path, terms: pairs(terms), pathTerms: pairs(pathTerms), length });
  }

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const [term] of doc.terms) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return {
    avgLength: docs.length
      ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
      : 0,
    df: pairs(df),
    docs,
  };
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function idfFor(documentCount: number, frequency: number): number {
  return Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5));
}

export function rankFileBm25(
  index: FileBm25Index,
  query: string,
  inPrefix?: string,
): RankedFileBm25[] {
  const docs = inPrefix
    ? index.docs.filter((doc) => underPrefix(doc.path, inPrefix))
    : index.docs;
  if (docs.length === 0) return [];

  const df = inPrefix
    ? (() => {
        const filtered = new Map<string, number>();
        for (const doc of docs)
          for (const [term] of doc.terms)
            filtered.set(term, (filtered.get(term) ?? 0) + 1);
        return filtered;
      })()
    : new Map(index.df);
  const avgLength = inPrefix
    ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
    : index.avgLength;
  const queryTerms = [...new Set(tokenizeFileBm25(query))];
  const queryWeights = new Map(
    queryTerms.map((term) => [term, idfFor(docs.length, df.get(term) ?? 0)]),
  );
  const totalQueryWeight = [...queryWeights.values()].reduce((sum, weight) => sum + weight, 0);
  const ranked: RankedFileBm25[] = [];

  for (const doc of docs) {
    const terms = new Map(doc.terms);
    const pathTerms = new Map(doc.pathTerms);
    const norm = K1 * (1 - B + B * (doc.length / (avgLength || 1)));
    let score = 0;
    let matchedWeight = 0;
    let strongWeight = 0;
    for (const term of queryTerms) {
      const frequency = terms.get(term);
      const weight = queryWeights.get(term) ?? 0;
      if (frequency) {
        score += weight * ((frequency * (K1 + 1)) / (frequency + norm));
        matchedWeight += weight;
      }
      if (pathTerms.has(term)) strongWeight += weight;
    }
    if (score <= 0) continue;
    ranked.push({
      path: doc.path,
      score,
      normalized: 0,
      coverage: totalQueryWeight > 0 ? matchedWeight / totalQueryWeight : 0,
      coverageStrong: totalQueryWeight > 0 ? strongWeight / totalQueryWeight : 0,
    });
  }

  ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const top = ranked[0]?.score ?? 1;
  for (const item of ranked) item.normalized = item.score / top;
  return ranked;
}
