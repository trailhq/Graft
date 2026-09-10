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

/** Load every WASM grammar these files need, before a synchronous parse loop can
 * call `extractFile`/`extractGeneric`/`extractContainer`: the depth tier's first
 * (a container's embedded language included), then the breadth tier's, the
 * containers', and the stand-ins for depth languages whose grammar didn't load. */
export async function warmGrammarsFor(paths: Iterable<string>): Promise<void> {
  const list = [...paths];
  const depth = new Set<Language>();
  for (const path of list) {
    const lang = languageOf(path) ?? containerLangOf(path)?.inner;
    if (lang) depth.add(lang);
  }
  await warmDepthGrammars(depth);
  const generic = new Set<string>();
  const containers = new Set<string>();
  for (const path of list) {
    const t = tierOf(path);
    if (t.generic) generic.add(t.generic.name);
    if (t.container) {
      containers.add(t.container.name);
      if (!depthReady(t.container.inner)) generic.add(fallbackLangOf(t.container.inner).name);
    }
  }
  await warmGenericGrammars(generic);
  await warmContainerGrammars(containers);
}

