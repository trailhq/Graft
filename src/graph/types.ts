/**
 * `graph.json` — the code graph schema (v1).
 *
 * One node per definition (file, class, function, method, interface, type, enum),
 * wired by edges (contains, imports, calls, ...). Field names follow the LSP /
 * SCIP vocabulary (`name`, `kind`, ...) rather than any one tool's conventions.
 *
 * Two tiers of data live on a node:
 *   - Tier-1 (deterministic, $0): everything from the AST. Rebuilt on every run.
 *   - Tier-2 (one LLM call, cached on `body_hash`): `summary` + `crux`.
 * M1 populates Tier-1 only; Tier-2 fields ship as `pending`/null.
 */

/** What a node represents. LSP SymbolKind, narrowed to what TS + Python + Go + C/C++ + R produce. */
export type Kind =
  | "file"
  | "class"
  | "function"
  | "method"
  | "interface" // TS + Go
  | "type" // TS + Go (type alias / named type)
  | "enum" // TS only
  | "struct"; // Go only

/** How confident we are an edge is true. */
export type Confidence = "extracted" | "inferred";

/** Whether the LLM meaning-layer has been computed for a node. */
export type SummaryState = "pending" | "ready" | "stale";

/** The LLM-chosen business-logic excerpt. `code` is the source of truth; `span`
 * is a best-effort pointer that may drift and is never used to re-slice. */
export interface Crux {
  code: string;
  span: string; // e.g. "L189-L196"
}

export interface NodeV1 {
  // identity
  id: string; // path-scoped: "src/cache.ts#Cache.get"
  name: string; // the symbol's own name: "get"
  kind: Kind;
  // method nodes only: the bare name of the immediate enclosing class/receiver
  // ("Cache" for "get"). Lets owner-qualified lookups (resolve.ts's ownerMethod
  // index) key off a stored field instead of re-deriving it by slicing `id`,
  // which breaks once ids can carry a dedup ordinal (`Cache.get~2`).
  owner?: string;

  // location (Tier-1, deterministic)
  path: string; // repo-relative: "src/cache.ts"
  span: string; // whole definition: "L165-L222"
  signature: string | null; // "get(k: string): number" — null for kind:"file"
  exported: boolean;
  origin: "ast";
  body_hash: string; // sha256 of the definition text; the Tier-2 re-run trigger
  chars?: number; // byte length of the WHOLE file (file nodes only); the baseline
  //                 `ask` uses to estimate tokens saved vs reading the file whole
  body_text?: string; // searchable whitespace-normalized definition body (Tier-1,
  //                 symbol nodes only, capped). Ranks `ask` queries so a term in
  //                 the code — not just the name/signature — is findable; never
  //                 emitted to the agent (that reads verbatim source via `--source`).
  //                 Absent on file nodes and on graphs built before this field.

  // meaning (Tier-2, one LLM call)
  summary_state: SummaryState;
  summary: string | null;
  crux: Crux | null;
}

export type Relation =
  | "contains" // file → symbol, class → method (structural)
  | "calls" // function → function it invokes
  | "imports" // file → module
  | "references" // symbol → symbol it names but doesn't call
  | "implements" // TS: class → interface
  | "extends"; // class → base class

export interface EdgeV1 {
  source: string; // node id
  target: string; // node id, or an unresolved module string for imports
  relation: Relation;
  confidence: Confidence;
}

/** A ranking scope: a sub-project discovered by project-marker files (`package.json`,
 * `go.mod`, ...). `prefix` is a posix path relative to the graph root ("" = root scope);
 * `label` is the same value without a trailing slash (also "" for root); `markers` lists
 * which marker file(s) were found in that directory. See `src/graph/scopes.ts`. */
export interface ScopeV1 {
  prefix: string;
  label: string;
  markers: string[];
}

export interface GraphV1 {
  meta: {
    version: 1;
    nodeCount: number;
    edgeCount: number;
    languages: string[];
    /** Ranking scopes: posix path prefixes relative to the graph root, "" = root scope.
     * Absent (old graphs) ≡ [{ prefix: "", label: "" }]. Sorted by prefix length desc. */
    scopes?: ScopeV1[];
  };
  nodes: NodeV1[];
  edges: EdgeV1[];
}
