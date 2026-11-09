/**
 * The depth tier's WASM parsers must build the graph the native addons built.
 *
 * Builds each repo twice, cold, once with every depth language on its native addon
 * (native.ts) and once on WASM (depth-parser.ts), each in its own process so
 * neither run inherits the other's warm JIT, then diffs the two graphs: every node
 * (all of its fields: id, kind, path, span, signature, body_hash, ...) and every
 * edge must match. Prints one row per depth language, and the build time of each.
 *
 * Needs the native addons, which are dev dependencies only:
 *
 *   node --import tsx test/depth-parity.ts <repo> [<repo> ...]
 *
 * Exits non-zero when any graph differs. Writes nothing inside the repos: the
 * graphs go to a temp folder.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "../src/graph/build.js";
import { setDepthParsersForTest } from "../src/graph/depth-parser.js";
import { languageLabelOf } from "../src/graph/extract.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { EdgeV1, GraphV1, NodeV1 } from "../src/graph/types.js";

type Backend = "native" | "wasm";
interface Run { ms: number; contextDir: string; errors: string[]; fallback: unknown }

const SELF = fileURLToPath(import.meta.url);

/** Child mode: one cold build on one backend; prints a {@link Run} as JSON. */
async function child(backend: Backend, repo: string, contextDir: string): Promise<void> {
  setDepthParsersForTest({ backend });
  const t0 = performance.now();
  const r = await buildGraph(repo, { contextDir, reuse: false, graphOnly: true });
  const run: Run = { ms: Math.round(performance.now() - t0), contextDir, errors: r.errors, fallback: r.nativeFallback ?? null };
  process.stdout.write(`\n@@RUN@@${JSON.stringify(run)}\n`);
}

function build(backend: Backend, repo: string, scratch: string): Run {
  const contextDir = join(scratch, backend);
  const out = spawnSync(process.execPath, ["--import", "tsx", SELF, "--child", backend, repo, contextDir], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = out.stdout.split("\n").find((l) => l.startsWith("@@RUN@@"));
  if (out.status !== 0 || !line) throw new Error(`${backend} build of ${repo} failed:\n${out.stderr}`);
  return JSON.parse(line.slice("@@RUN@@".length)) as Run;
}

function readGraphJson(contextDir: string): GraphV1 {
  const g = readGraph(wiringPath(contextDir));
  if (!g) throw new Error(`no graph in ${contextDir}`);
  return g;
}

/** The node minus the meaning layer, which a Tier-1 build leaves pending anyway. */
function nodeKey(n: NodeV1): string {
  const { summary: _s, summary_state: _ss, crux: _c, ...rest } = n;
  return JSON.stringify(rest, Object.keys(rest).sort());
}
const edgeKey = (e: EdgeV1): string => JSON.stringify([e.source, e.relation, e.target, e.confidence]);

/** Depth label of the file a node or edge belongs to ("other" for every other tier). */
function labelOfPath(path: string): string {
  return languageLabelOf(path) ?? "other";
}

interface LangRow { nodes: number; edges: number; nodeDiffs: string[]; edgeDiffs: string[] }

function diff(a: GraphV1, b: GraphV1): Map<string, LangRow> {
  const rows = new Map<string, LangRow>();
  const row = (label: string): LangRow => {
    let r = rows.get(label);
    if (!r) rows.set(label, (r = { nodes: 0, edges: 0, nodeDiffs: [], edgeDiffs: [] }));
    return r;
  };
  const pathOf = new Map<string, string>();
  for (const n of [...a.nodes, ...b.nodes]) pathOf.set(n.id, n.path);
  const symmetric = <T>(xs: T[], ys: T[], key: (x: T) => string, label: (x: T) => string, pick: (r: LangRow) => string[]): void => {
    const inA = new Map(xs.map((x) => [key(x), x]));
    const inB = new Map(ys.map((y) => [key(y), y]));
    for (const [k, x] of inA) if (!inB.has(k)) pick(row(label(x))).push(`- native only: ${k}`);
    for (const [k, y] of inB) if (!inA.has(k)) pick(row(label(y))).push(`+ wasm only:   ${k}`);
  };
  for (const n of a.nodes) row(labelOfPath(n.path)).nodes++;
  for (const e of a.edges) row(labelOfPath(pathOf.get(e.source) ?? e.source)).edges++;
  symmetric(a.nodes, b.nodes, nodeKey, (n) => labelOfPath(n.path), (r) => r.nodeDiffs);
  symmetric(a.edges, b.edges, edgeKey, (e) => labelOfPath(pathOf.get(e.source) ?? e.source), (r) => r.edgeDiffs);
  return rows;
}

async function main(repos: string[]): Promise<number> {
  let failed = 0;
  console.log("| repo | language | nodes | edges | node diffs | edge diffs | native ms | wasm ms | wasm/native |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  const details: string[] = [];
  for (const repo of repos.map((r) => resolve(r))) {
    const scratch = mkdtempSync(join(tmpdir(), "depth-parity-"));
    try {
      const native = build("native", repo, scratch);
      const wasm = build("wasm", repo, scratch);
      const rows = diff(readGraphJson(native.contextDir), readGraphJson(wasm.contextDir));
      const ratio = (wasm.ms / native.ms).toFixed(2);
      for (const [label, r] of [...rows].sort(([x], [y]) => x.localeCompare(y))) {
        if (label === "other") continue;
        const bad = r.nodeDiffs.length + r.edgeDiffs.length;
        if (bad > 0) failed++;
        console.log(`| ${basename(repo)} | ${label} | ${r.nodes} | ${r.edges} | ${r.nodeDiffs.length} | ${r.edgeDiffs.length} | ${native.ms} | ${wasm.ms} | ${ratio}${Number(ratio) > 2 ? " ⚠" : ""} |`);
        if (bad > 0) details.push(`## ${basename(repo)} ${label}`, ...r.nodeDiffs.slice(0, 20), ...r.edgeDiffs.slice(0, 20));
      }
      const other = rows.get("other");
      if (other && other.nodeDiffs.length + other.edgeDiffs.length > 0) {
        failed++;
        details.push(`## ${basename(repo)} other tiers`, ...other.nodeDiffs.slice(0, 20), ...other.edgeDiffs.slice(0, 20));
      }
      for (const [backend, run] of [["native", native], ["wasm", wasm]] as const) {
        if (run.errors.length > 0) details.push(`## ${basename(repo)} ${backend} build errors`, ...run.errors.slice(0, 20));
        if (run.fallback) details.push(`## ${basename(repo)} ${backend} fell back: ${JSON.stringify(run.fallback)}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (details.length > 0) console.log(`\n${details.join("\n")}`);
  return failed;
}

const argv = process.argv.slice(2);
if (argv[0] === "--child") {
  await child(argv[1] as Backend, argv[2]!, argv[3]!);
} else if (argv.length === 0) {
  console.error("usage: node --import tsx test/depth-parity.ts <repo> [<repo> ...]");
  process.exitCode = 2;
} else {
  process.exitCode = (await main(argv)) > 0 ? 1 : 0;
}
