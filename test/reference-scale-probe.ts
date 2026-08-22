/**
 * Child process for the #116 regression test in `graph-references.test.ts`.
 *
 * It exists only so that the build can be run under `--max-semi-space-size=1`.
 * #116 is a garbage-collection race: `isDirectCallee`/`isDeclarationName` compare
 * tree-sitter `SyntaxNode` objects with `===`, which only answers correctly while
 * the node is still in node-tree-sitter's tree cache. Whether a scavenge has
 * cleared that cache mid-walk is otherwise pure luck — measured over a sweep of
 * fixture sizes, the same input flips between correct and misclassified from one
 * process to the next. Shrinking the young generation makes scavenges frequent
 * enough that the cache is reliably cold, which turns the race into a fixed
 * outcome and the regression test into a deterministic one.
 *
 * Prints one JSON line: every edge pointing at `src/dep.ts#target`.
 */
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { join } from "node:path";

const root = process.argv[2];

await buildGraph(root, { reuse: false });
const graph = readGraph(wiringPath(join(root, "graft")));
const edges = (graph?.edges ?? [])
  .filter((edge) => edge.target === "src/dep.ts#target")
  .map(({ source, relation }) => ({ source, relation }));

console.log(`__EDGES__${JSON.stringify(edges)}`);
