/**
 * The blast radius as a graph the viewer can draw — the hosted half of the PR
 * comment.
 *
 * The comment can hold about five circles before it stops being readable, and it
 * can never answer the reviewer's next question: which symbols, at which lines,
 * and what did they actually become. `graft viz --export` already produces a
 * self-contained page, but its Context tab is assembled from the deep tier's
 * concept files, which the PR path deliberately no longer builds — so on a
 * structural build that tab held a single INDEX dot.
 *
 * This closes that gap with no new data and no LLM pass: `blast` has already
 * clustered both sides of the diff and named them (cached, one call), so the same
 * report is emitted here as {@link VizGraph} — amber node per changed area, blue
 * node per affected area, one edge per attribution the walk actually recorded.
 *
 * Each node also carries {@link Evidence}: the changed side shows its hunks, the
 * affected side shows the line that reaches the diff. Both come from data already
 * on hand — git's patch, and the file on disk — so the panel costs nothing.
 */
import type { Evidence, VizEdge, VizGraph, VizNode } from "../viz/assemble.js";
import type { BlastReport, ChangedArea, ImpactedModule, Seed, TestSignal } from "./blast.js";
import type { ChangedFile } from "./diff.js";
import {
  MAX_EVIDENCE,
  type ReachTerms,
  fileReader,
  impactedEvidence,
  reachTerms,
  seedEvidence,
} from "./evidence.js";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Kinds that carry behaviour — what "did a test reach it" is asked of. */
const BEHAVIOURAL = new Set(["function", "method", "class", "constructor"]);

/** Node-type names, which double as the viewer's legend labels. */
const CHANGED = "changed";
const AFFECTED = "affected";

/** One sentence about the tests, rather than the two that used to say it twice. */
function testNote(a: ChangedArea): string {
  const signals: Record<TestSignal, string> = {
    changed: `A test that reaches it changed too — ${a.reached} of ${plural(a.behavioural, "function")} covered.`,
    stale: `Tests reach it, and this diff left all ${plural(a.testFiles.length, "of them", "of them")} alone.`,
    none: "No test reaches this code.",
    na: "No function or class changed here — types, config or comments only.",
  };
  return signals[a.tests];
}

/** `a`, `a and b`, `a, b and c`, `a, b and 3 more` — never a bare `+N`, which
 * reads as a version number when it sits next to a symbol name. */
function list(names: string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const tail = rest > 0 ? `${rest} more` : shown.pop();
  return shown.length === 0 ? String(tail) : `${shown.join(", ")} and ${tail}`;
}

/**
 * What this PR did to an area, in the reviewer's words.
 *
 * The old copy counted ("2 files, 3 symbols") and then said the same thing about
 * tests twice ("no test reaches it. 0 of 2 changed functions have a test that
 * reaches them"), where `0 of 2` reads like a coverage score. Naming the symbols
 * is shorter AND the thing a reviewer wanted to know.
 */
function changedSummary(a: ChangedArea, seeds: Seed[]): string {
  const named = seeds.filter((s) => !s.wholeFile);
  const behaviour = named.filter((s) => BEHAVIOURAL.has(s.kind)).map((s) => s.name);
  const rest = named.filter((s) => !BEHAVIOURAL.has(s.kind)).map((s) => s.name);
  const where = ` in ${plural(a.files.length, "file")}.`;

  let what: string;
  if (behaviour.length > 0) {
    what = `Edits ${list(behaviour)}`;
    if (rest.length > 0) what += `, plus ${list(rest)}`;
  } else if (rest.length > 0) {
    what = `Edits ${list(rest)}`;
  } else {
    // Whole-file seeds only: an added file, or edits outside every symbol.
    what = `Changes ${plural(a.seeds, "region")} outside any symbol`;
  }
  return `${what}${where} ${testNote(a)}`;
}

function changedNode(a: ChangedArea, seeds: Seed[], byPath: Map<string, ChangedFile>): VizNode {
  const files = new Set(a.files);
  const mine = seeds.filter((s) => files.has(s.path));
  const evidence = mine
    .slice(0, MAX_EVIDENCE)
    .map((s) => seedEvidence(s, byPath.get(s.path)))
    .filter((e): e is Evidence => e !== null);

  return {
    id: `changed:${a.key}`,
    name: a.label,
    type: CHANGED,
    summary: changedSummary(a, mine),
    sources: a.files,
    evidence: evidence.length > 0 ? evidence : undefined,
  };
}

function affectedNode(
  m: ImpactedModule,
  reach: ReachTerms,
  read: (path: string) => string[] | null,
): VizNode {
  const nearest = m.symbols[0];
  const how = nearest ? ` — nearest is ${nearest.name}, ${plural(nearest.depth, "hop")} away.` : ".";
  const evidence = m.symbols
    .slice(0, MAX_EVIDENCE)
    .map((s) => impactedEvidence(s, reach, read))
    .filter((e): e is Evidence => e !== null);

  return {
    id: `affected:${m.key}`,
    name: m.label,
    type: AFFECTED,
    // Leading with "not edited" is the fact a reviewer needs first: this area is
    // collateral, not part of their diff.
    summary: `Not edited by this PR. ${plural(m.symbols.length, "symbol")} here ${m.symbols.length === 1 ? "reaches" : "reach"} code it changed${how}`,
    sources: m.symbols.map((s) => `${s.path} · ${s.span}`),
    evidence: evidence.length > 0 ? evidence : undefined,
  };
}

/**
 * What an empty canvas means.
 *
 * A PR that only touches lockfiles, workflows or docs has no radius, and the page
 * published for it used to be a blank canvas behind a link promising a graph — a
 * reader cannot tell that from a broken export. Naming the reason (usually: no
 * parser claims these files) turns it into an answer.
 */
function emptyNote(r: BlastReport): string {
  if (r.changed.length === 0) return "This pull request changes no files.";
  if (r.unindexed.length === r.changed.length) {
    const shown = r.unindexed.slice(0, 3).join(", ");
    const rest = r.unindexed.length > 3 ? `, +${r.unindexed.length - 3} more` : "";
    return `Nothing to draw: no parser claims ${plural(r.unindexed.length, "changed file")} (${shown}${rest}), so this change has no symbols to trace.`;
  }
  return "Nothing to draw: the changed symbols have no resolved dependents at this depth.";
}

/**
 * Build the viewer graph for a report.
 *
 * `root` is the repository the report was taken in; without it the affected side
 * loses its snippets — there is nothing to read — but keeps everything else, which
 * is what a unit test wants.
 *
 * Nothing is capped at the graph level. The caps in the markdown renderer exist
 * because a Mermaid diagram inside a comment cannot lay out more than a handful of
 * circles; this page is force-directed and pannable, which is why it exists.
 */
export function blastVizGraph(r: BlastReport, opts: { root?: string } = {}): VizGraph {
  const byPath = new Map(r.changed.map((f) => [f.path, f]));
  // Longest name first, so `export` cannot match ahead of `exportViz` on a line
  // that contains both.
  const reach = reachTerms(r.seeds, r.changed);
  const read = fileReader(opts.root);

  const nodes: VizNode[] = [
    ...r.areas.map((a) => changedNode(a, r.seeds, byPath)),
    ...r.modules.map((m) => affectedNode(m, reach, read)),
  ];

  /** Changed path → the id of the area node standing for it. */
  const areaOf = new Map<string, string>();
  for (const a of r.areas) for (const f of a.files) areaOf.set(f, `changed:${a.key}`);

  const edges: VizEdge[] = [];
  const seen = new Set<string>();
  for (const m of r.modules) {
    for (const from of m.from) {
      const source = areaOf.get(from);
      if (!source) continue; // a changed test file: the signal, not an area
      const affected = `affected:${m.key}`;
      const key = `${affected}→${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Edge direction is the DEPENDENCY, affected → changed, not the impact. The
      // viewer words its panels "depends on" / "depended on by" from the edge, so
      // pointing it the other way made an affected area read as the thing being
      // depended upon — backwards, on the one screen a reviewer is reading closely.
      edges.push({
        source: affected,
        target: source,
        relation: "depends_on",
        description: "this area calls or imports code the PR changed",
      });
    }
  }

  return {
    meta: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      emptyNote: nodes.length === 0 ? emptyNote(r) : undefined,
      // Changed files no parser claims: named here so a thin graph is explained
      // rather than read as "this PR is safe".
      skippedFiles: r.unindexed.length,
      droppedEdges: 0,
    },
    nodes,
    edges,
  };
}
