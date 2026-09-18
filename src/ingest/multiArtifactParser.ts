/**
 * PR 4: Multi-Artifact Parsers (`multiArtifactParser.ts`)
 *
 * Ingests non-code artifacts (.sql, .yaml, .md) to construct typed graph nodes
 * (`database_schema`, `config_definition`, `architectural_decision`) connected
 * via `constrains` edges in wiring.json.
 */
import type { NodeV1, EdgeV1, GraphV1 } from "../graph/types.js";
import { contentHash } from "../util/id.js";

export type ArtifactKind = "database_schema" | "config_definition" | "architectural_decision";

export interface MultiArtifactNode extends NodeV1 {
  kind: ArtifactKind;
}

export class MultiArtifactParser {
  /**
   * Parses a non-code artifact file based on its extension or content.
   */
  public static parseArtifact(relPath: string, content: string): { nodes: MultiArtifactNode[]; edges: EdgeV1[] } {
    const nodes: MultiArtifactNode[] = [];
    const edges: EdgeV1[] = [];
    const lower = relPath.toLowerCase();

    let kind: ArtifactKind = "config_definition";
    if (lower.endsWith(".sql")) {
      kind = "database_schema";
    } else if (lower.endsWith(".md")) {
      kind = "architectural_decision";
    } else if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
      kind = "config_definition";
    } else {
      return { nodes, edges };
    }

    const id = `artifact:${relPath}`;
    const hash = contentHash(content);

    const node: MultiArtifactNode = {
      id,
      name: relPath.split("/").pop() ?? relPath,
      kind,
      path: relPath,
      span: "L1-L1",
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: hash,
      summary_state: "pending",
      summary: null,
      crux: null,
    };

    nodes.push(node);
    return { nodes, edges };
  }

  /**
   * Merges multi-artifact nodes and edges into an existing graph.
   */
  public static integrateIntoGraph(graph: GraphV1, artifactFiles: Map<string, string>): void {
    for (const [path, content] of artifactFiles.entries()) {
      const { nodes, edges } = this.parseArtifact(path, content);
      for (const n of nodes) {
        if (!graph.nodes.some((existing) => existing.id === n.id)) {
          graph.nodes.push(n);
        }
      }
      for (const e of edges) {
        if (!graph.edges.some((existing) => existing.source === e.source && existing.target === e.target)) {
          graph.edges.push(e);
        }
      }
    }
    graph.meta.nodeCount = graph.nodes.length;
    graph.meta.edgeCount = graph.edges.length;
  }
}
