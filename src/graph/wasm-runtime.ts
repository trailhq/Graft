/**
 * The two web-tree-sitter runtimes WASM grammars load into, each initialised once.
 *
 * `Parser.init()` is not idempotent: a second call instantiates a second runtime
 * and swaps it in, and every grammar loaded into the first one is then unusable.
 * So every tier gets its runtime from here.
 *
 * - {@link webTreeSitter}, the current release, runs the breadth tier (generic.ts)
 *   and the container tier's wrapper grammars (container.ts).
 * - {@link depthRuntime}, web-tree-sitter 0.22.2 (the `web-tree-sitter-depth`
 *   alias), runs the depth tier (depth-parser.ts). 0.22.2 is the tree-sitter core
 *   the native addon (tree-sitter 0.21.1) was built with, and the core decides how
 *   a grammar's conflicts and errors resolve. On it, every tree of the parity
 *   corpus matched the native one; on the current core, kotlin, swift and
 *   typescript trees did not always. Keep it pinned: bumping it is a grammar
 *   change, to be re-checked with test/depth-parity.ts.
 */
import { createRequire } from "node:module";

type WebTreeSitter = typeof import("web-tree-sitter");

let init: Promise<WebTreeSitter> | null = null;

/** The initialised current runtime, loading and initialising it on the first call. */
export function webTreeSitter(): Promise<WebTreeSitter> {
  init ??= import("web-tree-sitter").then(async (m) => {
    await m.Parser.init();
    return m;
  });
  return init;
}

/** What the depth tier uses of web-tree-sitter 0.22's API. */
export interface DepthWasmParser {
  setLanguage(language: unknown): void;
  parse(input: (index: number) => string): { rootNode: unknown; delete(): void } | null;
}
interface DepthParserClass {
  init(): Promise<void>;
  Language: { load(input: Uint8Array): Promise<unknown> };
  new (): DepthWasmParser;
}
export interface DepthRuntime {
  load(wasm: Uint8Array): Promise<unknown>;
  newParser(): DepthWasmParser;
}

let depth: Promise<DepthRuntime> | null = null;

/** The depth tier's runtime, initialised on the first call. */
export function depthRuntime(): Promise<DepthRuntime> {
  depth ??= (async () => {
    const Parser = createRequire(import.meta.url)("web-tree-sitter-depth") as DepthParserClass;
    await Parser.init();
    return { load: (wasm) => Parser.Language.load(wasm), newParser: () => new Parser() };
  })();
  return depth;
}
