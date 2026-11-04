/**
 * Tier dispatch: which extractor parses a file, and the grammar warm-up a
 * synchronous parse loop needs first. Shared by `buildGraph`, `extractOne` (in
 * thread and in a parser child), `checkGraph` and the edit-overlap check, so a
 * tier one of them extracts can never be one another can't see. Re-exported from
 * `build.ts`, its original home.
 */
import { languageOf, type Language } from "./extract.js";
import { fallbackLangOf, genericLangOf, warmGenericGrammars, type GenericLang } from "./generic.js";
import { containerLangOf, warmContainerGrammars, type ContainerLang } from "./container.js";
import { depthReady, warmDepthGrammars } from "./depth-parser.js";

/**
 * Which tier extracts a file. {@link buildGraph} and `checkGraph` both dispatch on
 * this, so a tier the build extracts can never be one the check can't see.
 *
 * Depth tier (hand-written extractor) when a language claims the file and its
 * grammar loads (depth-parser.ts). When it doesn't load, the file goes to that
 * language's stand-in in the breadth tier and `fellBack` names the language. A
 * container (.vue) is checked before the breadth tier so a future grammar claiming
 * its extension can't shadow it; anything else goes to the breadth tier (generic
 * tags.scm over a WASM grammar).
 */
export interface FileTier {
  lang: Language | null;
  container: ContainerLang | null;
  generic: GenericLang | null;
  fellBack: Language | null;
}

export function tierOf(path: string): FileTier {
  const depth = languageOf(path);
  if (depth) {
    return depthReady(depth)
      ? { lang: depth, container: null, generic: null, fellBack: null }
      : { lang: null, container: null, generic: fallbackLangOf(depth), fellBack: depth };
  }
  const container = containerLangOf(path);
  if (container) return { lang: null, container, generic: null, fellBack: null };
  return { lang: null, container: null, generic: genericLangOf(path), fellBack: null };
}

/** The grammars a set of files needs, by name: what {@link warmGrammars} loads.
 * Plain data, so a parser child (`parse-worker.ts`) can be told to warm exactly
 * what the parent would. Stand-ins are not listed: which ones are needed depends
 * on which depth grammars load, so {@link warmGrammars} works them out after. */
export interface GrammarSet {
  /** Depth-tier languages, a container's embedded language included. */
  depth: Language[];
  /** Breadth-tier grammars of files no depth language or container claims. */
  generic: string[];
  containers: string[];
}

export function grammarsFor(paths: Iterable<string>): GrammarSet {
  const depth = new Set<Language>();
  const generic = new Set<string>();
  const containers = new Set<string>();
  for (const path of paths) {
    const lang = languageOf(path);
    if (lang) { depth.add(lang); continue; }
    const container = containerLangOf(path);
    if (container) { containers.add(container.name); depth.add(container.inner); continue; }
    const g = genericLangOf(path);
    if (g) generic.add(g.name);
  }
  return { depth: [...depth], generic: [...generic], containers: [...containers] };
}

/** Load every WASM grammar in `set`, before a synchronous parse loop can call
 * `extractFile`/`extractGeneric`/`extractContainer`: the depth tier's first, then
 * the breadth tier's plus the stand-in of every depth language whose grammar
 * didn't load (a container's embedded language included), then the containers'. */
export async function warmGrammars(set: GrammarSet): Promise<void> {
  await warmDepthGrammars(set.depth);
  const generic = new Set(set.generic);
  for (const lang of set.depth) if (!depthReady(lang)) generic.add(fallbackLangOf(lang).name);
  await warmGenericGrammars(generic);
  await warmContainerGrammars(set.containers);
}

/** {@link warmGrammars} for the grammars `paths` need. */
export async function warmGrammarsFor(paths: Iterable<string>): Promise<void> {
  await warmGrammars(grammarsFor(paths));
}
