/**
 * One SKILL.md on disk: whether it is Trail's to rewrite, and the rewrite.
 *
 * A skill is Trail's when its front matter says so (`metadata.trail`, the one
 * key spec section 6 gives Trail), when it is kept on this machine in
 * ~/.trail (only Trail writes there), or when an older Trail already versioned
 * it with a top-level `version: 3` line. Trail never rewrites any other
 * SKILL.md: a skill someone wrote by hand stays exactly as they wrote it, and
 * its corrections reach the agent through `trail skills show` instead.
 *
 * The rewrite finds the front matter the way the reader does (gray-matter
 * skips a BOM and spaces after a fence), keeps the file's line ends, and
 * leaves the file alone when it can't find both fences, so a skill never
 * loses its name or description to a rewrite.
 *
 * A skill file is read or written only where its links keep it inside its
 * own root, the repo's checkout or ~/.trail (`within`).
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { withMetadataVersion } from "./front-version.js";

/**
 * The `metadata.trail` value a takeaway skill gets: `s-` and 6 hex digits
 * from its name. The same name always gets the same one, so a skill that is
 * marked twice (on two machines) is marked alike.
 */
export function skillMark(name: string): string {
  return `s-${createHash("sha1").update(`skill:${name}`).digest("hex").slice(0, 6)}`;
}

interface Front {
  /** The file's lines, without a BOM. */
  lines: string[];
  /** The index of the closing `---`. */
  close: number;
  eol: "\n" | "\r\n";
}

/** Where `text`'s front matter is, or null when it doesn't open and close with a `---` line. */
function front(text: string): Front | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const fence = (l: string | undefined) => l !== undefined && l.trimEnd() === "---";
  if (!fence(lines[0])) return null;
  const close = lines.findIndex((l, i) => i > 0 && fence(l));
  return close === -1 ? null : { lines, close, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** The line an older Trail wrote at the top level, and nothing a person would write by hand for a version ("1.0", "1.0.0"). */
const OLD_VERSION_LINE = /^version:[ \t]*\d+[ \t]*$/;

/**
 * Whether Trail may rewrite the SKILL.md `text` (front matter `data`, kept in
 * the repo or on this machine): see the top of this file.
 */
export function trailOwned(text: string, data: Record<string, unknown>, where: "repo" | "home"): boolean {
  if (where === "home") return true;
  const meta = data.metadata;
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    const mark = (meta as Record<string, unknown>).trail;
    if (typeof mark === "string" && mark.trim()) return true;
  }
  const f = front(text);
  return f !== null && f.lines.slice(1, f.close).some((l) => OLD_VERSION_LINE.test(l));
}

/**
 * Rewrite `file` at `version` with `body`. In the front matter only
 * `metadata.version` changes (an old top-level `version` moves there), and a
 * skill without `metadata.trail` gets `mark`, so it stays Trail's once the old
 * `version` line is gone. A BOM is dropped: the reference validator refuses
 * one. False, and the file untouched, when its front matter can't be found.
 */
export function rewriteSkill(file: string, version: number, body: string, mark: string): boolean {
  const f = front(readFileSync(file, "utf8"));
  if (!f) return false;
  const fm = withMetadataVersion(f.lines.slice(1, f.close), version, mark);
  const text = `---\n${fm.join("\n")}\n---\n\n${body.trim()}\n`;
  writeFileSync(file, f.eol === "\n" ? text : text.replace(/\r?\n/g, f.eol));
  return true;
}

/** `path`, or the nearest folder above it that is there (a dangling link counts as there). */
export function nearestThere(path: string): string {
  for (let p = path; ; p = dirname(p)) {
    try {
      lstatSync(p);
      return p;
    } catch {
      if (dirname(p) === p) return p;
    }
  }
}

/** Whether `path`, every link followed, is inside `root` (links followed too). False when either can't be resolved. */
export function within(path: string, root: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  } catch {
    return false;
  }
}
