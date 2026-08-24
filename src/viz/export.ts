/**
 * `graft viz --export <dir>`: the same viewer, as one self-contained HTML file.
 *
 * This exists so a PR comment has somewhere real to point. A Mermaid diagram in a
 * comment can hold about five circles before it stops being readable, and it can
 * never hold the thing a reviewer actually wants next — click an area, see its
 * dependent symbols at exact `file:line`. Every other tool in this space solved
 * that the same way: keep a small table in the comment and link out to a hosted
 * view. Exporting rather than hosting keeps graft's promise intact — no account, no
 * server, no telemetry; the artifact is a file you can open with `file://`, publish
 * to GitHub Pages, or attach to a build.
 *
 * The output inlines the CSS, the bundled JS and both graphs, because a file served
 * from a Pages subdirectory cannot rely on absolute asset paths (`/app.js` resolves
 * to the domain root, not the PR's folder) and a reader must not need a web server.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleContextGraph, type VizGraph } from "./assemble.js";

export interface VizExportOptions {
  contextDir: string;
  /** Where index.html, app.js and style.css were bundled (dist/viewer). */
  viewerDir: string;
  /** Directory to write index.html into. Created if absent. */
  outDir: string;
  repoName: string;
  /** Shown in the appbar beside the repo name — e.g. "PR #151". */
  subtitle?: string;
  /**
   * Context graph to inline instead of assembling one from the deep tier's concept
   * files. `graft blast --export-viz` passes the blast radius itself, which is how a
   * PR gets a Context tab worth opening without a `--deep` build.
   */
  contextGraph?: VizGraph;
  /**
   * Tabs the page offers. Default: all three.
   *
   * A blast page passes `["context"]`. The Code tab there is the repo's whole
   * wiring graph — 1,377 nodes on graft itself, a hairball that answers nothing
   * about the pull request, and ~95% of the exported megabyte — and Outline is the
   * repo's file tree. Dropping them makes the page a tenth of the size and removes
   * two tabs a reviewer has no reason to open.
   */
  tabs?: Array<"context" | "code" | "outline">;
}

export interface VizExportResult {
  file: string;
  bytes: number;
  contextNodes: number;
  codeNodes: number;
  /** Tab the exported page opens on — see the reasoning in {@link exportViz}. */
  defaultTab: "context" | "code";
  /** Tabs written into the page. */
  tabs: Array<"context" | "code" | "outline">;
}

/** The wiring graph as the viewer's endpoint would have served it, or null. */
function codeGraph(contextDir: string): unknown {
  const file = join(contextDir, ".graph", "wiring.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { meta?: { version?: number } };
    return parsed?.meta?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * JSON safe to drop inside a `<script>` element.
 *
 * `</script>` anywhere in the data — a summary quoting HTML, a symbol named after a
 * tag — would close the element and spill the rest of the graph into the page as
 * text. `<` is escaped as a unicode sequence, which is still valid JSON to the
 * parser and inert to the HTML tokenizer.
 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    // Line and paragraph separators are legal in a JSON string and illegal in a
    // JavaScript source line, so an unescaped one is a syntax error at load time.
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The two tags this exporter rewrites, verbatim from viewer/index.html. */
const LINK_TAG = '<link rel="stylesheet" href="/style.css">';
const SCRIPT_TAG = '<script type="module" src="/app.js"></script>';

export function exportViz(opts: VizExportOptions): VizExportResult {
  const html = readFileSync(join(opts.viewerDir, "index.html"), "utf8");

  // Checked on the SOURCE, before anything is inlined. Checking the assembled page
  // instead looks equivalent and is not: a stylesheet comment or a bundled string
  // containing one of these tags would fail an export that was in fact correct.
  if (!html.includes(LINK_TAG) || !html.includes(SCRIPT_TAG)) {
    throw new Error("viz export: viewer/index.html no longer matches the asset tags this exporter rewrites");
  }
  const css = readFileSync(join(opts.viewerDir, "style.css"), "utf8");
  const js = readFileSync(join(opts.viewerDir, "app.js"), "utf8");

  const context = opts.contextGraph ?? assembleContextGraph(opts.contextDir);
  const tabs = opts.tabs ?? ["context", "code", "outline"];
  // Both remaining tabs read the wiring graph, so dropping them drops the payload
  // as well — the point of the option, not a side effect of it.
  const wanted = tabs.includes("code") || tabs.includes("outline");
  const code = wanted ? codeGraph(opts.contextDir) : null;

  // Which tab to open on. The viewer starts on Context, which only a `--deep` build
  // fills: a structural build writes wiring cards (no frontmatter, so nothing to
  // assemble) and INDEX.md, and INDEX alone assembles to a single node. Since the
  // PR path is now structural by design, opening on Context would show a canvas
  // with one dot while the whole wiring graph sat behind an unadvertised tab.
  const codeNodes = (code as { nodes?: unknown[] } | null)?.nodes?.length ?? 0;
  // A supplied graph is the caller's whole point, so it is always the landing tab.
  const defaultTab = opts.contextGraph || context.nodes.length > 1 || codeNodes === 0 ? "context" : "code";
  const contextGraph = {
    ...context,
    meta: { ...context.meta, repoName: opts.repoName, subtitle: opts.subtitle, defaultTab, tabs },
  };

  const data = [
    "<script>window.__GRAFT_DATA__ = {",
    `  contextGraph: ${inlineJson(contextGraph)},`,
    `  codeGraph: ${inlineJson(code)}`,
    "};</script>",
  ].join("\n");

  // Replacer FUNCTIONS, not replacement strings: `$&`, `$\'` and friends are
  // substitution patterns inside a replacement string, and a minified bundle is
  // full of them — the first version of this put the original `<script src>` tag
  // back into the page via a stray `$&` in app.js. A function is taken verbatim.
  const page = html
    .replace(LINK_TAG, () => `<style>\n${css}\n</style>`)
    .replace(SCRIPT_TAG, () => `${data}\n<script type="module">\n${js}\n</script>`);

  mkdirSync(opts.outDir, { recursive: true });
  const file = join(opts.outDir, "index.html");
  writeFileSync(file, page);
  return { file, bytes: Buffer.byteLength(page), contextNodes: contextGraph.nodes.length, codeNodes, defaultTab, tabs };
}
