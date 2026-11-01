/**
 * Markdown extraction tier — headings as symbols, sections as nodes.
 *
 * Opt-in via `trail build --include-md` (persisted in `.graft/config.json`).
 * Produces one FileNode + one SectionNode per heading, so `trail ask` and
 * `trail_search_semantic` can find content in `.md` files.
 *
 * No tree-sitter grammar needed: heading structure is simple enough for regex.
 * Each heading becomes a node; its body is the text until the next same-or-higher
 * heading. The file node's body is the preamble (text before the first heading).
 */
import { readFileSync } from "node:fs";
import { contentHash } from "../util/id.js";
import type { NodeV1 } from "./types.js";

export const MD_EXT = ".md";

/** Whether this file path is a markdown file. */
export function isMdFile(path: string): boolean {
  return path.toLowerCase().endsWith(MD_EXT);
}

/** Heading level of a markdown line, or 0 if not a heading. */
function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1]!.length : 0;
}

/** Strip markdown heading prefix and trim. */
function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

/** Slugify a heading for use as a symbol name (lowercase, hyphens). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

export interface MdSection {
  /** Heading text, e.g. "Reglas de negocio". */
  name: string;
  /** Heading level 1-6. */
  level: number;
  /** 1-based line number of the heading. */
  line: number;
  /** Text content of this section (not including the heading line). */
  body: string;
}

/** Parse a markdown file into a list of sections (one per heading). */
export function parseMdSections(content: string): MdSection[] {
  const lines = content.split("\n");
  const sections: MdSection[] = [];
  let current: MdSection | null = null;
  let bodyLines: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Skip fenced code blocks — headings inside them are not real.
    if (/^```/.test(line)) { inFence = !inFence; }
    if (inFence) {
      if (current) bodyLines.push(line);
      continue;
    }

    const level = headingLevel(line);
    if (level > 0) {
      // Close the previous section.
      if (current) {
        current.body = bodyLines.join("\n").trim();
        sections.push(current);
      }
      current = { name: headingText(line), level, line: i + 1, body: "" };
      bodyLines = [];
    } else {
      if (current) bodyLines.push(line);
    }
  }

  // Close last section.
  if (current) {
    current.body = bodyLines.join("\n").trim();
    sections.push(current);
  }

  return sections;
}

/**
 * Extract nodes from a markdown file. Returns one FileNode + one node per heading.
 * Nodes have kind "section" and carry the section body as summary/body_text.
 */
export function extractMd(absPath: string, relPath: string): NodeV1[] {
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const totalLines = lines.length;
  const fileHash = contentHash(content);
  const fileId = relPath;
  const nodes: NodeV1[] = [];

  const sections = parseMdSections(content);

  // Preamble: text before the first heading.
  const firstHeadingLine = sections[0]?.line ?? Infinity;
  const preamble = content
    .split("\n")
    .slice(0, firstHeadingLine - 1)
    .join("\n")
    .trim();

  // File node.
  nodes.push({
    id: fileId,
    kind: "file",
    name: relPath.split("/").pop() ?? relPath,
    path: relPath,
    span: `L1-L${totalLines}`,
    signature: null,
    exported: false,
    origin: "generic",
    body_hash: fileHash,
    summary_state: "none",
    summary: preamble.slice(0, 200) || undefined,
    body_text: preamble || undefined,
    children: [],
    edges: [],
  } as unknown as NodeV1);

  // One node per heading.
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const nextLine = sections[i + 1]?.line ?? totalLines + 1;
    const symbolId = `${relPath}#${slugify(section.name)}`;
    nodes.push({
      id: symbolId,
      kind: "section" as unknown as NodeV1["kind"],
      name: section.name,
      path: relPath,
      span: `L${section.line}-L${nextLine - 1}`,
      signature: `${"#".repeat(section.level)} ${section.name}`,
      exported: false,
      origin: "generic",
      body_hash: contentHash(section.body),
      summary_state: "none",
      summary: section.body.slice(0, 300) || undefined,
      body_text: section.body || undefined,
      children: [],
      edges: [],
    } as unknown as NodeV1);
  }

  return nodes;
}
