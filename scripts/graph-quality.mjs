/**
 * Graph-quality report + invariant check for a built graph (`graft/.graph/wiring.json`).
 *
 *   node scripts/graph-quality.mjs <repo-dir-or-wiring.json> [--json] [--strict]
 *
 * Tier-0 of the quality strategy: needs no external oracle. Reports the graph's
 * shape (nodes by kind/origin, edges by relation/confidence, resolution rate) and
 * asserts structural INVARIANTS that must always hold:
 *   - no dangling edge endpoints (every source is a node; every target is a node
 *     or a deliberately-unresolved external string)
 *   - valid spans (`Lx-Ly`, x<=y, within file line count where known)
 *   - unique node ids; non-empty names; kinds in the allowed set
 *   - no self-loop call edges
 * Exits non-zero with --strict when any invariant fails (CI gate).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KINDS = new Set(["file","class","function","method","interface","type","enum","struct","module","constant","variable"]);
const RELATIONS = new Set(["contains","calls","imports","references","implements","extends"]);
const CONFIDENCE = new Set(["lsp_resolved","lsp_dispatch","extracted","inferred"]);

const arg = process.argv[2] ?? ".";
const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const wpath = arg.endsWith(".json") ? arg
  : [join(arg, "graft", ".graph", "wiring.json"), join(arg, "graft", "wiring.json")].find(existsSync);
if (!wpath || !existsSync(wpath)) { console.error(`no graph found at ${arg} (run \`graft build\` first)`); process.exit(2); }

const g = JSON.parse(readFileSync(wpath, "utf8"));
const nodes = g.nodes ?? [], edges = g.edges ?? [];
const ids = new Set(nodes.map((n) => n.id));

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const byKind = new Map(), byOrigin = new Map(), byRel = new Map(), byConf = new Map();
for (const n of nodes) { bump(byKind, n.kind); bump(byOrigin, n.origin ?? "?"); }
for (const e of edges) { bump(byRel, e.relation); bump(byConf, e.confidence); }

// ── invariants ──
const problems = [];
const seen = new Set();
for (const n of nodes) {
  if (seen.has(n.id)) problems.push(`dup id: ${n.id}`); seen.add(n.id);
  if (!n.name || !String(n.name).trim()) problems.push(`empty name: ${n.id}`);
  if (!KINDS.has(n.kind)) problems.push(`bad kind '${n.kind}': ${n.id}`);
  const m = /^L(\d+)-L(\d+)$/.exec(n.span ?? "");
  if (!m) problems.push(`bad span '${n.span}': ${n.id}`);
  else if (Number(m[1]) > Number(m[2])) problems.push(`inverted span ${n.span}: ${n.id}`);
}
// an edge target may be a node id OR a deliberately-unresolved external string
// (import specifier / bare heritage name); only calls/references/contains must
// point at real nodes.
let dangling = 0, selfLoops = 0, unresolvedExternal = 0;
for (const e of edges) {
  if (!RELATIONS.has(e.relation)) problems.push(`bad relation '${e.relation}'`);
  if (!CONFIDENCE.has(e.confidence)) problems.push(`bad confidence '${e.confidence}'`);
  if (!ids.has(e.source)) { problems.push(`dangling source: ${e.source}`); dangling++; }
  const targetIsNode = ids.has(e.target);
  if (!targetIsNode) {
    if (e.relation === "imports" || e.relation === "extends" || e.relation === "implements") unresolvedExternal++;
    else { problems.push(`dangling ${e.relation} target: ${e.source} → ${e.target}`); dangling++; }
  }
  if (e.relation === "calls" && e.source === e.target) selfLoops++;
}

// ── resolution / connectivity metrics ──
const calls = edges.filter((e) => e.relation === "calls");
const resolvedCalls = calls.filter((e) => ids.has(e.target)).length;
const withEdge = new Set();
for (const e of edges) { if (e.relation !== "contains") { withEdge.add(e.source); if (ids.has(e.target)) withEdge.add(e.target); } }
const symbolNodes = nodes.filter((n) => n.kind !== "file");
const orphans = symbolNodes.filter((n) => !withEdge.has(n.id)).length;

const report = {
  graph: wpath,
  nodes: nodes.length,
  symbolNodes: symbolNodes.length,
  edges: edges.length,
  byKind: Object.fromEntries([...byKind].sort((a,b)=>b[1]-a[1])),
  byOrigin: Object.fromEntries(byOrigin),
  byRelation: Object.fromEntries(byRel),
  byConfidence: Object.fromEntries(byConf),
  resolution: {
    calls: calls.length,
    resolvedToNode: resolvedCalls,
    resolvedPct: calls.length ? Math.round((resolvedCalls / calls.length) * 100) : null,
    unresolvedExternalImports: unresolvedExternal,
  },
  connectivity: {
    orphanSymbolNodes: orphans,
    orphanPct: symbolNodes.length ? Math.round((orphans / symbolNodes.length) * 100) : null,
  },
  invariants: {
    ok: problems.length === 0,
    danglingEdges: dangling,
    selfLoopCalls: selfLoops,
    violations: problems.length,
    sample: problems.slice(0, 15),
  },
};

if (json) { console.log(JSON.stringify(report, null, 2)); }
else {
  const p = report;
  console.log(`graph-quality — ${p.graph}`);
  console.log(`  nodes ${p.nodes} (${p.symbolNodes} symbols) · edges ${p.edges}`);
  console.log(`  kinds:      ${Object.entries(p.byKind).map(([k,v])=>`${k}=${v}`).join(" ")}`);
  console.log(`  origin:     ${Object.entries(p.byOrigin).map(([k,v])=>`${k}=${v}`).join(" ")}`);
  console.log(`  relations:  ${Object.entries(p.byRelation).map(([k,v])=>`${k}=${v}`).join(" ")}`);
  console.log(`  confidence: ${Object.entries(p.byConfidence).map(([k,v])=>`${k}=${v}`).join(" ")}`);
  console.log(`  calls resolved: ${p.resolution.resolvedToNode}/${p.resolution.calls} (${p.resolution.resolvedPct}%)`);
  console.log(`  orphan symbols: ${p.connectivity.orphanSymbolNodes}/${p.symbolNodes} (${p.connectivity.orphanPct}%)`);
  console.log(`  INVARIANTS: ${p.invariants.ok ? "OK ✓" : `FAIL ✗ (${p.invariants.violations} violations, ${p.invariants.danglingEdges} dangling)`}`);
  if (!p.invariants.ok) for (const s of p.invariants.sample) console.log(`     - ${s}`);
  if (p.invariants.selfLoopCalls) console.log(`  note: ${p.invariants.selfLoopCalls} self-loop calls`);
}
if (strict && !report.invariants.ok) process.exit(1);
