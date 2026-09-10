/**
 * Serialize a {@link GraphV1} to `<contextDir>/.graph/wiring.json`.
 *
 * The wiring graph lives in a hidden `.graph/` subdir because it is machine-only:
 * the agent never greps or reads it — it reaches the wiring data through the
 * per-file markdown cards (grep) and the `ask` tool (edge traversal). Output is
 * sorted (nodes by id, edges by source/relation/target) and carries no
 * timestamps, so rebuilding an unchanged repo produces a byte-identical file and
 * git diffs stay minimal.
 */
import { constants as bufferConstants } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { forEachLine, openAtomic } from "../util/json-stream.js";
import type { EdgeV1, GraphV1, NodeV1 } from "./types.js";

/** Hidden subdir under the context dir that holds machine-only graph artifacts. */
export const GRAPH_DIR = ".graph";
export const GRAPH_FILE = "wiring.json";

/** Absolute path to the wiring graph for a context dir: `<dir>/.graph/wiring.json`. */
export function wiringPath(outDir: string): string {
  return join(outDir, GRAPH_DIR, GRAPH_FILE);
}

export interface ReadGraphOptions { maxStringLength?: number }

/**
 * Read an existing wiring graph for use as the Tier-2 cache. Returns null when the
 * file is absent or unparseable (a fresh build, or a corrupt file we'll replace).
 * A file over V8's string cap is walked line by line ({@link readGraphFromBuffer})
 * instead of read as one string; `opts.maxStringLength` lets a test force that path.
 */
export function readGraph(path: string, opts: ReadGraphOptions = {}): GraphV1 | null {
  let size: number;
  try { size = statSync(path).size; } catch { return null; }
  const cap = opts.maxStringLength ?? bufferConstants.MAX_STRING_LENGTH;
  if (size > cap) {
    try { return readGraphFromBuffer(readFileSync(path)); } catch { return null; }
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GraphV1;
  } catch {
    return null;
  }
}

/**
 * JSON text with every non-ASCII character as a `\uXXXX` escape; JSON.parse reads
 * back the same values. One non-ASCII character anywhere makes V8 hold a whole file,
 * read back, as a two-byte string: on assign, ~100 MB more for each process that
 * reads its 94 MB graph (every query, hook and build), and ~300 MB for the build's
 * extract cache.
 */
export function asciiJson(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Parse the line-per-element shape `writeGraph` produces without ever holding
 * the whole file as one string. Null when the buffer is not in that shape. */
export function readGraphFromBuffer(buf: Buffer): GraphV1 | null {
  const NODES_OPEN = ',"nodes":[';
  const EDGES_OPEN = '],"edges":[';
  const END = "]}";
  let meta: GraphV1["meta"] | null = null;
  const nodes: NodeV1[] = [];
  const edges: EdgeV1[] = [];
  let target: NodeV1[] | EdgeV1[] | null = null;
  let closed = false;
  let bad = false;
  forEachLine(buf, (line, i) => {
    if (bad || closed) { if (line !== "") bad = true; return; }
    try {
      if (i === 0) {
        if (!line.startsWith('{"meta":') || !line.endsWith(NODES_OPEN)) { bad = true; return; }
        meta = JSON.parse(line.slice('{"meta":'.length, line.length - NODES_OPEN.length)) as GraphV1["meta"];
        target = nodes;
        return;
      }
      if (line === EDGES_OPEN) { target = edges; return; }
      if (line === END) { closed = true; return; }
      if (target === null) { bad = true; return; }
      const body = line.endsWith(",") ? line.slice(0, -1) : line;
      (target as unknown[]).push(JSON.parse(body));
    } catch {
      bad = true;
    }
  });
  if (bad || !closed || meta === null) return null;
  return { meta, nodes, edges };
}

export function writeGraph(graph: GraphV1, outDir: string): string {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...graph.edges].sort(edgeOrder);
  const path = wiringPath(outDir);
  // Streamed, one element per line: still valid JSON for every JSON.parse reader
  // (viz/serve, the viewer, fixtures, old grafts), but a newline at each element
  // boundary lets readGraphFromBuffer walk a file over V8's string cap without
  // ever holding it as one string. Compact within a line: pretty-printing was
  // ~30% of the bytes for a file only machines read (graft/ is gitignored by
  // default), and on a 65k-file repo it was the difference between a wiring.json
  // a query can load and one over the cap. Each line goes through asciiJson, so a
  // non-ASCII character never makes a reader hold the file as a two-byte string.
  const w = openAtomic(path);
  try {
    const { nodes: _n, edges: _e, ...rest } = graph;
    const head = JSON.stringify({ ...rest, nodes: [], edges: [] }); // ends with `,"nodes":[],"edges":[]}`
    w.write(asciiJson(head.slice(0, head.length - '"nodes":[],"edges":[]}'.length)));
    w.write('"nodes":[');
    nodes.forEach((n, i) => w.write("\n" + asciiJson(JSON.stringify(stripBodyText(n))) + (i < nodes.length - 1 ? "," : "")));
    w.write('\n],"edges":[');
    edges.forEach((e, i) => w.write("\n" + asciiJson(JSON.stringify(e)) + (i < edges.length - 1 ? "," : "")));
    w.write("\n]}\n");
    w.commit();
  } catch (e) {
    w.abort();
    throw e;
  }
  return path;
}

/**
 * Drop `body_text` from the SERIALIZED copy of a node — it is ~65% of
 * wiring.json's bytes on a large graph, and every byte of it is already
 * duplicated in the `ask` sidecar (`.cache/ask-index.json`), tokenized, which
 * is the only place anything reads it from. Callers must pass this the
 * in-memory graph BEFORE this stripped copy is produced (see `build.ts`:
 * `writeAskIndex` runs on the original `graph` object, never on a re-read of
 * this slimmed file) — this function never mutates the input node.
 */
function stripBodyText(node: NodeV1): NodeV1 {
  if (node.body_text === undefined) return node;
  const { body_text: _body_text, ...rest } = node;
  return rest as NodeV1;
}

function edgeOrder(a: EdgeV1, b: EdgeV1): number {
  return (
    a.source.localeCompare(b.source) ||
    a.relation.localeCompare(b.relation) ||
    a.target.localeCompare(b.target)
  );
}
