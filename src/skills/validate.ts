/**
 * What keeps a SKILL.md from being a valid Agent Skills file, in plain words.
 *
 * The rules are the spec's (agentskills.io/specification), as its reference
 * validator (`skills-ref`) checks them, with one tightening: a name is ASCII
 * only (a-z, 0-9 and single hyphens), since it is also a folder name on every
 * machine that clones the repo. Its YAML reader (strictyaml) refuses a
 * byte-order mark, flow style (`{ … }`, `[ … ]`), tags (`!!str`), anchors and
 * aliases, so those are problems here too. Only `name`, `description`, `license`,
 * `compatibility`, `allowed-tools` and `metadata` may sit at the top level;
 * Trail keeps everything of its own, `version` included, under `metadata`, as
 * flat strings.
 *
 * Pure: no I/O. CI also runs the reference validator over the fixtures in
 * `test/fixtures/skills/`, which a test keeps equal to what Trail writes.
 */
import { matter } from "../util/front-matter.js";

/** The top-level keys the spec allows. */
export const SPEC_KEYS: readonly string[] = ["name", "description", "license", "compatibility", "allowed-tools", "metadata"];

export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;

/** a-z and 0-9 in words joined by single hyphens. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A value in flow style or with a tag, after `key:` or `- `: text like `[draft]` mid-line, quoted, or on a folded line is not one. */
const FLOW_OR_TAG = /^\s*(?:-\s+|[^\s'"#][^:'"]*:\s+)([[{!])/;

/** The front matter between the opening `---` line and the closing one, or null when there isn't both. */
function frontMatterBlock(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return null;
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  return close === -1 ? null : lines.slice(1, close).join("\n");
}

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function nameProblems(name: unknown, folderName: string): string[] {
  if (typeof name !== "string" || !name.trim()) return ["`name` is missing: it must be text, the skill's folder name"];
  const out: string[] = [];
  if (name.length > NAME_MAX) out.push(`\`name\` is ${name.length} characters: at most ${NAME_MAX}`);
  if (name !== name.toLowerCase()) out.push("`name` must be lowercase");
  if (name.startsWith("-") || name.endsWith("-")) out.push("`name` can't start or end with a hyphen");
  if (name.includes("--")) out.push("`name` can't have two hyphens in a row");
  if (!NAME.test(name) && /[^a-z0-9-]/.test(name.toLowerCase())) out.push("`name` may hold only a-z, 0-9 and hyphens");
  if (name !== folderName) out.push(`\`name\` is "${name}" but its folder is "${folderName}": they must match`);
  return out;
}

/**
 * Every way `text` (a SKILL.md) breaks the spec, for a skill in the folder
 * `folderName`. Empty when it is valid.
 */
export function skillProblems(text: string, folderName: string): string[] {
  if (text.startsWith("\uFEFF")) return ["SKILL.md starts with a byte-order mark, which the reference validator reads as text before the opening `---`"];
  const block = frontMatterBlock(text);
  if (block === null) return ["SKILL.md must open with YAML front matter between two `---` lines"];
  // The reference validator splits the file on its first two `---`, wherever they are.
  if (block.includes("---")) return ["the front matter holds `---`, which ends it early for some readers"];
  let data: Record<string, unknown>;
  try {
    const parsed = matter(text);
    if (parsed.refused) return [`the front matter isn't read: ${parsed.refused}`];
    data = parsed.data as Record<string, unknown>;
  } catch {
    return ["the front matter isn't valid YAML"];
  }
  if (!isMap(data)) return ["the front matter must be a YAML map"];
  const odd = block.split("\n").map((l) => FLOW_OR_TAG.exec(l)?.[1]).find(Boolean);
  if (odd) return [odd === "!" ? "the front matter has a YAML tag (`!`): write the value as plain text" : "the front matter uses flow style (`{ … }` or `[ … ]`): write maps and lists as blocks, one item per line"];

  const out: string[] = [];
  const extra = Object.keys(data).filter((k) => !SPEC_KEYS.includes(k));
  if (extra.length) out.push(`only ${SPEC_KEYS.join(", ")} may sit at the top level; move ${extra.sort().join(", ")} under metadata`);

  out.push(...nameProblems(data.name, folderName));

  const description = data.description;
  if (typeof description !== "string" || !description.trim()) out.push("`description` is missing: it must be text, what the skill does and when to use it");
  else if (description.length > DESCRIPTION_MAX) out.push(`\`description\` is ${description.length} characters: at most ${DESCRIPTION_MAX}`);

  if ("compatibility" in data) {
    const c = data.compatibility;
    if (typeof c !== "string") out.push("`compatibility` must be text");
    else if (c.length > COMPATIBILITY_MAX) out.push(`\`compatibility\` is ${c.length} characters: at most ${COMPATIBILITY_MAX}`);
  }

  if ("metadata" in data) {
    const m = data.metadata;
    if (!isMap(m)) out.push("`metadata` must be a map of names to quoted strings");
    else for (const [k, v] of Object.entries(m)) if (typeof v !== "string") out.push(`\`metadata.${k}\` must be a quoted string`);
  }
  return out;
}
