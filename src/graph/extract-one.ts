/**
 * The per-file half of `buildGraph`'s parse loop: read, hash, pick a tier,
 * extract. Pure apart from the read, and it never touches the cache or the graph:
 * the caller decides what to do with each outcome. Kept separate so the same
 * code runs in-thread for a small refresh and inside a forked parser child for
 * a large cold build (`parse-worker.ts`), and the two cannot drift.
 */
import { extractFile, languageLabelOf } from "./extract.js";
import { extractGeneric, fallbackLangOf } from "./generic.js";
import { extractContainer } from "./container.js";
import { depthReady } from "./depth-parser.js";
import { tierOf } from "./tier.js";
import { contentHash } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import type { ExtractEntry } from "./extract-cache.js";
import type { SourceStat } from "./source-files.js";

export type ExtractOneResult =
  | { kind: "reused"; hash: string }
  | { kind: "skipped"; entry: ExtractEntry }
  | { kind: "parsed"; entry: ExtractEntry; label: string }
  | { kind: "error"; entry: ExtractEntry; message: string };

/** What the extraction cache remembers about a file's last successful parse. */
export interface PriorParse {
  hash: string;
  /** The breadth stand-in that produced it, if one did (see {@link ExtractEntry.via}). */
  via?: string;
}

/** Grammars must already be warmed (`warmGrammarsFor`). `prior` is null when there
 * is nothing to reuse, including a cached failure, which is always parsed again. */
export function extractOne(f: SourceStat, prior: PriorParse | null): ExtractOneResult {
  const rel = f.rel;
  const { lang, container, generic, fellBack: standIn } = tierOf(f.abs);
  const label = languageLabelOf(f.abs) ?? container?.name ?? generic?.name ?? "unknown";
  // A .vue file's embedded script falls back the same way its language does.
  const inner = container && !depthReady(container.inner) ? container.inner : null;
  // Which stand-in parses this file, if one does. A cached parse is replayed only
  // when the same parser would produce it now: otherwise a file parsed by the
  // stand-in would keep its basic parse after a reinstall restored the native
  // grammar, for as long as its bytes didn't change.
  const via = standIn ? generic!.name : inner ? fallbackLangOf(inner).name : undefined;

  // Every file is read and hashed, every build; only the parse is memoized.
  // Trusting (size, mtime) here would make a same-length edit inside one mtime
  // tick invisible to `graft build`, which `graft check` (always hashing) would
  // then report as drift the build refuses to repair.
  let source: string | null;
  try {
    source = readSourceFile(f.abs);
  } catch (err) {
    const message = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "skipped", entry: { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: message } };
  }
  if (source === null) {
    // Unsupported encoding (UTF-16BE): a skip, never an error.
    return { kind: "skipped", entry: { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [] } };
  }

  const hash = contentHash(source);
  if (prior !== null && hash === prior.hash && prior.via === via) return { kind: "reused", hash };

  try {
    const { nodes, rawEdges } = lang
      ? extractFile(rel, source, lang)
      : container
        ? extractContainer(rel, source, container)
        : extractGeneric(rel, source, generic!.name);
    return { kind: "parsed", label, entry: { size: f.size, mtimeMs: f.mtimeMs, hash, nodes, rawEdges, ...(via ? { via } : {}) } };
  } catch (err) {
    const message = `${rel}: parse failed — ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "error", message, entry: { size: f.size, mtimeMs: f.mtimeMs, hash, nodes: [], rawEdges: [], error: message, ...(via ? { via } : {}) } };
  }
}
