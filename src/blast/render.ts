/**
 * Renderers for a {@link BlastReport}: the Mermaid+markdown comment body a CI job
 * posts, and a plain-text report for a terminal.
 *
 * The diagram is the product here — a reviewer should see which areas a change
 * reaches, and whether its tests moved, before reading a single path — so the
 * markdown leads with it and keeps every per-symbol list collapsed underneath.
 * GitHub renders Mermaid natively in comments, so there is nothing to host.
 *
 * Both sides of the diagram are drawn at the same grain: areas, not files. The
 * first version drew one box per changed file, which cannot fit a real PR (24 files
 * against a cap of ten) and told a reviewer nothing per box — `src/graph/write.ts`
 * on its own is not a unit anyone reasons about.
 */
import type { BlastReport, TestSignal } from "./blast.js";

/** Diagram cap. Everything past it folds into one aggregate circle carrying the
 * dropped counts, so the picture shrinks but never lies. */
const MAX_MODULE_BOXES = 5;
/** Rows in the table under the diagram. */
const MAX_TABLE_ROWS = 6;
/** Symbols listed in the one collapsed list of everything. */
const MAX_SYMBOLS_LISTED = 60;

/**
 * A quoted Mermaid label. Every line is escaped on its own and only then joined
 * with `<br/>` — escaping the joined string would eat the tag's own angle brackets
 * and render the literal text "br/" inside the node.
 */
function label(...lines: string[]): string {
  return `"${lines.map(escapeLabel).join("<br/>")}"`;
}

/** Quotes end a Mermaid label, and angle brackets would inject markup into it. */
function escapeLabel(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function depthLabel(depth: number): string {
  return Number.isFinite(depth) ? `depth ${depth}` : "full closure";
}

/**
 * Node colours, taken from `graft viz`'s own palette (viewer/style.css) so the two
 * pictures of the same graph read as one thing: teal is "depends on your change"
 * (`--k-method`), grey is the overflow circle (`--edge`). One hue for one kind of
 * thing, now that the diff itself is not drawn. Fill AND text colour are set
 * explicitly, because a GitHub comment renders in either theme and a node that
 * inherits one of them is illegible in the other.
 */
const VIZ = {
  reachedFill: "#D9EDF3", reachedStroke: "#3AA7C9", reachedInk: "#0E313C",
  tailFill: "#EEF2F3", tailStroke: "#9AA4A9", tailInk: "#3A4247",
} as const;

/** The glyph carried on a changed circle. Meaning lives in the diagram's key. */
const TEST_GLYPH: Record<TestSignal, string> = { changed: "✓", stale: "⚠", none: "✗", na: "–" };

/**
 * The diagram: one circle per area that can be affected, and nothing else.
 *
 * Everything about the changed side is gone on purpose. Drawing which of your edits
 * reaches which area is a many-to-many relation, so it can only ever render as a
 * mesh — nine arrows over eleven circles at its tidiest — and the reviewer has to
 * trace lines to read it. That relation still exists in the table's "Reached from"
 * column, where a reader can look it up when they want it, so the picture is free
 * to answer the only question it is asked at a glance: what can break?
 *
 * `TB`, not `LR`: with no edges, top-bottom is what lays unconnected nodes out as a
 * row instead of a tall column.
 *
 * Returns null when there is nothing to draw — an empty diagram frame reads as a
 * broken renderer, and the caller has a sentence for "no dependents found".
 */
export function mermaidDiagram(r: BlastReport): string | null {
  const shown = r.modules.slice(0, MAX_MODULE_BOXES);
  if (shown.length === 0) return null;
  const hidden = r.modules.slice(MAX_MODULE_BOXES);

  const lines = ["flowchart TB"];
  shown.forEach((m, i) => {
    lines.push(`  A${i}((${label(m.label, plural(m.symbols.length, "symbol"))}))`);
  });
  const TAIL = "AX";
  if (hidden.length > 0) {
    const symbols = hidden.reduce((n, m) => n + m.symbols.length, 0);
    lines.push(`  ${TAIL}((${label(plural(hidden.length, "smaller area"), plural(symbols, "symbol"))}))`);
  }

  lines.push(`  classDef reached fill:${VIZ.reachedFill},stroke:${VIZ.reachedStroke},stroke-width:1.5px,color:${VIZ.reachedInk};`);
  lines.push(`  class ${shown.map((_, i) => `A${i}`).join(",")} reached;`);
  if (hidden.length > 0) {
    lines.push(`  classDef tail fill:${VIZ.tailFill},stroke:${VIZ.tailStroke},stroke-width:1px,color:${VIZ.tailInk};`);
    lines.push(`  class ${TAIL} tail;`);
  }
  return lines.join("\n");
}

/** The PR-comment body: diagram, then one table, then everything else collapsed. */
export function markdownReport(r: BlastReport): string {
  const out: string[] = [];
  const symbols = r.modules.reduce((n, m) => n + m.symbols.length, 0);

  out.push("### 🌱 graft blast radius");
  out.push("");
  out.push(headline(r, symbols));
  const testLine = testHeadline(r);
  if (testLine) out.push(testLine);

  if (symbols > 0) {
    const diagram = mermaidDiagram(r);
    if (diagram) {
      out.push("");
      out.push("```mermaid");
      out.push(diagram);
      out.push("```");
    }
    out.push("");
    out.push(...impactTable(r));
  }

  out.push("");
  out.push(...detailSections(r, symbols));

  const caveats = caveatLines(r);
  if (caveats.length > 0) {
    out.push("");
    for (const line of caveats) out.push(line);
  }
  out.push("");
  out.push(`<sub>\`graft blast\` · ${r.basis} · ${depthLabel(r.depth)} · ${plural(r.changed.length, "changed file")}</sub>`);
  return out.join("\n") + "\n";
}

function headline(r: BlastReport, symbols: number): string {
  const areas = plural(r.areas.length, "area");
  if (symbols === 0) {
    return `**Nothing outside this diff depends on it.** ${areas} changed; no indexed dependents at ${depthLabel(r.depth)}.`;
  }
  return `**${areas} changed → ${plural(r.modules.length, "area")} can be affected.** ${plural(symbols, "dependent symbol")}, ${depthLabel(r.depth)}.`;
}

/**
 * One sentence on whether the diff brought its tests. Leads with the areas that
 * have no tests at all, since that is the only state worth a reviewer's comment.
 */
function testHeadline(r: BlastReport): string | null {
  if (r.areas.length === 0) return null;
  const none = r.areas.filter((a) => a.tests === "none");
  const stale = r.areas.filter((a) => a.tests === "stale");
  const changed = r.areas.filter((a) => a.tests === "changed");
  const parts: string[] = [];
  if (none.length > 0) parts.push(`**no test reaches ${none.map((a) => a.label).join(", ")}**`);
  if (stale.length > 0) parts.push(`${stale.map((a) => a.label).join(", ")} ${stale.length === 1 ? "has tests" : "have tests"} the diff did not touch`);
  if (changed.length > 0) parts.push(`${plural(changed.length, "area")} updated ${changed.length === 1 ? "its" : "their"} tests`);
  if (parts.length === 0) return null;
  return `Tests: ${parts.join("; ")}.`;
}

/**
 * The table replaces 31 collapsed sections that held one bullet each. One row per
 * affected area, with the nearest symbol to start reading at — a reviewer wants a
 * place to look, not an inventory.
 */
function impactTable(r: BlastReport): string[] {
  const shown = r.modules.slice(0, MAX_TABLE_ROWS);
  const hidden = r.modules.slice(MAX_TABLE_ROWS);
  const areaOf = new Map<string, string>();
  for (const a of r.areas) for (const f of a.files) areaOf.set(f, a.label);

  const rows = ["| Can be affected | Symbols | Nearest hop | Reached from |", "| --- | --: | --- | --- |"];
  for (const mod of shown) {
    const nearest = mod.symbols[0];
    const hop = nearest ? `\`${nearest.path}:${nearest.span}\` ${nearest.name} — ${nearest.relation}, depth ${nearest.depth}` : "—";
    // Two names, then a count. Six area names in one cell is what turned this
    // column into a wall wider than the rest of the table put together.
    const names = [...new Set(mod.from.map((f) => areaOf.get(f) ?? f))];
    const from = names.length === 0 ? "—"
      : names.length <= 2 ? names.join(", ")
      : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
    rows.push(`| ${mod.label} | ${mod.symbols.length} | ${hop} | ${from} |`);
  }
  if (hidden.length > 0) {
    const symbols = hidden.reduce((n, m) => n + m.symbols.length, 0);
    rows.push(`| _${plural(hidden.length, "smaller area")}_ | ${symbols} | ${hidden.slice(0, 3).map((m) => m.label).join(", ")}${hidden.length > 3 ? ", …" : ""} | see below |`);
  }
  return rows;
}

/**
 * Everything a reviewer might want and nobody reads by default, in three sections.
 *
 * The blank line after each `</summary>` is required: GitHub renders no markdown
 * inside a details block without it, and `<strong>` rather than `**` because it
 * processes no emphasis inside `<summary>` either.
 */
function detailSections(r: BlastReport, symbols: number): string[] {
  const out: string[] = [];

  if (symbols > 0) {
    out.push("<details>");
    out.push(`<summary><strong>All ${plural(symbols, "dependent symbol")}</strong>, grouped by area</summary>`);
    out.push("");
    let listed = 0;
    for (const mod of r.modules) {
      out.push(`**${mod.label}** — ${plural(mod.symbols.length, "symbol")} in ${plural(mod.files.length, "file")}`);
      out.push("");
      for (const s of mod.symbols) {
        if (listed++ >= MAX_SYMBOLS_LISTED) break;
        out.push(`- \`${s.path}:${s.span}\` — ${s.name} (${s.relation}, depth ${s.depth})`);
      }
      out.push("");
      if (listed >= MAX_SYMBOLS_LISTED) {
        out.push(`…${plural(symbols - listed, "further symbol")} not listed.`);
        out.push("");
        break;
      }
    }
    out.push("</details>");
  }

  if (r.areas.length > 0) {
    const by = (s: TestSignal) => r.areas.filter((a) => a.tests === s).length;
    const states = [
      by("changed") > 0 ? `${by("changed")} ✓` : "",
      by("stale") > 0 ? `${by("stale")} ⚠` : "",
      by("none") > 0 ? `${by("none")} ✗` : "",
      by("na") > 0 ? `${by("na")} –` : "",
    ].filter(Boolean).join(" · ");
    out.push("<details>");
    out.push(`<summary><strong>Test signal</strong> per changed area — ${states}</summary>`);
    out.push("");
    // The caveat leads, because the ratios below invite being read as coverage: a
    // test that drives the CLI in a subprocess produces no edge at all, so a
    // well-tested area can honestly report 1 of 25.
    out.push("_Reached = a node under a test path has a resolved edge into the changed symbol. It undercounts anything called indirectly — through a CLI, a spawned process or a dynamic import — so read a low ratio as “look here”, never as a coverage gate._");
    out.push("");
    for (const a of r.areas) {
      const bits = a.behavioural > 0 ? [`${a.reached} of ${a.behavioural} reached`] : [];
      if (a.changedTestFiles.length > 0) bits.push(`${plural(a.changedTestFiles.length, "test file")} changed here: ${a.changedTestFiles.map((f) => `\`${f}\``).join(", ")}`);
      else if (a.testFiles.length > 0) bits.push(`${plural(a.testFiles.length, "test file")} ${a.testFiles.length === 1 ? "reaches" : "reach"} it, none changed here`);
      else if (a.behavioural > 0) bits.push("no test file reaches it");
      else bits.push("no function, method or class changed here");
      out.push(`- ${TEST_GLYPH[a.tests]} **${a.label}** — ${bits.join(" · ")}`);
      if (a.unreached.length > 0) {
        out.push(`  - not reached: ${a.unreached.slice(0, 8).map((n) => `\`${n}\``).join(", ")}${a.unreached.length > 8 ? `, …${a.unreached.length - 8} more` : ""}`);
      }
    }
    out.push("");
    out.push("</details>");
  }

  if (r.testModules.length > 0) {
    const symbolCount = r.testModules.reduce((n, m) => n + m.symbols.length, 0);
    const files = new Set(r.testModules.flatMap((m) => m.files));
    out.push("<details>");
    out.push(`<summary>${plural(files.size, "test suite")} also ${files.size === 1 ? "references" : "reference"} this code</summary>`);
    out.push("");
    out.push(`${plural(symbolCount, "symbol")}, kept out of the diagram and the table so they cannot crowd out the areas a reviewer has to look at.`);
    out.push("");
    for (const f of [...files].sort().slice(0, 20)) out.push(`- \`${f}\``);
    if (files.size > 20) out.push(`- …${files.size - 20} more`);
    out.push("");
    out.push("</details>");
  }

  return out;
}

/**
 * What the report cannot see. These are the lines that keep a diagram honest: a
 * reader who is not told that four changed files are unindexed will read "no
 * dependents" as "safe".
 */
function caveatLines(r: BlastReport): string[] {
  const out: string[] = [];
  if (r.deleted.length > 0) {
    out.push(
      `⚠️ ${plural(r.deleted.length, "deleted file")} (${r.deleted.slice(0, 5).join(", ")}) — ` +
        "their dependents cannot be computed from a graph built at this commit, since the files are gone from it.",
    );
  }
  if (r.unindexed.length > 0) {
    out.push(
      `⚠️ ${plural(r.unindexed.length, "changed file")} not in the graph (${r.unindexed.slice(0, 5).join(", ")}) — ` +
        "no parser claims the extension, or the index predates the file.",
    );
  }
  return out;
}

/** Terminal report: same content, no markdown scaffolding. */
export function textReport(r: BlastReport): string {
  const symbols = r.modules.reduce((n, m) => n + m.symbols.length, 0);
  const lines = [
    `blast radius — ${r.basis} (${depthLabel(r.depth)})`,
    `  changed: ${plural(r.changed.length, "file")} in ${plural(r.areas.length, "area")}, ${plural(r.seeds.length, "seed symbol")}`,
    `  impacted: ${plural(symbols, "symbol")} in ${plural(r.modules.length, "area")}`,
    "",
  ];

  for (const a of r.areas) {
    lines.push(`${TEST_GLYPH[a.tests]} ${a.label} — ${plural(a.files.length, "changed file")}, ${a.reached}/${a.behavioural} reached by a test`);
  }
  if (r.areas.length > 0) lines.push("");

  for (const mod of r.modules) {
    lines.push(`${mod.label} — ${plural(mod.symbols.length, "symbol")} in ${plural(mod.files.length, "file")}`);
    for (const s of mod.symbols.slice(0, 25)) {
      lines.push(`  ${s.relation} ← ${s.name} (${s.path}:${s.span}) [depth ${s.depth}]`);
    }
    const hidden = mod.symbols.length - 25;
    if (hidden > 0) lines.push(`  …${plural(hidden, "more symbol")}`);
    lines.push("");
  }
  if (symbols === 0) lines.push("no indexed dependents outside the changed files themselves", "");
  if (r.testModules.length > 0) {
    const files = new Set(r.testModules.flatMap((m) => m.files));
    lines.push(`${plural(files.size, "test suite")} also ${files.size === 1 ? "references" : "reference"} this code (not listed)`, "");
  }
  for (const line of caveatLines(r)) lines.push(line.replace(/⚠️ /, "⚠ "), "");
  return lines.join("\n").replace(/\n+$/, "\n");
}

