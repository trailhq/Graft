/**
 * Module labels for the blast diagram — the "what part of the system is this?"
 * layer, so a reviewer reads `Graph Extraction and Loading` instead of eleven
 * file paths.
 *
 * Two sources, best first:
 *   1. the deep tier's concept nodes (`graft/*.md`), whose frontmatter lists the
 *      source files each concept was synthesized from. This is why `blast` is
 *      worth running on a `build --deep` graph: the grouping is the product.
 *   2. the file's directory, when no concept claims it (a breadth-tier graph, or
 *      a file added by this very PR and therefore absent from the concept layer).
 */
import { readNodes } from "../context/node-file.js";

export interface ModuleIndex {
  /** Label for a repo-relative path — a concept name when one claims the file. */
  labelOf(path: string): string;
  /** The claiming concept's name, or null when only the directory fallback applies.
   * Callers that group files need to tell the two apart: a shared concept is a real
   * grouping signal, a shared directory is only a shared directory. */
  conceptOf(path: string): string | null;
  /** True when at least one concept node was read (i.e. a --deep graph). */
  hasConcepts: boolean;
}

/**
 * Build the path → module-label lookup for a context dir.
 *
 * A file can be cited by several concepts; the SMALLEST claiming concept wins.
 * A concept grounded in three files says something specific about those three,
 * while a forty-file concept is closer to "the codebase" — picking the tighter
 * one keeps the diagram's boxes meaningful.
 */
export function moduleIndex(contextDir: string): ModuleIndex {
  const claims = new Map<string, { label: string; size: number }>();
  const nodes = readNodes(contextDir);
  for (const node of nodes) {
    if (!node.name) continue;
    for (const src of node.sources) {
      const prev = claims.get(src.path);
      if (!prev || node.sources.length < prev.size) {
        claims.set(src.path, { label: node.name, size: node.sources.length });
      }
    }
  }
  return {
    hasConcepts: nodes.length > 0,
    labelOf: (path: string) => shortLabel(claims.get(path)?.label ?? dirLabel(path)),
    conceptOf: (path: string) => claims.get(path)?.label ?? null,
  };
}

/** Longest label a circle can hold before the text overruns it. */
const MAX_LABEL = 30;

/**
 * Clause breaks a long concept name can be cut at.
 *
 * A concept name is a sentence fragment, so it has real joints: everything after
 * "via", "and", a colon or an opening parenthesis is elaboration. Cutting there
 * leaves a phrase that still reads as a name — "Incremental Build" rather than
 * "Incremental Build via…" — which is why these cuts take no ellipsis.
 */
const CLAUSE_BREAK = /\s(?:\(|—|-\s)|:\s|\s(?:via|and|for|with|using|in|across|over|from|of|by|to)\s/i;

/**
 * A concept name trimmed to fit a node.
 *
 * Concept names are written for a reader with the whole file in front of them, so
 * they run long and some carry a `Concept: ` prefix from the synthesis prompt.
 * "Reciprocal-Rank Fusion for Workspace Federation" is a fine node title in `graft
 * viz` and unreadable inside a circle.
 */
export function shortLabel(label: string): string {
  const bare = label.replace(/^concepts?:\s*/i, "").trim();
  if (bare.length <= MAX_LABEL) return bare;

  const at = CLAUSE_BREAK.exec(bare);
  if (at && at.index >= 8 && at.index <= MAX_LABEL) return bare.slice(0, at.index).trimEnd();

  // No usable joint: a word-boundary cut, marked, because this one really does stop
  // mid-phrase and a reader must not take the fragment for the whole name.
  const cut = bare.lastIndexOf(" ", MAX_LABEL);
  return `${bare.slice(0, cut > MAX_LABEL / 2 ? cut : MAX_LABEL).trimEnd()}…`;
}

/** The parent directory of a directory label, or "" at the top level. */
export function parentDir(dir: string): string {
  const trimmed = dir.replace(/\/$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? "" : `${trimmed.slice(0, cut)}/`;
}

/** Fallback label: the file's directory, or `(root)` for a top-level file. */
export function dirLabel(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "(root)" : path.slice(0, cut) + "/";
}
