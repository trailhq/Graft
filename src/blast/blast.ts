/**
 * Blast radius of a diff: what else in the repo depends on the lines this change
 * touched.
 *
 * The whole command is a join between two things graft already has — git's changed
 * line ranges (`diff.ts`) and the wiring graph's incoming edges (`traverse.ts`) —
 * so there is no new graph logic here, only the seeding rule:
 *
 *   changed line → the innermost symbol whose span contains it → seed
 *
 * Seeding by SYMBOL rather than by file is what makes the answer worth reading: a
 * 400-line file with a one-line edit reports the dependents of that one function,
 * not of everything the file happens to define. The file node is seeded too, so
 * importers (whose edge targets the file, not the symbol) are still found.
 */
import { impactOfMany, type EdgeHit } from "../graph/traverse.js";
import type { GraphV1, NodeV1 } from "../graph/types.js";
import { dirLabel, moduleIndex, parentDir, shortLabel, type ModuleIndex } from "./modules.js";
import type { ChangedFile } from "./diff.js";

const SPAN_RE = /^L(\d+)-L(\d+)$/;

export interface BlastOptions {
  /** BFS depth over incoming edges; `Infinity` for the full closure. */
  depth: number;
  /** Concept/directory labels. Built from the context dir when omitted. */
  modules?: ModuleIndex;
}

/** A changed symbol the walk started from. */
export interface Seed {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  /** True for a whole-file seed (an added file, or a change outside any symbol). */
  wholeFile: boolean;
}

/** One dependent symbol, and how the walk reached it. */
export interface Impacted {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  relation: string;
  depth: number;
}

/**
 * Where a cluster's label came from — the rungs of the naming ladder.
 *
 * `concept` — a concept node from a `--deep` build claims every file in the cluster.
 * `named`   — `graft blast --name` asked a model to name this cluster (see name.ts).
 * `symbol`  — the deterministic backstop: the cluster's most significant symbol.
 *
 * A bare directory is never a label. The whole point of the picture is that a
 * reviewer reads what is affected, and `src/graph/` tells them nothing they could
 * not get from the diff — but it must never be replaced by a guess either, so the
 * backstop names a real symbol rather than inventing a feature name.
 */
export type LabelSource = "concept" | "named" | "symbol";

/** Dependents grouped for the diagram: the unit a reviewer actually thinks in. */
export interface ImpactedModule {
  label: string;
  labelSource: LabelSource;
  /** Stable identity for the cluster, independent of its label: the concept name
   * or the directory it was grouped by. Naming and its cache key hang off this. */
  key: string;
  files: string[];
  symbols: Impacted[];
  /** Changed files whose edges reached this module — the diagram's arrows. */
  from: string[];
}

/**
 * Whether the diff brought its tests along.
 *
 * `changed` — a test file that reaches this area was edited in this PR.
 * `stale`   — tests reach it and the diff left every one of them alone.
 * `none`    — nothing under `test/` reaches it at all.
 * `na`      — no function, method or class changed here, so there is nothing to
 *             ask the question of: a types-only file, or config and wiring.
 */
export type TestSignal = "changed" | "stale" | "none" | "na";

/** One area of the diff: the changed files a reviewer thinks of as one thing. */
export interface ChangedArea {
  label: string;
  labelSource: LabelSource;
  /** The directory the cluster was grouped by — see {@link ImpactedModule.key}. */
  key: string;
  /** Changed, indexed, non-test files grouped under this label. */
  files: string[];
  /** Changed symbols seeded from those files. */
  seeds: number;
  tests: TestSignal;
  /** Test files with an edge into this area, and those of them the diff changed. */
  testFiles: string[];
  changedTestFiles: string[];
  /** Test reach, over the area's exported functions/methods/classes only. */
  reached: number;
  behavioural: number;
  /** Names of the behavioural symbols no test reaches, for the collapsed detail. */
  unreached: string[];
  /** Changed symbol names, behaviour first — the backstop label and the naming
   * prompt both read from this. */
  seedNames: string[];
}

export interface BlastReport {
  basis: string;
  depth: number;
  changed: ChangedFile[];
  /** Changed paths the graph has no node for: unsupported language, or deleted. */
  unindexed: string[];
  /** Changed paths that were deleted, called out because their dependents are
   * unknowable from a graph built at the post-change commit. */
  deleted: string[];
  seeds: Seed[];
  impacted: Impacted[];
  modules: ImpactedModule[];
  /** The diff itself, grouped: the left-hand side of the diagram. */
  areas: ChangedArea[];
  /** Test-only dependents, kept out of `modules` so they cannot crowd it out. */
  testModules: ImpactedModule[];
}

function spanBounds(span: string): { start: number; end: number } | null {
  const m = SPAN_RE.exec(span);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/**
 * The innermost symbols whose spans overlap any changed range in `path`.
 *
 * "Innermost" matters for a method: a changed line inside `Cache.get` overlaps both
 * the class span and the method span, and seeding the class would report everyone
 * who touches any part of `Cache`. Nesting is resolved by keeping, for each range,
 * only symbols that contain no other matched symbol.
 */
function seedsForFile(graph: GraphV1, path: string, ranges: { start: number; end: number }[]): NodeV1[] {
  const symbols: { node: NodeV1; start: number; end: number }[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "file" || n.path !== path) continue;
    const b = spanBounds(n.span);
    if (b) symbols.push({ node: n, ...b });
  }
  if (symbols.length === 0) return [];

  const hit = new Map<string, NodeV1>();
  for (const r of ranges) {
    const overlapping = symbols.filter((s) => s.start <= r.end && s.end >= r.start);
    // Drop any symbol that strictly contains another overlapping one (the class
    // around a changed method), keeping the tightest description of the edit.
    for (const s of overlapping) {
      const containsAnother = overlapping.some(
        (o) => o !== s && o.start >= s.start && o.end <= s.end,
      );
      if (!containsAnother) hit.set(s.node.id, s.node);
    }
  }
  return [...hit.values()];
}

/** Compute the blast radius of `changed` against `graph`. */
export function blastRadius(
  graph: GraphV1,
  changed: ChangedFile[],
  basis: string,
  opts: BlastOptions,
): BlastReport {
  const fileNodes = new Map<string, NodeV1>();
  for (const n of graph.nodes) if (n.kind === "file") fileNodes.set(n.path, n);

  const seeds: Seed[] = [];
  const unindexed: string[] = [];
  const deleted: string[] = [];
  /** Seed nodes per changed file, kept for the area grouping and the test signal. */
  const seedNodes = new Map<string, NodeV1[]>();
  /** Merged dependents, keyed by node id, at the shallowest depth any file reached
   * them — plus which changed files did the reaching. */
  const merged = new Map<string, { hit: Impacted; from: Set<string> }>();

  for (const file of changed) {
    if (file.status === "deleted") {
      deleted.push(file.path);
      continue;
    }
    const fileNode = fileNodes.get(file.path);
    if (!fileNode) {
      unindexed.push(file.path);
      continue;
    }

    // No hunk ranges (a rename with no content change, a mode change) or an added
    // file: the unit of change is the file itself.
    const symbolSeeds = file.ranges.length > 0 ? seedsForFile(graph, file.path, file.ranges) : [];
    for (const node of symbolSeeds) {
      seeds.push({ id: node.id, name: node.name, kind: node.kind, path: node.path, span: node.span, wholeFile: false });
    }
    if (symbolSeeds.length === 0) {
      seeds.push({
        id: fileNode.id, name: fileNode.name, kind: fileNode.kind,
        path: fileNode.path, span: fileNode.span, wholeFile: true,
      });
    }

    // One walk PER CHANGED FILE, not one walk over every seed at once. A combined
    // walk records the depth a node was first reached at but not by which seed, so
    // the diagram could only draw "every changed file reaches every module" — a
    // cross-product that tells a reviewer nothing. Walking per file costs one
    // adjacency build each (cheap: the graph is already in memory) and buys arrows
    // that are true.
    //
    // The FILE node is a seed only when no symbol matched. `imports` edges target
    // the file id, so seeding it alongside symbols would pull in every importer of
    // the file — a one-line edit to one function would report every module that
    // imports the module, which is the noise this command exists to avoid. With no
    // symbol seeds (a change to a top-level constant, a new import, a file with no
    // extracted symbols) the file IS the unit of change, and its importers are the
    // only dependents there are.
    const walkSeeds = symbolSeeds.length > 0 ? symbolSeeds : [fileNode];
    seedNodes.set(file.path, walkSeeds);
    const hits = impactOfMany(graph, walkSeeds, opts.depth, "in");
    for (const h of hits) {
      if (!hasNode(h)) continue;
      const hit = toImpacted(h);
      const prev = merged.get(hit.id);
      if (!prev) merged.set(hit.id, { hit, from: new Set([file.path]) });
      else {
        prev.from.add(file.path);
        // Keep the shallowest reach: a symbol two hops from one changed file and one
        // hop from another is one hop away from this PR.
        if (hit.depth < prev.hit.depth) prev.hit = hit;
      }
    }
  }

  const impacted = [...merged.values()].map((m) => m.hit);
  const origins = new Map([...merged].map(([id, m]) => [id, m.from]));
  const index = opts.modules ?? emptyIndex();
  const grouped = groupByModule(impacted, changed, origins, index);

  return {
    basis,
    depth: opts.depth,
    changed,
    unindexed,
    deleted,
    seeds,
    impacted,
    modules: grouped.modules,
    testModules: grouped.testModules,
    areas: changedAreas(graph, changed, seedNodes, index, grouped.modules),
  };
}

/**
 * Group the changed files into areas, and work out whether each one's tests moved.
 *
 * The diff's own side of the diagram used to be one box per changed file, which can
 * never fit: a 24-file PR drew ten arbitrary paths. Grouped by the same concept
 * labels the dependents use, the same PR is three or four circles — and once the
 * files are grouped, "did a test that reaches this move too?" is one question per
 * circle instead of per file.
 */
function changedAreas(
  graph: GraphV1,
  changed: ChangedFile[],
  seedNodes: Map<string, NodeV1[]>,
  index: ModuleIndex,
  modules: ImpactedModule[],
): ChangedArea[] {
  const changedTests = new Set(changed.filter((c) => TEST_PATH.test(c.path)).map((c) => c.path));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  /** How many edges point AT each node — how central it is in the graph. */
  const inDegree = new Map<string, number>();
  for (const e of graph.edges) inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  /** Incoming edge sources per node id, resolved to the source's file path. */
  const incoming = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    const path = nodeById.get(e.source)?.path;
    if (!path || !TEST_PATH.test(path)) continue;
    const at = incoming.get(e.target) ?? new Set<string>();
    at.add(path);
    incoming.set(e.target, at);
  }

  // Group by DIRECTORY, not by concept. Concepts in a well-summarised repo are
  // near-file-grained — graft's own PR produced nine of them, one file each — so
  // grouping the diff by concept groups nothing: the left side was nine circles
  // with near-identical truncated names. A directory is the coarser unit reviewers
  // already use, and a concept name is only worth borrowing when one concept
  // happens to claim the whole group.
  const groups = new Map<string, string[]>();
  for (const path of seedNodes.keys()) {
    // A changed test file is the signal, not the source of a blast radius. Drawing
    // it as an area would put "your tests changed" on both sides of the arrow.
    if (TEST_PATH.test(path)) continue;
    const dir = dirLabel(path);
    groups.set(dir, [...(groups.get(dir) ?? []), path]);
  }
  coarsen(groups, MAX_AREAS);

  const byKey = new Map<string, ChangedArea>();
  /** Hub candidates per area, ranked once every seed has been seen. */
  const candidates = new Map<ChangedArea, { name: string; behavioural: boolean; degree: number }[]>();
  for (const [dir, paths] of groups) {
    const area: ChangedArea = {
      label: dir, labelSource: "symbol", key: dir,
      files: [], seeds: 0, tests: "none", testFiles: [], changedTestFiles: [],
      reached: 0, behavioural: 0, unreached: [], seedNames: [],
    };
    byKey.set(dir, area);
    for (const path of paths) {
      const nodes = seedNodes.get(path) ?? [];
      area.files.push(path);
      area.seeds += nodes.length;

      for (const node of nodes) {
        // Reach is measured over behaviour only. Counting interfaces and type aliases
        // would sink every ratio: nothing "calls" a type, so a fully tested area of
        // typed code would report a third of its symbols as unreached.
        const behavioural = node.kind === "function" || node.kind === "method" || node.kind === "class";
        const from = incoming.get(node.id) ?? new Set<string>();
        for (const t of from) {
          if (!area.testFiles.includes(t)) area.testFiles.push(t);
          if (changedTests.has(t) && !area.changedTestFiles.includes(t)) area.changedTestFiles.push(t);
        }
        candidates.set(area, [
          ...(candidates.get(area) ?? []),
          { name: node.name, behavioural, degree: inDegree.get(node.id) ?? 0 },
        ]);
        if (!behavioural) continue;
        area.behavioural++;
        if (from.size > 0) area.reached++;
        else area.unreached.push(node.name);
      }
    }
  }

  for (const area of byKey.values()) {
    // The hub is the most-depended-on function in the area, not whichever symbol the
    // file walk happened to end on: `LlmFailureGate` rather than `transportRetries`.
    // Behaviour outranks types, since nothing calls an interface.
    area.seedNames = (candidates.get(area) ?? [])
      .sort((a, b) =>
        Number(b.behavioural) - Number(a.behavioural) || b.degree - a.degree || a.name.localeCompare(b.name))
      .map((c) => c.name);
    const concept = sharedConcept(area.files, index);
    area.label = concept ?? hubLabel(area.seedNames, area.key);
    area.labelSource = concept ? "concept" : "symbol";
    area.files.sort();
    area.testFiles.sort();
    area.changedTestFiles.sort();
    area.tests =
      area.behavioural === 0 ? "na"
      : area.changedTestFiles.length > 0 ? "changed"
      : area.testFiles.length > 0 ? "stale"
      : "none";
  }

  // Ordered by how much each area actually reaches, because the diagram caps this
  // list and folds the rest into one circle. Ordered by size instead, the fold ends
  // up holding the best-connected areas and the tail circle collects every arrow —
  // the same mistake, one level up, as capping changed FILES in diff order.
  const reach = (a: ChangedArea) =>
    modules.filter((m) => m.from.some((f) => a.files.includes(f))).length;
  return [...byKey.values()].sort(
    (a, b) => reach(b) - reach(a) || b.files.length - a.files.length || a.label.localeCompare(b.label),
  );
}

/** Convenience wrapper: build the module index from a context dir. */
export function blastRadiusIn(
  graph: GraphV1,
  contextDir: string,
  changed: ChangedFile[],
  basis: string,
  depth: number,
): BlastReport {
  return blastRadius(graph, changed, basis, { depth, modules: moduleIndex(contextDir) });
}

function hasNode(h: EdgeHit): h is EdgeHit & { node: NodeV1 } {
  // Unresolved endpoints (an import module string no node exists for) carry no
  // location, so they can neither be grouped nor opened — dropped rather than
  // rendered as a box with no file behind it.
  return h.node !== null;
}

function toImpacted(h: EdgeHit & { node: NodeV1 }): Impacted {
  return {
    id: h.node.id, name: h.node.name, kind: h.node.kind,
    path: h.node.path, span: h.node.span, relation: h.relation, depth: h.depth,
  };
}

function emptyIndex(): ModuleIndex {
  return { hasConcepts: false, labelOf: (p) => p, conceptOf: () => null };
}

/**
 * The concept claiming EVERY file in a cluster, or null when they disagree.
 *
 * Unanimity is the point: a concept that covers three of five files describes
 * something narrower than the cluster, and stamping its name on the whole thing is
 * how a diagram starts lying about what it drew.
 */
function sharedConcept(paths: string[], index: ModuleIndex): string | null {
  const concepts = new Set(paths.map((p) => index.conceptOf(p)));
  const [only] = concepts;
  return concepts.size === 1 && only ? shortLabel(only) : null;
}

/**
 * The deterministic backstop label: the cluster's most significant symbol.
 *
 * Reached with no concept, no cache and no API key, so this is what guarantees a
 * circle never carries a bare directory. It is a fact rather than a guess — the
 * reviewer can grep the name — which is why it beats borrowing a neighbouring
 * concept: on graft's own graph that borrowing labelled the freshness gate
 * "Graph Extraction and Loading", which misleads worse than any path.
 */
export function hubLabel(names: string[], fallback: string): string {
  const [head] = names.filter(Boolean);
  // The hub alone, with no "+8" tail: how many symbols came with it is already the
  // circle's second line and the table's own column, and repeating it in the label
  // turned "writeGraph" into "writeGraph +8", which reads as a version number.
  return head ? shortLabel(head) : fallback;
}

/**
 * Group dependents into modules. `origins` carries, per dependent, the changed
 * files whose walk actually reached it — so a module's `from` is the real arrow
 * set, not every changed file in the PR.
 */
function groupByModule(
  impacted: Impacted[],
  changed: ChangedFile[],
  origins: Map<string, Set<string>>,
  modules: ModuleIndex,
): { modules: ImpactedModule[]; testModules: ImpactedModule[] } {
  const changedPaths = new Set(changed.map((c) => c.path));
  const byKey = new Map<string, ImpactedModule>();

  for (const hit of impacted) {
    // A dependent inside a file the PR already changes is not "reach" — it is the
    // diff. Reviewers see it in the diff itself; repeating it as blast radius is
    // what makes these comments feel like noise.
    if (changedPaths.has(hit.path)) continue;
    // Cluster by concept where one exists, else by directory. Clustering and
    // LABELLING are separate steps now: the key only has to be stable, while the
    // label goes through the ladder below and may end up naming a symbol.
    const key = modules.conceptOf(hit.path) ?? dirLabel(hit.path);
    let mod = byKey.get(key);
    if (!mod) {
      mod = { label: key, labelSource: "symbol", key, files: [], symbols: [], from: [] };
      byKey.set(key, mod);
    }
    mod.symbols.push(hit);
    if (!mod.files.includes(hit.path)) mod.files.push(hit.path);
  }

  for (const mod of byKey.values()) {
    const from = new Set<string>();
    for (const s of mod.symbols) for (const p of origins.get(s.id) ?? []) from.add(p);
    mod.from = [...from].sort();
    mod.files.sort();
    mod.symbols.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    // Shallowest symbol first after that sort, so it is the cluster's hub: the
    // thing one hop from the diff rather than an arbitrary member.
    const concept = sharedConcept(mod.files, modules);
    mod.label = concept ?? hubLabel(mod.symbols.map((s) => s.name), mod.key);
    mod.labelSource = concept ? "concept" : "symbol";
  }

  // Test-only modules are separated, not just sorted last. On a repo with a test
  // per module they are the majority of the graph's dependents — graft's own 24-file
  // PR produced 31 modules, 24 of them a single test file — so leaving them in the
  // same list means they crowd out every module a reviewer needs whatever the caps
  // are. "Your tests reference the thing you changed" is one line, not 24 sections.
  const bySize = (a: ImpactedModule, b: ImpactedModule) =>
    b.symbols.length - a.symbols.length || a.label.localeCompare(b.label);
  const all = [...byKey.values()];
  return {
    modules: all.filter((m) => !isTestOnly(m)).sort(bySize),
    testModules: all.filter(isTestOnly).sort(bySize),
  };
}

/**
 * Directory groups the diff is folded down to before anything is drawn.
 *
 * Kept here rather than in the renderer because it is a statement about the diff,
 * not about the picture: five areas is roughly what a reviewer holds in their head,
 * and the renderer then draws all of them.
 */
const MAX_AREAS = 5;

/**
 * Fold directory groups into their parents until there are at most `max`.
 *
 * The deepest group goes first, and only into a parent that already exists, so
 * `src/ai/llm/` joins `src/ai/` rather than everything collapsing towards the repo
 * root. When no group has an existing parent, one is created — but never at the top
 * level, since a single `(root)` area is no grouping at all.
 */
function coarsen(groups: Map<string, string[]>, max: number): void {
  const depth = (dir: string) => dir.split("/").length;
  while (groups.size > max) {
    const keys = [...groups.keys()].sort((a, b) => depth(b) - depth(a) || (groups.get(a)!.length - groups.get(b)!.length));
    const pick =
      keys.find((k) => groups.has(parentDir(k)) && parentDir(k) !== "") ??
      keys.find((k) => parentDir(k) !== "");
    if (!pick) return;
    const parent = parentDir(pick);
    groups.set(parent, [...(groups.get(parent) ?? []), ...groups.get(pick)!]);
    groups.delete(pick);
  }
}

const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$/i;

/** True when every file in the module is a test file. */
function isTestOnly(mod: ImpactedModule): boolean {
  return mod.files.length > 0 && mod.files.every((f) => TEST_PATH.test(f));
}
