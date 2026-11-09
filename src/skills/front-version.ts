/**
 * A skill's version, where the Agent Skills spec lets Trail keep it: under
 * `metadata`, as a quoted string (`version: "3"`). Older Trail wrote it at the
 * top level (`version: 3`); that still reads, and the next write moves it.
 *
 * The front matter is edited as text, one key, so a hand-written skill keeps
 * every other line (`allowed-tools`, comments, its own metadata) exactly as its
 * author wrote it.
 */
import { matter } from "../util/front-matter.js";

/** The version `data` (a SKILL.md's front matter) says: `metadata.version`, else the old top-level `version`, else 1. */
export function versionOf(data: Record<string, unknown>): number {
  const meta = data.metadata;
  const fromMeta = typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>).version : undefined;
  for (const v of [fromMeta, data.version]) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  return 1;
}

const TOP_KEY = /^([A-Za-z0-9_-]+)\s*:(.*)$/;

/** Where each top-level key's lines are: from its own line up to the next top-level line. */
function topKeyAt(lines: string[], key: string): { at: number; end: number } | null {
  const at = lines.findIndex((l) => TOP_KEY.exec(l)?.[1] === key);
  if (at === -1) return null;
  let end = at + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))) end++;
  // Trailing blank lines belong to no key.
  while (end > at + 1 && lines[end - 1]!.trim() === "") end--;
  return { at, end };
}

/**
 * The front matter `lines` (without the `---` fences) with `metadata.version`
 * set to `version`, and any old top-level `version` gone. With `mark`, a
 * metadata without a `trail` key gets `trail: "<mark>"`; one it already has is
 * kept. A block `metadata:` gets the lines replaced or added at its own
 * indent; a flow one (`metadata: { … }`) is written out as a block, its other
 * values kept as strings; none at all gets one.
 */
export function withMetadataVersion(lines: string[], version: number, mark?: string): string[] {
  const out = [...lines];
  const old = topKeyAt(out, "version");
  if (old) out.splice(old.at, old.end - old.at);
  const line = `version: "${version}"`;
  const marked = mark ? [`trail: ${JSON.stringify(mark)}`] : [];
  const meta = topKeyAt(out, "metadata");
  if (!meta) return [...out, "metadata:", ...marked.map((l) => `  ${l}`), `  ${line}`];

  const inline = TOP_KEY.exec(out[meta.at]!)![2]!.replace(/\s+#.*$/, "").trim();
  if (inline) {
    // A flow map, or something that isn't a map: read what it holds, write it as a block.
    let held: Record<string, unknown> = {};
    try {
      const data = matter(`---\n${out.slice(meta.at, meta.end).join("\n")}\n---\n`).data as Record<string, unknown>;
      if (typeof data.metadata === "object" && data.metadata !== null && !Array.isArray(data.metadata)) held = data.metadata as Record<string, unknown>;
    } catch {
      /* unreadable: replaced by the version alone */
    }
    const kept = Object.entries(held)
      .filter(([k, v]) => k !== "version" && v !== null && typeof v !== "object")
      .map(([k, v]) => `  ${k}: ${JSON.stringify(String(v))}`);
    const mine = Object.hasOwn(held, "trail") ? [] : marked.map((l) => `  ${l}`);
    out.splice(meta.at, meta.end - meta.at, "metadata:", ...kept, ...mine, `  ${line}`);
    return out;
  }

  const children = out.slice(meta.at + 1, meta.end);
  // The first child key's indent: a comment line can sit at any indent.
  const indent = /^(\s+)\S/.exec(children.find((l) => l.trim() && !l.trim().startsWith("#")) ?? "")?.[1] ?? "  ";
  const child = (key: string) =>
    children.findIndex((l) => l.startsWith(indent) && !/^\s/.test(l.slice(indent.length)) && new RegExp(`^${key}\\s*:`).test(l.slice(indent.length)));
  const has = child("version");
  const add = (child("trail") === -1 ? marked : []).map((l) => `${indent}${l}`);
  if (has !== -1) out[meta.at + 1 + has] = `${indent}${line}`;
  else add.push(`${indent}${line}`);
  // After the block's last line, so a comment or blank line closing it stays where it was.
  out.splice(meta.end, 0, ...add);
  return out;
}
