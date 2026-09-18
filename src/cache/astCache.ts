/**
 * PR 1: AST-Differential Summarization Caching (`astCache.ts`)
 * 
 * Extracts and caches AST signature hashes (`astHash`) to distinguish structural
 * code changes (exported symbols, signatures, interface definitions) from
 * non-structural updates (comments, whitespace, formatting), avoiding
 * redundant Tier-2 LLM summary calls during `graft build --deep`.
 */
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "../util/state.js";
import type { NodeV1 } from "../graph/types.js";

export interface ASTSignature {
  /** File path relative to repository root */
  path: string;
  /** Combined SHA-256 hash of all structural nodes in the file */
  astHash: string;
  /** Map of symbol identifier/name to its individual structural fingerprint */
  symbolSignatures: Record<string, string>;
}

/**
 * Extracts structural AST signatures from parsed nodes.
 */
export class ASTSignatureExtractor {
  /**
   * Computes an overall and per-symbol signature hash for a given file's nodes.
   */
  public static extract(path: string, nodes: NodeV1[]): ASTSignature {
    const fileNodes = nodes.filter((n) => n.path === path && n.kind !== "file");
    const symbolSignatures: Record<string, string> = {};
    const hashes: string[] = [];

    // Sort nodes deterministically by ID / span to ensure stable hashing
    const sorted = [...fileNodes].sort((a, b) => a.id.localeCompare(b.id));

    for (const node of sorted) {
      // Build a structural string representation ignoring comments/whitespace/formatting
      const structuralRepresentation = JSON.stringify({
        name: node.name,
        kind: node.kind,
        exported: node.exported,
        signature: node.signature ?? "",
        span: node.span,
      });
      const hash = createHash("sha256").update(structuralRepresentation).digest("hex");
      symbolSignatures[node.id] = hash;
      hashes.push(hash);
    }

    const combined = hashes.join("|");
    const astHash = createHash("sha256").update(combined).digest("hex");

    return {
      path,
      astHash,
      symbolSignatures,
    };
  }
}

/**
 * Manages caching of AST signatures and correlates them with stored Tier-2 summaries.
 */
export class ASTCacheManager {
  private cachePath: string;
  private cache: Record<string, ASTSignature> = {};

  constructor(cachePath: string) {
    this.cachePath = cachePath;
    this.load();
  }

  public load(): void {
    try {
      const data = readJson<Record<string, ASTSignature>>(this.cachePath);
      if (data && typeof data === "object") {
        this.cache = data;
      }
    } catch {
      this.cache = {};
    }
  }

  public save(): void {
    try {
      writeJsonAtomic(this.cachePath, this.cache);
    } catch {
      // Best-effort cache persistence
    }
  }

  /**
   * Checks if a file's AST signature is unchanged compared to the cached entry.
   */
  public isUnchanged(path: string, currentNodes: NodeV1[]): boolean {
    const cached = this.cache[path];
    if (!cached) return false;

    const current = ASTSignatureExtractor.extract(path, currentNodes);
    return cached.astHash === current.astHash;
  }

  /**
   * Updates the cache entry for a file.
   */
  public update(path: string, currentNodes: NodeV1[]): ASTSignature {
    const signature = ASTSignatureExtractor.extract(path, currentNodes);
    this.cache[path] = signature;
    return signature;
  }

  public get(path: string): ASTSignature | undefined {
    return this.cache[path];
  }
}
