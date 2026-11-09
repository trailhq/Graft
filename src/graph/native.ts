/**
 * The depth tier's native grammars: node tree-sitter and the grammar addons,
 * loaded on first use and never fatally.
 *
 * The depth tier parses on WASM now (depth-parser.ts), and these packages are dev
 * dependencies only. As dependencies they made installing the package compile C:
 * `tree-sitter-kotlin` ships no prebuilt binary at all, and `tree-sitter` and
 * `tree-sitter-python` have none for linux-arm64. They stay for two uses, both
 * behind depth-parser.ts: test/depth-parity.ts builds real repos on them and on
 * WASM and diffs the graphs, and a language listed in `NATIVE_ONLY` there parses
 * on its addon (none is).
 *
 * Each module is required the first time it is asked for, and a failure is
 * remembered: that language's files go to its WASM stand-in in the breadth tier
 * (`fallbackLangOf` in generic.ts), and the build says which languages fell back
 * and how to fix it ({@link nativeFallbackNotice}).
 */
import { createRequire } from "node:module";
import type Parser from "tree-sitter";
import type { Language } from "./extract.js";

const nodeRequire = createRequire(import.meta.url);

const CORE = "tree-sitter";

/** The module each depth-tier grammar comes from, and the export that is the
 * grammar when the module ships more than one (typescript+tsx, php+php_only). */
const GRAMMAR_MODULES: Record<Language, { module: string; pick?: string }> = {
  typescript: { module: "tree-sitter-typescript", pick: "typescript" },
  tsx: { module: "tree-sitter-typescript", pick: "tsx" },
  python: { module: "tree-sitter-python" },
  go: { module: "tree-sitter-go" },
  r: { module: "tree-sitter-r" },
  java: { module: "tree-sitter-java" },
  kotlin: { module: "tree-sitter-kotlin" },
  swift: { module: "tree-sitter-swift" },
  php: { module: "tree-sitter-php", pick: "php" },
};

/** The name `npm --allow-scripts` needs, where it differs from the module name.
 * `tree-sitter-r` is an npm alias, and npm matches an allow entry against the real
 * package only: an alias as the key matches nothing. */
const NPM_NAME: Record<string, string> = {
  "tree-sitter-r": "@davisvaughan/tree-sitter-r",
};

type Loaded = { ok: true; value: unknown } | { ok: false; error: string };

let requireModule: (id: string) => unknown = (id) => nodeRequire(id);
const modules = new Map<string, Loaded>();
const ready = new Map<Language, boolean>();
/** undefined: not tried yet. null: tried, and the core binding is unusable. */
let parser: Parser | null | undefined;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function load(id: string): Loaded {
  let hit = modules.get(id);
  if (!hit) {
    try {
      hit = { ok: true, value: requireModule(id) };
    } catch (err) {
      hit = { ok: false, error: message(err) };
    }
    modules.set(id, hit);
  }
  return hit;
}

function coreParser(): Parser | null {
  if (parser === undefined) {
    const core = load(CORE);
    parser = null;
    if (core.ok) {
      try {
        parser = new (core.value as typeof Parser)();
      } catch (err) {
        modules.set(CORE, { ok: false, error: message(err) });
      }
    }
  }
  return parser;
}

function grammarOf(lang: Language): unknown {
  const { module, pick } = GRAMMAR_MODULES[lang];
  const m = load(module);
  if (!m.ok) return null;
  return pick ? ((m.value as Record<string, unknown>)[pick] ?? null) : m.value;
}

/**
 * True when `lang`'s native grammar loads and the parser accepts it. The first call
 * per language does the loading; the answer is cached for the life of the process.
 * Never throws.
 */
export function nativeReady(lang: Language): boolean {
  let ok = ready.get(lang);
  if (ok === undefined) {
    ok = false;
    // Load the grammar even when the core binding failed, so the notice can name
    // every package that is missing its binary, not only the first.
    const grammar = grammarOf(lang);
    const p = coreParser();
    if (p && grammar) {
      try {
        p.setLanguage(grammar as never);
        ok = true;
      } catch {
        /* an addon built for another tree-sitter ABI: unusable, though it loaded */
      }
    }
    ready.set(lang, ok);
  }
  return ok;
}

/** What depth-parser.ts uses of a native parser. */
export interface NativeParser {
  parse(input: (index: number) => string): { rootNode: unknown };
}

/** The shared native parser, set to `lang`. Throws when that grammar is not
 * available; callers ask {@link nativeReady} first and send the file elsewhere. */
export function nativeParser(lang: Language): NativeParser {
  if (!nativeReady(lang)) {
    const { module } = GRAMMAR_MODULES[lang];
    const why = [CORE, module].map((id) => modules.get(id)).find((m) => m && !m.ok);
    throw new Error(`the native ${lang} parser is not available${why && !why.ok ? `: ${why.error}` : ""}`);
  }
  const p = parser as Parser;
  p.setLanguage(grammarOf(lang) as never);
  return p;
}

/**
 * The npm packages whose missing binary keeps these languages off the native
 * parser: what `npm install --allow-scripts=…` has to name. Empty when every one
 * loaded, or when the ones that failed did load and were rejected by the parser
 * (an ABI mismatch, which no install flag fixes).
 */
export function missingNativePackages(langs: Iterable<Language>): string[] {
  const out = new Set<string>();
  for (const lang of langs) {
    if (nativeReady(lang)) continue;
    for (const id of [CORE, GRAMMAR_MODULES[lang].module]) {
      const m = modules.get(id);
      if (m && !m.ok) out.add(NPM_NAME[id] ?? id);
    }
  }
  return [...out].sort();
}

/** The languages a build parsed with a breadth-tier stand-in because their own
 * grammar didn't load, and the packages to allow so the next install builds them. */
export interface NativeFallback {
  /** Display labels (`javascript`, not the `typescript` grammar that parses it). */
  languages: string[];
  packages: string[];
}

/**
 * The one line a build prints when some languages fell back, or null when none did.
 * One line on purpose: `graft init` passes on only the `⚠`/`✗` lines of the build
 * it runs, so a second line holding the fix would be dropped there.
 *
 * With no packages to allow, the grammar that didn't load is one of the package's
 * own WASM files, so reinstalling it is the fix.
 */
export function nativeFallbackNotice(fallback: NativeFallback | undefined, packageName: string): string | null {
  if (!fallback || fallback.languages.length === 0) return null;
  const langs = fallback.languages.join(", ");
  const what = fallback.languages.length === 1 ? "its parser didn't load" : "their parsers didn't load";
  const allow = fallback.packages.length > 0 ? `--allow-scripts=${fallback.packages.join(",")} ` : "";
  return `⚠ ${langs}: basic parsing only, ${what}. To fix: npm install -g ${allow}${packageName}`;
}

/** Test seam: replace how native modules are required (null restores the real
 * `require`), and forget everything loaded so far. A missing binary is simulated by
 * a function that throws for that module id, the way node-gyp-build does. */
export function setNativeRequireForTest(fn: ((id: string) => unknown) | null): void {
  requireModule = fn ?? ((id) => nodeRequire(id));
  modules.clear();
  ready.clear();
  parser = undefined;
}

/** The real `require` the seam above wraps, for a test's pass-through. */
export function realNativeRequire(id: string): unknown {
  return nodeRequire(id);
}
