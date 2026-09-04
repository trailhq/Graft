/**
 * Container tier — files that are not a language but a wrapper around one.
 *
 * A Vue SFC is the motivating case: `.vue` is HTML-shaped, and everything worth
 * indexing lives inside its `<script>` block. Registering `tree-sitter-vue` as a
 * breadth-tier language (generic.ts) would not help — that grammar parses the
 * shell (`<template>` / `<script>` / `<style>`) and hands back the script body as
 * one opaque `raw_text` node, so the cards would come out empty.
 *
 * Astro's `---` frontmatter is the same shape with a different fence: the
 * grammar hands back one `frontmatter_js_block` holding TypeScript.
 *
 * So the container grammar is used only to answer "where does the embedded
 * language start and end", and the block itself goes to the DEPTH-tier extractor
 * (extract.ts). A `.vue` file therefore gets the same quality of extraction as a
 * `.ts` file — bindings, imports, resolved calls — not the signature-only output
 * the breadth tier would give.
 *
 * **The span shift is the whole risk here.** `extractFile` numbers its spans from
 * the start of the string it was handed, so every node comes back pointing at a
 * line in the script, not in the `.vue`. A span that is off by even one line is
 * worse than not indexing the file at all: graft's promise is that its
 * `file:line` is exact, and a plausible-but-wrong line silently sends the reader
 * to the wrong place. `test/container-extract.test.ts` pins this against
 * fixtures whose true line numbers are known.
 */
import { extractFile, mintId, type ExtractResult, type Language, type RawEdge } from "./extract.js";
import { loadWasmLanguage, parseWasm, type TsNode } from "./generic.js";
import { contentHash } from "../util/id.js";
import type { NodeV1 } from "./types.js";

/** One shape of embedded block inside a container file. A language may carry
 * several: an Astro page keeps its server code in `---` frontmatter and its
 * client code in `<script>`, which are different node types in the same tree. */
export interface EmbeddedBlock {
  /** Wrapper node that represents one embedded block (Vue's `script_element`,
   * Astro's `frontmatter`). */
  block: string;
  /** Child of `block` holding the raw embedded source (Vue's `raw_text`,
   * Astro's `frontmatter_js_block`). */
  body: string;
  /** Search the whole tree instead of the root's named children. Opt-in per
   * shape, not a change to how every container is walked: Astro's client
   * `<script>` sits inside the markup — three levels down in a layout — while
   * a Vue SFC's is always top-level, and letting the Vue row descend would
   * newly index a `<script>` written inside a `<template>`. */
  nested?: boolean;
  /** Last chance to reject a block by its wrapper node, before its body is
   * handed to the depth-tier extractor. */
  accept?: (block: TsNode) => boolean;
}

/** A container language: the wrapper grammar, the nodes that hold the embedded
 * source, and which depth-tier extractor to hand that source to. */
export interface ContainerLang {
  name: string;
  exts: string[];
  /** wasm basename in tree-sitter-wasms/out/tree-sitter-<wasm>.wasm */
  wasm: string;
  /** Every embedded shape, in no particular order — the blocks themselves are
   * returned in document order regardless of which shape found them. */
  embeds: readonly EmbeddedBlock[];
  /** Depth-tier grammar for the embedded language. TypeScript is a superset of
   * JavaScript, so it parses both `<script>` and `<script lang="ts">`. */
  inner: Language;
}

/** The container registry. Svelte is the same shape and would be a row too, but
 * it is left out until someone has a repo to verify it against — a wrong `body`
 * node type would produce silently misplaced spans.
 *
 * **Astro carries two shapes.** The `---` fence holds the imports and the
 * server-side code; the client code lives in `<script>` tags nested inside the
 * markup, which is why that row is `nested` — in a real layout they sit three
 * levels down, and a page can hold one 900-line block that is the whole of its
 * behaviour. Both feed the same TypeScript extractor and are returned in
 * document order, so a name defined in both gets two nodes rather than one
 * shadowing the other. */
export const CONTAINER_LANGS: readonly ContainerLang[] = [
  { name: "vue", exts: [".vue"], wasm: "vue", embeds: [{ block: "script_element", body: "raw_text" }], inner: "typescript" },
  // `frontmatter_js_block` starts on the opening `---` row, exactly as Vue's
  // `raw_text` starts on its tag row, so the existing shift arithmetic applies
  // unchanged: slice line 1 is the tail of the fence line, and slice line N
  // lands on file line N + startPosition.row. Pinned by the tests below.
  {
    name: "astro",
    exts: [".astro"],
    wasm: "astro",
    embeds: [
      { block: "frontmatter", body: "frontmatter_js_block" },
      { block: "script_element", body: "raw_text", nested: true, accept: isJavaScriptScript },
    ],
    inner: "typescript",
  },
];

const byExt = new Map<string, ContainerLang>();
for (const l of CONTAINER_LANGS) for (const e of l.exts) byExt.set(e, l);

/** The container language for a path, or null if none claims it. */
export function containerLangOf(path: string): ContainerLang | null {
  const lower = path.toLowerCase();
  for (const [ext, l] of byExt) if (lower.endsWith(ext)) return l;
  return null;
}

/** Every file extension the container tier claims. */
export function containerExtensions(): string[] {
  return CONTAINER_LANGS.flatMap((l) => l.exts);
}

const loaded = new Map<string, unknown>();

/** Warm the container grammars this repo needs. Same contract as
 * `warmGenericGrammars`: await once before the synchronous parse loop, and an
 * unavailable grammar is skipped rather than fatal (its files then extract to a
 * file node only, exactly as they do today). */
export async function warmContainerGrammars(langNames: Iterable<string>): Promise<void> {
  for (const name of new Set(langNames)) {
    if (loaded.has(name)) continue;
    const row = CONTAINER_LANGS.find((l) => l.name === name);
    if (!row) continue;
    const language = await loadWasmLanguage(row.wasm);
    if (language) loaded.set(name, language);
  }
}

/** True if a container grammar has been warmed (else extraction is file-only). */
export function isContainerWarm(langName: string): boolean {
  return loaded.has(langName);
}

/** `L12-L20` shifted by n lines. The span format is produced in exactly two
 * places (extract.ts and generic.ts) and is always this shape; anything else is
 * returned untouched rather than guessed at. */
function shiftSpan(span: string, lines: number): string {
  const m = /^L(\d+)-L(\d+)$/.exec(span);
  if (!m) return span;
  return `L${Number(m[1]) + lines}-L${Number(m[2]) + lines}`;
}

/** The `.vue` file's own node. Deliberately describes the whole file — line
 * count, hash and size of the SFC, not of the script block — because that is
 * what a reader opening this path will see. */
function containerFileNode(rel: string, source: string, residual: string): NodeV1 {
  return {
    id: rel,
    name: rel.split("/").pop() ?? rel,
    kind: "file",
    path: rel,
    span: `L1-L${Math.max(1, source.split("\n").length)}`,
    signature: null,
    exported: true,
    // "ast", not "generic": the symbols under this file come from the depth-tier
    // extractor with real bindings and specifiers. resolve.ts gates a
    // guess-by-name fallback on `origin === "generic"`, and these nodes must not
    // take it — they carry the information to resolve properly.
    origin: "ast",
    body_hash: contentHash(source),
    chars: source.length,
    body_text: residual,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

/** `<script>` types that mean JavaScript. A tag with no `type` is JS by the
 * HTML spec; `application/ld+json`, `importmap` and `speculationrules` are DATA
 * wearing a script tag. The depth-tier extractor would happily parse a JSON-LD
 * body — `{"@type": "Organization"}` is a syntactically fine TypeScript block —
 * and mint nodes out of a structured-data blob no reader thinks of as code.
 *
 * An unreadable type (`type={dynamic}`) is treated as not-JavaScript: the cost
 * is one un-indexed block, and the alternative is guessing at content we cannot
 * see. */
const JS_SCRIPT_TYPES = new Set([
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/typescript",
  "application/typescript",
  "text/jsx",
  "text/babel",
]);

/** Read one attribute's value off a `start_tag`: the empty string when the
 * attribute is absent or carries no value, and null only when it is present but
 * NOT A LITERAL (`type={expr}`) — the two cases mean different things to the
 * caller. Quoted and bare values differ by one nesting level, so both shapes
 * are walked rather than assumed. */
function attrValue(tag: TsNode, name: string): string | null {
  const kids = tag.namedChildCount ?? 0;
  for (let i = 0; i < kids; i++) {
    const attr = tag.namedChild?.(i);
    if (!attr || attr.type !== "attribute") continue;
    const parts = attr.namedChildCount ?? 0;
    let matched = false;
    for (let j = 0; j < parts; j++) {
      const part = attr.namedChild?.(j);
      if (!part) continue;
      if (part.type === "attribute_name") {
        matched = part.text.toLowerCase() === name;
        if (!matched) break;
        continue;
      }
      if (!matched) continue;
      if (part.type === "attribute_value") return part.text;
      if (part.type === "quoted_attribute_value") {
        const inner = part.namedChild?.(0);
        return inner?.type === "attribute_value" ? inner.text : "";
      }
      // An interpolated value (`type={expr}`) — present but not readable.
      return null;
    }
    // A bare `type` with no value at all. HTML reads that as the empty string,
    // and an empty `type` is a classic script — so it is JavaScript, not an
    // unreadable value.
    if (matched) return "";
  }
  return "";
}

/** True when a `<script>` element holds JavaScript rather than embedded data. */
export function isJavaScriptScript(script: TsNode): boolean {
  const tag = script.namedChild?.(0);
  if (!tag) return false;
  const type = attrValue(tag, "type");
  if (type === null) return false; // present but not a literal
  if (type === "") return true; // absent, or valueless: JS by default
  return JS_SCRIPT_TYPES.has(type.trim().toLowerCase());
}

/** Every node of `type` in the tree, pre-order. Used only for `nested` shapes;
 * a top-level shape stays a single pass over the root's children so the walk
 * cost is unchanged for `.vue`. */
function descendants(root: TsNode, type: string): TsNode[] {
  const found: TsNode[] = [];
  const stack: TsNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node !== root && node.type === type) found.push(node);
    const kids = node.namedChildCount ?? 0;
    for (let i = kids - 1; i >= 0; i--) {
      const child = node.namedChild?.(i);
      if (child) stack.push(child);
    }
  }
  return found;
}

/** Every embedded block in DOCUMENT ORDER, as [bodyNode] — an SFC may legally
 * carry two (`<script>` for options/exports plus `<script setup>`), an Astro
 * page carries a fence plus any number of `<script>` tags, and each needs its
 * own offset.
 *
 * Document order is not cosmetic: `extractContainer` mints ids in the order it
 * receives blocks, so a duplicate name's `~2` suffix would otherwise depend on
 * the order the shapes happen to be listed in the registry. */
function blocks(root: TsNode, lang: ContainerLang): TsNode[] {
  const found: TsNode[] = [];
  for (const embed of lang.embeds) {
    const hosts: TsNode[] = [];
    if (embed.nested) {
      hosts.push(...descendants(root, embed.block));
    } else {
      const n = root.namedChildCount ?? 0;
      for (let i = 0; i < n; i++) {
        const child = root.namedChild?.(i);
        if (child && child.type === embed.block) hosts.push(child);
      }
    }
    for (const host of hosts) {
      if (embed.accept && !embed.accept(host)) continue;
      const kids = host.namedChildCount ?? 0;
      for (let j = 0; j < kids; j++) {
        const body = host.namedChild?.(j);
        // An empty `<script></script>` has no body child at all — skipped here, so
        // the file still gets its file node and nothing else, which is the same
        // shape as a file whose grammar is missing.
        if (body && body.type === embed.body) found.push(body);
      }
    }
  }
  return found.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Extract one container file. Synchronous; needs the grammar pre-warmed.
 *
 * Never throws: a missing grammar, an unparseable SFC or a script block the
 * inner extractor chokes on all degrade to "fewer nodes", because a build must
 * not fail over one component.
 */
export function extractContainer(rel: string, source: string, lang: ContainerLang): ExtractResult {
  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  const residuals: string[] = [];

  const language = loaded.get(lang.name);
  const root = language ? parseWasm(language, source) : null;

  if (root) {
    // Ids are minted per file by the inner extractor, so two script blocks that
    // both define `setup` would collide. Threading one set across the blocks
    // makes the second one `path#setup~2`, and the rename is applied to that
    // block's edges too so nothing points at an id that no longer exists.
    const minted = new Set<string>([rel]);

    for (const body of blocks(root, lang)) {
      const script = source.slice(body.startIndex, body.endIndex);

      let inner: ExtractResult;
      try {
        inner = extractFile(rel, script, lang.inner);
      } catch {
        continue; // one bad block, not a bad build
      }

      // `raw_text` starts immediately after the `>` of the opening tag, so its
      // row IS the tag's row and the slice begins with that line's newline.
      // Script line 1 is therefore the tail of the tag line, and script line N
      // lands on `.vue` line row + N — which is exactly "add the start row to a
      // 1-based span". Taking the row from the tag node instead would look
      // equivalent and be right only when the tag has no attributes.
      const shift = body.startPosition.row;

      // nodes[0] is the script's own file node: it describes the block, not the
      // file, so it is dropped and its residual folded into the .vue file node.
      const [scriptFile, ...symbols] = inner.nodes;
      if (scriptFile?.body_text) residuals.push(scriptFile.body_text);

      const renamed = new Map<string, string>();
      for (const node of symbols) {
        const id = mintId(node.id, minted);
        if (id !== node.id) renamed.set(node.id, id);
        nodes.push({ ...node, id, span: shiftSpan(node.span, shift) });
      }

      for (const edge of inner.rawEdges) {
        const source_ = renamed.get(edge.source) ?? edge.source;
        const targetId = edge.targetId === undefined ? undefined : (renamed.get(edge.targetId) ?? edge.targetId);
        rawEdges.push({ ...edge, source: source_, ...(targetId === undefined ? {} : { targetId }) });
      }
    }
  }

  // Built last so it can carry the residual, but unshifted first so the file node
  // stays at index 0 like every other tier's output.
  nodes.unshift(containerFileNode(rel, source, residuals.join("\n")));
  return { nodes, rawEdges };
}
