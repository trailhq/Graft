/**
 * The depth tier's parsers: the grammars extract.ts walks, compiled to WASM, so
 * installing the package compiles nothing.
 *
 * Both halves of a parse are what the native addons ran. The grammars are the same
 * versions the addons were built from, not the breadth tier's bundle: a grammar
 * version changes parse trees, and extract.ts is written against these exact
 * trees. And they run on web-tree-sitter 0.22.2, the tree-sitter core the addons
 * were built with (wasm-runtime.ts says why that matters). Most grammar packages
 * ship their own .wasm next to the native binding; python, kotlin and swift don't,
 * so scripts/build-grammar-wasm.mjs compiles theirs from the package's own src/
 * and they are committed in src/graph/grammars/ (grammars.json records what each
 * was built from; that script says why swift's scanner is patched). `npm run
 * build` copies all of them into dist/vendor/grammars/ (scripts/vendor-grammars.mjs).
 *
 * The native addons (native.ts) stay behind the same interface for two reasons: a
 * language listed in {@link NATIVE_ONLY} parses on its addon, and
 * test/depth-parity.ts builds real repos on both and diffs the graphs. Either way
 * extract.ts sees one node API, {@link SyntaxNode}, which both satisfy.
 *
 * Loading WASM is async and parsing is not, so a build awaits
 * {@link warmDepthGrammars} once (build.ts `warmGrammarsFor` does) before its
 * synchronous parse loop. A grammar that won't load sends its language's files to
 * the breadth tier's stand-in (`fallbackLangOf` in generic.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "./extract.js";
import { missingNativePackages, nativeParser, nativeReady } from "./native.js";
import { depthRuntime, type DepthWasmParser } from "./wasm-runtime.js";

export interface Point {
  row: number;
  column: number;
}

/** The syntax-node surface extract.ts and bindings.ts use. */
export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  /** Unique within one tree; compare `tree` too (extract.ts `sameSyntaxNode`). */
  readonly id: number;
  readonly tree: unknown;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: Point;
  readonly endPosition: Point;
  readonly parent: SyntaxNode | null;
  readonly children: SyntaxNode[];
  readonly namedChildren: SyntaxNode[];
  readonly previousNamedSibling: SyntaxNode | null;
  childForFieldName(fieldName: string): SyntaxNode | null;
}

/** Each depth grammar's .wasm: the package it comes from and the file's name. A
 * `built` one isn't shipped by its package; it is in src/graph/grammars/. */
export const DEPTH_WASM: Record<Language, { module: string; file: string; built?: true }> = {
  typescript: { module: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  tsx: { module: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  python: { module: "tree-sitter-python", file: "tree-sitter-python.wasm", built: true },
  go: { module: "tree-sitter-go", file: "tree-sitter-go.wasm" },
  r: { module: "tree-sitter-r", file: "tree-sitter-r.wasm" },
  java: { module: "tree-sitter-java", file: "tree-sitter-java.wasm" },
  kotlin: { module: "tree-sitter-kotlin", file: "tree-sitter-kotlin.wasm", built: true },
  swift: { module: "tree-sitter-swift", file: "tree-sitter-swift.wasm", built: true },
  php: { module: "tree-sitter-php", file: "tree-sitter-php.wasm" },
};

/** Languages that parse on their native addon instead. Empty: every depth
 * language built the native graph exactly on WASM (test/depth-parity.ts). */
export const NATIVE_ONLY: ReadonlySet<Language> = new Set<Language>();

const nodeRequire = createRequire(import.meta.url);
const VENDOR_DIR = fileURLToPath(new URL("../vendor/grammars/", import.meta.url));
const BUILT_DIR = fileURLToPath(new URL("./grammars/", import.meta.url));

/** `lang`'s .wasm bytes: from dist/vendor/grammars/ in a build, else (run from
 * src/) from src/graph/grammars/ or the grammar package in node_modules. */
export function readDepthWasm(lang: Language, vendorDir = VENDOR_DIR): Uint8Array {
  const { module, file, built } = DEPTH_WASM[lang];
  const vendored = join(vendorDir, file);
  if (existsSync(vendored)) return readFileSync(vendored);
  return readFileSync(built ? join(BUILT_DIR, file) : nodeRequire.resolve(`${module}/${file}`));
}

type Backend = "wasm" | "native";
let forced: Backend | null = null;
let readWasm: (lang: Language) => Uint8Array = (lang) => readDepthWasm(lang);

function backendOf(lang: Language): Backend {
  return forced ?? (NATIVE_ONLY.has(lang) ? "native" : "wasm");
}

type Loaded = { ok: true; language: unknown } | { ok: false; error: string };
const loaded = new Map<Language, Loaded>();
/** Shared by every grammar and set per parse; null until the runtime is up, or
 * after a grammar trapped mid-parse. */
let parser: DepthWasmParser | null = null;
let newParser: (() => DepthWasmParser) | null = null;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadWasm(lang: Language): Promise<Loaded> {
  try {
    const runtime = await depthRuntime();
    newParser = runtime.newParser;
    return { ok: true, language: await runtime.load(readWasm(lang)) };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Load the grammars for `langs`. Await once before a synchronous parse loop.
 * Never throws: a grammar that won't load leaves {@link depthReady} false. */
export async function warmDepthGrammars(langs: Iterable<Language>): Promise<void> {
  for (const lang of new Set(langs)) {
    if (backendOf(lang) === "wasm" && !loaded.has(lang)) loaded.set(lang, await loadWasm(lang));
  }
}

/** True when `lang`'s grammar is loaded and can parse. Never throws. */
export function depthReady(lang: Language): boolean {
  return backendOf(lang) === "native" ? nativeReady(lang) : loaded.get(lang)?.ok === true;
}

/** node tree-sitter's string `parse()` fails with "Invalid argument" on any input
 * ≥ 32 KB, which silently dropped large files, often the most important ones. The
 * callback form has no such limit as long as each returned chunk is under 32 KB,
 * so the source always goes in <32 KB slices, on either backend. Code-unit
 * indexing matches `String.slice`. */
const PARSE_CHUNK = 16384;

/**
 * Parse `source` as `lang` and hand the root to `use`. The tree lives only for the
 * call: a WASM tree is freed when `use` returns, so nothing may keep a node.
 * Throws when the grammar is unavailable: callers ask {@link depthReady} first and
 * send the file to its breadth-tier stand-in instead.
 */
export function parseDepth<T>(lang: Language, source: string, use: (root: SyntaxNode) => T): T {
  const input = (index: number): string => source.slice(index, index + PARSE_CHUNK);
  if (backendOf(lang) === "native") return use(nativeParser(lang).parse(input).rootNode as SyntaxNode);

  const grammar = loaded.get(lang);
  if (!grammar?.ok) {
    const why = grammar ? grammar.error : "not loaded (await warmDepthGrammars first)";
    throw new Error(`the ${lang} parser is not available: ${why}`);
  }
  let tree;
  try {
    parser ??= newParser!();
    parser.setLanguage(grammar.language);
    tree = parser.parse(input);
  } catch (err) {
    // A trap inside the grammar can leave the parser mid-parse: the next file
    // gets a fresh one.
    parser = null;
    throw new Error(`${lang} grammar threw: ${message(err)}`);
  }
  if (!tree) throw new Error(`the ${lang} parser returned no tree`);
  try {
    return use(tree.rootNode as SyntaxNode);
  } finally {
    tree.delete();
  }
}

/** The npm packages whose missing binary keeps these languages off a native
 * parser. Only a {@link NATIVE_ONLY} language can have one: a WASM grammar has no
 * install script for `--allow-scripts` to run. */
export function missingDepthPackages(langs: Iterable<Language>): string[] {
  return missingNativePackages([...langs].filter((l) => backendOf(l) === "native"));
}

/** Test seam: parse every depth language on `backend` (null restores the default
 * per-language choice), and/or replace how a grammar's .wasm is read (a function
 * that throws simulates a missing or corrupt file). Forgets every grammar loaded. */
export function setDepthParsersForTest(opts: { backend?: Backend | null; readWasm?: ((lang: Language) => Uint8Array) | null }): void {
  if (opts.backend !== undefined) forced = opts.backend;
  if (opts.readWasm !== undefined) readWasm = opts.readWasm ?? ((lang) => readDepthWasm(lang));
  loaded.clear();
}
