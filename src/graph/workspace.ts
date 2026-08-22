/**
 * Workspace federation — a "workspace" is a parent directory that holds two or
 * more immediate git-repo children and has no source graph of its own. Instead
 * of one mega-graph pooling every repo, each child keeps its OWN committable
 * `graft/` (byte-identical to building that child standalone), and the parent
 * holds a single `graft/workspace.json` index:
 *
 *   { "version": 1, "children": ["repoA", "repoB"] }
 *
 * Queries run at the parent federate across the children: `ask` fuses every
 * child's ranked hits with `fuseScopes`, reciprocal-rank fusion, so the big
 * repo can't drown the small one. Scopes INSIDE one repo no longer take that
 * path — they share corpus statistics and a normalization denominator, so they
 * are combined by score (see `ask/fuse.ts`). Separate child repositories have
 * no such shared scale, which is exactly the case rank fusion is for.
 * `grep`/`map`/`check`/`callers` run per child and merge, always labeled
 * `<child>/`.
 *
 * This module owns the pure/core pieces (the format, its readers/writers, graph
 * loading, and the federated command bodies that return renderable data). The
 * CLI print/exit wrappers and the per-child build orchestration live in
 * `workspace-cli.ts`; `mcp/tools.ts` calls the federate* functions directly.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { checkGraph } from "./check.js";
import { loadGraphCached } from "./load.js";
import { buildRepoMap, formatRepoMap } from "./map.js";
import { discoverWorkspaceChildren } from "./scopes.js";
import {
  callersSavings,
  headerOf,
  hitLine,
  looseNoteFor,
} from "./traverse-cli.js";
import { edgeWalk, resolveSymbol, type Direction } from "./traverse.js";
import { wiringPath } from "./write.js";
import type { GraphV1 } from "./types.js";
import { ask, type AskHit, type AskResult } from "../ask/ask.js";
import { fuseScopes, STRONG_FLOOR, HIGH_FLOOR, type ScopedDoc } from "../ask/fuse.js";
import { grepGraph, type GrepGroup, type GrepResult } from "../search/grep.js";
import { formatGrepResult, zeroHitNote } from "../search/grep-cli.js";
import { withSavings, type Savings } from "../context/savings.js";

/** The parent index written to `<parent>/graft/workspace.json`. Nodes/edges
 * never live at the parent — they live in each child's own `graft/`. */
export interface WorkspaceV1 {
  version: 1;
  /** Immediate child dir names that are git repos, sorted. */
  children: string[];
}

const WORKSPACE_FILE = "workspace.json";

/** Absolute path to the workspace index for a parent root (`<dir>/graft/workspace.json`). */
export function workspacePath(root: string, override?: string): string {
  return join(contextDirFor(root, override), WORKSPACE_FILE);
}

/** Read the workspace index, or null when the parent has none (not a workspace,
 * or unparseable/foreign json — treated the same as absent). */
export function readWorkspace(root: string, override?: string): WorkspaceV1 | null {
  const path = workspacePath(root, override);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkspaceV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.children)) return null;
    return { version: 1, children: parsed.children.map(String) };
  } catch {
    return null;
  }
}

/** Write the workspace index, sorting children for a stable, minimal git diff. */
export function writeWorkspace(root: string, ws: WorkspaceV1, override?: string): string {
  const dir = contextDirFor(root, override);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WORKSPACE_FILE);
  const sorted: WorkspaceV1 = { version: 1, children: [...ws.children].sort() };
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
  return path;
}

/** A parent is a workspace BUILD target when it has no own `.git` and ≥2 git
 * children — or it was already split (a `workspace.json` is present). The
 * no-own-`.git` guard keeps a normal repo with git submodules from being
 * mistaken for a workspace. */
export function isWorkspaceBuildRoot(root: string, override?: string): boolean {
  if (readWorkspace(root, override)) return true;
  if (existsSync(join(root, ".git"))) return false;
  return discoverWorkspaceChildren(root).length >= 2;
}

/** True when the parent has a mega-graph from an older single-graph build
 * (`graft/.graph/wiring.json`) — the thing a workspace build migrates away. */
export function hasMegaGraph(root: string, override?: string): boolean {
  return existsSync(wiringPath(contextDirFor(root, override)));
}

/** The EXACT split warning printed once, when a mega-graph parent is first
 * built as a workspace. Templated on the child list so it names the real repos. */
export function migrationNote(children: string[]): string {
  const dirs = children.map((c) => `${c}/graft/`).join(", ");
  return (
    `⚠ this folder contains ${children.length} separate git repos — splitting: ` +
    `each repo now gets its own committable graft/ (${dirs}); the combined graph ` +
    `here is replaced by a workspace index. Queries from here now search all repos, fairly.`
  );
}

/** Remove the parent's entire `graft/` tree — the mega-graph, its `.cache`, and
 * any stale cards — so after `writeWorkspace` the parent holds ONLY
 * workspace.json. Child graphs live in sibling `<child>/graft/`, never under
 * this dir, so they are untouched. */
export function clearParentGraft(root: string, override?: string): void {
  rmSync(contextDirFor(root, override), { recursive: true, force: true });
}

export interface LoadedChild {
  child: string;
  graph: GraphV1;
}

export interface WorkspaceGraphs {
  /** Children (from workspace.json when present, else discovered) that have a
   * built graph, in sorted child order. */
  loaded: LoadedChild[];
  /** Listed children with no built graph yet — surfaced, never silently skipped. */
  missing: string[];
}

/** Load each child's graph via `loadGraphCached`. Children come from
 * workspace.json when present, otherwise from live git-child discovery (a
 * not-yet-built workspace). A child without a built graph is counted into
 * `missing`, not dropped. */
export function loadWorkspaceGraphs(root: string, override?: string): WorkspaceGraphs {
  const ws = readWorkspace(root, override);
  const children = (ws ? ws.children : discoverWorkspaceChildren(root)).slice().sort();
  const loaded: LoadedChild[] = [];
  const missing: string[] = [];
  for (const child of children) {
    const graph = loadGraphCached(contextDirFor(join(root, child)));
    if (graph) loaded.push({ child, graph });
    else missing.push(child);
  }
  return { loaded, missing };
}

/** "2 of 3 workspace repos have graphs; run graft build to cover repoC" — the
 * coverage line federated commands append when some listed child is unbuilt.
 * Empty string when every child has a graph. */
export function coverageNote(g: WorkspaceGraphs): string {
  if (g.missing.length === 0) return "";
  const total = g.loaded.length + g.missing.length;
  return `${g.loaded.length} of ${total} workspace repos have graphs; run graft build to cover ${g.missing.join(", ")}`;
}

/** Prefix a hit pointer with its child dir so a `path:span` (or concept path
 * list) opens correctly from the parent. Leaves free-text fragments alone. */
function prefixPointer(child: string, pointer: string): string {
  return pointer
    .split(",")
    .map((part) => {
      const t = part.trim();
      if (!t || t.includes(" ")) return part;
      return `${child}/${t}`;
    })
    .join(", ");
}

export interface FederateAskOptions {
  limit?: number;
  source?: boolean;
  full?: boolean;
  graphRank?: boolean;
  /** Narrow to one child (`repoA`) or a sub-scope within it (`repoA/backend`).
   * A prefix matching NO child throws, listing the repos. */
  in?: string;
}

interface ChildRun {
  child: string;
  hits: AskHit[];
  /** The child's top-hit idf-weighted matched share over name+path+body — a
   * RAW, cross-child-comparable magnitude (NOT per-child normalized). */
  coverage: number;
  /** Same, but over name+path ONLY (body dropped) — the match-STRENGTH signal.
   * A body-only incidental collision has `coverageStrong === 0`. */
  coverageStrong: number;
}

// STRONG_FLOOR / HIGH_FLOOR (a child federates if its top hit matched a
// query term in a NAME/PATH field ≥ STRONG_FLOOR, OR its overall name+path+
// body coverage is broad enough to be real even body-only, ≥ HIGH_FLOOR) are
// defined ONCE in `../ask/fuse.js` and imported here. This is now their only
// caller: a share-of-the-query threshold is the best available signal when the
// candidates carry no common score scale, which is the situation across child
// repositories. `rankScopesAndFuse` used to gate on them for the same reason
// and no longer needs to — within one repo the scores are comparable, so a
// weak scope is held back by scoring low rather than by a strength floor.

/**
 * Federated `ask` across a workspace: run each child's own ask pipeline, then
 * fuse ALL the children's scope lists with `fuseScopes` (reciprocal rank). Each
 * child contributes one fusion scope per intra-child scope, labeled
 * `<child>/<scope>` (or just `<child>` for a child's root scope), so a big repo
 * can't drown a small one — rank positions are comparable across repos where
 * raw scores are not.
 *
 * Rank fusion is still right HERE, and only here: each child was scored against
 * its own corpus, so cross-child scores share no scale. Within a single repo
 * that is no longer true — `rankScopesAndFuse` gives every scope the same
 * statistics and the same denominator and combines them by score.
 *
 * Returns a normal `AskResult`; `formatAsk` renders it unchanged, labeling each
 * hit `[<child>/…]` via the standard multi-scope path.
 */
export function federateAsk(
  root: string,
  override: string | undefined,
  query: string,
  opts: FederateAskOptions = {},
): AskResult {
  const wg = loadWorkspaceGraphs(root, override);
  const limit = opts.limit ?? 8;

  // `--in` scopes to a single child (and, past the first segment, a sub-scope
  // within it). A prefix naming no known child at all is a caller mistake.
  let onlyChild: string | undefined;
  let childIn: string | undefined;
  if (opts.in) {
    const prefix = opts.in.replace(/\/+$/, "");
    const [name, ...rest] = prefix.split("/");
    const allChildren = [...wg.loaded.map((l) => l.child), ...wg.missing].sort();
    if (!allChildren.includes(name)) {
      throw new Error(`no workspace repo "${name}" - repos: ${allChildren.join(", ")}`);
    }
    onlyChild = name;
    childIn = rest.length ? rest.join("/") : undefined;
  }

  // Pass 1: run each child's ask; keep its hits + RAW top-hit coverage.
  const runs: ChildRun[] = [];
  for (const { child } of wg.loaded) {
    if (onlyChild && child !== onlyChild) continue;
    let r: AskResult;
    try {
      // Over-fetch per child so cross-child fusion has enough candidates to
      // rank before the final `limit` slice.
      r = ask(join(root, child), query, {
        limit: Math.max(limit * 4, 20),
        source: opts.source,
        full: opts.full,
        graphRank: opts.graphRank,
        in: childIn,
      });
    } catch {
      continue; // corrupt child, or a sub-scope --in matching nothing here
    }
    if (r.hits.length === 0) continue;
    runs.push({ child, hits: r.hits, coverage: r.coverage ?? 0, coverageStrong: r.coverageStrong ?? 0 });
  }

  // Cross-child participation gate on match STRENGTH, not a lenient ratio.
  // Per-child hit scores are each per-child-normalized (top ~1.0 everywhere),
  // so feeding them to fuseScopes makes its gate vacuous across repos — a junk
  // body-token collision would federate beside another repo's genuine hits.
  // Gate: a child federates iff its top hit matched a query term in a NAME/PATH
  // field (coverageStrong ≥ STRONG_FLOOR — not just an incidental body token)
  // OR its overall coverage is broad enough to be real (≥ HIGH_FLOOR). A
  // body-only collision has coverageStrong 0 and coverage ~0.3 → gated to
  // alsoMatched. Both floors are absolute + scale-invariant (see their docs).
  // The gate is a cross-child FAIRNESS mechanism: it stops a weak body-token
  // collision in one repo from federating beside another repo's genuine hits.
  // An explicit `--in <child>` removes all cross-child competition — the caller
  // has already chosen the scope — so the gate must NOT apply there, or the
  // `also matched: <child> — narrow with --in <child>` hint would lead to an
  // empty result for exactly the weak child it points at. With `onlyChild` set,
  // every run (there is at most one) survives, matching a standalone child ask.
  const gatedOut: { scope: string; bestId: string }[] = [];
  const survivors: ChildRun[] = [];
  for (const run of runs) {
    if (onlyChild || run.coverageStrong >= STRONG_FLOOR || run.coverage >= HIGH_FLOOR) survivors.push(run);
    else gatedOut.push({ scope: run.child, bestId: prefixPointer(run.child, run.hits[0].pointer) });
  }

  // Fuse the survivors' scope lists (within-child fusion is left untouched —
  // each child already ran its own per-scope RRF).
  const docs: ScopedDoc[] = [];
  const back = new Map<string, { child: string; hit: AskHit }>();
  for (const { child, hits } of survivors) {
    hits.forEach((hit, i) => {
      const scope = hit.scope ? `${child}/${hit.scope}` : child;
      const id = `${child} ${i}`;
      docs.push({ id, scope, score: hit.score });
      back.set(id, { child, hit });
    });
  }

  const fused = fuseScopes(docs);
  const hits: AskHit[] = fused.ranked.slice(0, limit).map((rd) => {
    const { child, hit } = back.get(rd.id)!;
    return { ...hit, score: rd.score, scope: rd.scope, pointer: prefixPointer(child, hit.pointer) };
  });

  const alsoMatched = [...fused.alsoMatched, ...gatedOut];
  const note = coverageNote(wg);
  const result: AskResult = { query, mode: hits.length ? "lexical" : "empty", hits };
  if (hits.length) {
    const federated = fused.federated.length ? fused.federated : [...new Set(hits.map((h) => h.scope!))];
    result.scopes = { federated, alsoMatched };
  } else {
    result.note = `no matching nodes across ${wg.loaded.length} workspace repo(s) — try different words, or \`graft build\` at a child`;
  }
  if (note) result.note = result.note ? `${result.note}\n${note}` : note;
  return result;
}

/** Merge every child's `GrepResult` into one, prefixing group paths with the
 * child dir and re-sorting by coupling (inDegree desc, path asc) across repos.
 * In-degree stays each child's own — it comes from that child's graph. */
export function federateGrep(
  root: string,
  override: string | undefined,
  pattern: string,
  opts: { ignoreCase?: boolean; fixed?: boolean } = {},
): { result: GrepResult; coverage: string } {
  const wg = loadWorkspaceGraphs(root, override);
  const groups: GrepGroup[] = [];
  let filesSearched = 0;
  let totalHits = 0;
  const truncated = { files: 0, hits: 0 };
  let savedFiles = 0;
  let savedChars = 0;

  for (const { child, graph } of wg.loaded) {
    const r = grepGraph(graph, join(root, child), pattern, {
      ignoreCase: opts.ignoreCase,
      fixed: opts.fixed,
    });
    filesSearched += r.filesSearched;
    totalHits += r.totalHits;
    truncated.files += r.truncated.files;
    truncated.hits += r.truncated.hits;
    if (r.saved) {
      savedFiles += r.saved.files;
      savedChars += r.saved.baselineChars;
    }
    for (const g of r.groups) {
      groups.push({
        ...g,
        path: `${child}/${g.path}`,
        symbol: g.symbol ? { ...g.symbol, path: `${child}/${g.symbol.path}` } : null,
      });
    }
  }

  groups.sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
  const saved: Savings | undefined = savedChars > 0 ? { files: savedFiles, baselineChars: savedChars } : undefined;
  const result: GrepResult = { pattern, filesSearched, totalHits, groups, truncated, saved };
  return { result, coverage: coverageNote(wg) };
}

/** One `graft map` section per child (each child's own map, budget split evenly
 * across the loaded children), joined under `<child>/` headers. */
export function federateMap(
  root: string,
  override: string | undefined,
  opts: { maxDirs?: number } = {},
): string {
  const wg = loadWorkspaceGraphs(root, override);
  const perChild = opts.maxDirs !== undefined && wg.loaded.length > 0
    ? Math.max(1, Math.floor(opts.maxDirs / wg.loaded.length))
    : undefined;

  const sections = wg.loaded.map(({ child, graph }) => {
    const map = buildRepoMap(graph, perChild !== undefined ? { maxDirs: perChild } : {});
    return `## ${child}/\n${formatRepoMap(map).trimEnd()}`;
  });
  const head = `workspace map — ${wg.loaded.length} repo(s)`;
  const parts = [head, "", sections.join("\n\n")];
  const cov = coverageNote(wg);
  if (cov) parts.push("", cov);
  return parts.join("\n") + "\n";
}

/** Per-child drift status. `ok` is false when any BUILT child is stale — an
 * unbuilt child is surfaced (coverage), never a failure. */
export async function federateCheck(
  root: string,
  override?: string,
): Promise<{ text: string; ok: boolean }> {
  const wg = loadWorkspaceGraphs(root, override);
  const lines = [`workspace check — ${wg.loaded.length + wg.missing.length} repo(s)`, ""];
  let ok = true;
  for (const { child } of wg.loaded) {
    const g = await checkGraph(join(root, child));
    if (g.ok) {
      lines.push(`${child}/: OK`);
    } else {
      ok = false;
      const bits: string[] = [];
      if (g.added.length) bits.push(`${g.added.length} added`);
      if (g.removed.length) bits.push(`${g.removed.length} removed`);
      if (g.changed.length) bits.push(`${g.changed.length} changed`);
      if (g.stale.length) bits.push(`${g.stale.length} stale`);
      lines.push(`${child}/: STALE (${bits.join(", ")})`);
    }
  }
  for (const child of wg.missing) lines.push(`${child}/: not built (run graft build)`);
  const cov = coverageNote(wg);
  if (cov) lines.push("", cov);
  return { text: lines.join("\n") + "\n", ok };
}

/** Resolve a symbol across every child, grouped per child. Reuses the shared
 * traverse-cli formatters so each block reads exactly like `graft callers`. */
export function federateCallers(
  root: string,
  override: string | undefined,
  symbol: string,
  opts: { direction?: Direction; depth?: number; in?: string } = {},
): { text: string; found: boolean } {
  const wg = loadWorkspaceGraphs(root, override);
  const direction: Direction = opts.direction ?? "in";
  const depth = opts.depth && opts.depth >= 1 ? Math.floor(opts.depth) : 1;
  const showDepth = depth > 1;

  const blocks: string[] = [];
  let found = false;
  for (const { child, graph } of wg.loaded) {
    const matches = resolveSymbol(graph, symbol, opts.in ? { in: opts.in } : {});
    if (matches.length === 0) continue;
    found = true;
    const results = matches.map((m) => ({ symbol: m, hits: edgeWalk(graph, m, direction, depth) }));
    const lines = [`## ${child}/`];
    for (const { symbol: sym, hits } of results) {
      lines.push(headerOf(sym));
      if (hits.length === 0) lines.push(looseNoteFor(direction, sym.name, matches.length));
      else for (const h of hits) lines.push(hitLine(direction, h, showDepth));
    }
    const body = lines.join("\n");
    blocks.push(withSavings(body, callersSavings(graph, results)));
  }

  const cov = coverageNote(wg);
  if (!found) {
    const base = `no symbol "${symbol}" in any of the ${wg.loaded.length} workspace repo(s) — check spelling or run graft build`;
    return { text: cov ? `${base}\n${cov}` : base, found: false };
  }
  let text = blocks.join("\n\n");
  if (cov) text += `\n\n${cov}`;
  return { text, found: true };
}

/**
 * Split a parent into a workspace: build each git child (via the supplied
 * `buildChild` callback, so this stays free of any engine/LLM dependency),
 * then REPLACE the parent's `graft/` with just `workspace.json`. `onStart`
 * fires once — before any child is built — carrying whether this build is a
 * mega-graph migration, so the caller can print the one-time split warning
 * first, exactly as the spec requires.
 *
 * The child build writes into `<child>/graft/` and is byte-identical to
 * building that child standalone (`buildChild` is just `buildGraph(childDir)`),
 * because nothing about the parent path enters the child's build.
 */
export async function splitWorkspace(
  root: string,
  override: string | undefined,
  buildChild: (childDir: string, childName: string) => Promise<void>,
  onStart?: (info: { children: string[]; migrated: boolean }) => void,
): Promise<{ children: string[]; migrated: boolean }> {
  const children = discoverWorkspaceChildren(root).slice().sort();
  const migrated = hasMegaGraph(root, override);
  onStart?.({ children, migrated });
  for (const child of children) await buildChild(join(root, child), child);
  clearParentGraft(root, override); // drop the mega-graph/.cache/cards…
  writeWorkspace(root, { version: 1, children }, override); // …leaving ONLY workspace.json
  return { children, migrated };
}

export { formatGrepResult, zeroHitNote };
