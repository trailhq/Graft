/**
 * The comment body's shape, which is the part that lies if it gets it wrong.
 *
 * Two bugs live in this file's history. The first `mermaidDiagram` capped the
 * changed-file boxes in diff order and then drew only the arrows whose source box
 * happened to survive: on graft's own 23-file PR that left five of six modules with
 * no arrow, so the picture said "nothing depends on any of this" — the opposite of
 * the report underneath it. The second let test-only modules into the same list as
 * real ones, and a repo with a test per module then reported 31 impacted modules,
 * 24 of them a single test file. Both are asserted against here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markdownReport, mermaidDiagram, textReport } from "../src/blast/render.js";
import type { BlastReport, ChangedArea, ImpactedModule, TestSignal } from "../src/blast/blast.js";

function mod(label: string, from: string[], symbols: number): ImpactedModule {
  return {
    label,
    labelSource: "concept",
    key: label,
    files: [`${label}dep.ts`],
    from,
    symbols: Array.from({ length: symbols }, (_, i) => ({
      id: `${label}dep.ts#s${i}`, name: `s${i}`, kind: "function",
      path: `${label}dep.ts`, span: "L1-L3", relation: "calls", depth: 1,
    })),
  };
}

function area(label: string, files: string[], tests: TestSignal): ChangedArea {
  // "na" is the types-only case: no function, method or class changed, so the
  // question does not apply and the area must not be reported as untested.
  return {
    label, labelSource: "concept", key: label, files, seeds: files.length, tests,
    testFiles: tests === "none" || tests === "na" ? [] : ["test/a.test.ts"],
    changedTestFiles: tests === "changed" ? ["test/a.test.ts"] : [],
    reached: tests === "changed" || tests === "stale" ? 1 : 0,
    behavioural: tests === "na" ? 0 : 1,
    unreached: tests === "none" ? ["doThing"] : [],
    seedNames: ["doThing"],
  };
}

/** Seven affected areas from four changed ones, so both caps are exercised. */
function report(): BlastReport {
  const changed = Array.from({ length: 12 }, (_, i) => ({
    path: `src/f${i}.ts`,
    status: "modified" as const,
    ranges: [{ start: 1, end: 1 }],
  }));
  return {
    basis: "origin/main...HEAD",
    depth: 2,
    changed,
    unindexed: [],
    deleted: [],
    seeds: [],
    impacted: [],
    modules: [
      mod("core/", ["src/f0.ts", "src/f6.ts"], 3),
      mod("api/", ["src/f6.ts"], 2),
      mod("cli/", ["src/f0.ts"], 2),
      mod("db/", ["src/f11.ts"], 1),
      mod("http/", ["src/f0.ts"], 1),
      mod("sync/", ["src/f11.ts"], 1),
      mod("viz/", ["src/f6.ts"], 1),
    ],
    testModules: [mod("test/", ["src/f0.ts"], 9)],
    areas: [
      area("graph build", ["src/f0.ts", "src/f1.ts"], "changed"),
      area("deep pass", ["src/f6.ts"], "stale"),
      area("blast", ["src/f11.ts"], "none"),
      area("types", ["src/f2.ts"], "na"),
    ],
  };
}

test("blast diagram: circles for what can break, and nothing else", () => {
  const diagram = mermaidDiagram(report()) ?? assert.fail("expected a diagram");

  // TB, not LR: with no edges, top-bottom lays unconnected nodes out as a row.
  assert.match(diagram, /^flowchart TB$/m);
  assert.match(diagram, /A0\(\("core\/<br\/>3 symbols"\)\)/);
  // Two of seven affected areas are past the cap: one grey circle carries both.
  assert.match(diagram, /AX\(\("2 smaller areas<br\/>2 symbols"\)\)/);
  assert.ok(!diagram.includes("A5(("), "the sixth area must fold into the tail, not be drawn");

  // The mesh is the thing this diagram exists without. Arrows, the changed side and
  // the glyph key all left together; the attribution lives in the table's column.
  assert.ok(!diagram.includes("-->"), `no arrows may be drawn:\n${diagram}`);
  assert.ok(!diagram.includes("linkStyle"), "nothing to style with no links");
  assert.ok(!/\bD\d\(\(/.test(diagram), "no changed-area circles");
  assert.ok(!diagram.includes("KEY"), "no key node");
});

test("blast diagram: colours are explicit, so either GitHub theme is legible", () => {
  const diagram = mermaidDiagram(report()) ?? assert.fail("expected a diagram");

  assert.match(diagram, /classDef reached fill:#[0-9A-F]{6},stroke:#[0-9A-F]{6},stroke-width:1\.5px,color:#[0-9A-F]{6};/i);
  assert.match(diagram, /classDef tail fill:#[0-9A-F]{6}/i);
  assert.match(diagram, /^\s+class A0,A1,A2,A3,A4 reached;/m);
});

test("blast markdown: one table and three collapsed sections, no per-module headers", () => {
  const body = markdownReport(report());

  assert.match(body, /\*\*4 areas changed → 7 areas can be affected\.\*\* 11 dependent symbols, depth 2\./);
  // The types-only area is absent from this sentence on purpose: an area where no
  // function changed has no test question to answer, and reporting it as untested
  // is how a report earns the reviewer's distrust.
  assert.match(body, /Tests: \*\*no test reaches blast\*\*; deep pass has tests the diff did not touch; 1 area updated its tests\./);
  assert.match(body, /- – \*\*types\*\* — no function, method or class changed here/);

  // Six rows plus a tail row, not 31 sections with one bullet each.
  const rows = body.split("\n").filter((l) => l.startsWith("| "));
  assert.equal(rows.length, 9, `header, divider, 6 areas and the tail:\n${rows.join("\n")}`);
  assert.match(body, /\| core\/ \| 3 \| `core\/dep\.ts:L1-L3` s0 — calls, depth 1 \| graph build, deep pass \|/);
  assert.match(body, /\| _1 smaller area_ \| 1 \|/);

  const sections = body.split("\n").filter((l) => l.startsWith("<summary>"));
  assert.equal(sections.length, 3, `all symbols, test signal, test suites:\n${sections.join("\n")}`);
  // GitHub renders no markdown emphasis inside <summary>, so asterisks would show.
  assert.match(body, /<summary><strong>All 11 dependent symbols<\/strong>, grouped by area<\/summary>/);
  // A ratio in the summary would read as coverage; the state counts cannot.
  assert.match(body, /<summary><strong>Test signal<\/strong> per changed area — 1 ✓ · 1 ⚠ · 1 ✗ · 1 –<\/summary>/);
  assert.match(body, /Reached = a node under a test path has a resolved edge/);
  assert.ok(!body.includes("<summary>**"), "asterisks would render literally");
});

test("blast markdown: test-only dependents are counted, never mixed into the areas", () => {
  const body = markdownReport(report());

  // The 9 test-file symbols are outside the headline, the diagram and the table…
  assert.match(body, /\*\*4 areas changed → 7 areas can be affected\.\*\* 11 dependent symbols/);
  assert.ok(!body.includes("| test/ |"), "a test-only area must not take a table row");
  // …and present as one collapsed line, so the count is not quietly lost.
  assert.match(body, /<summary>1 test suite also references this code<\/summary>/);
  assert.match(body, /9 symbols, kept out of the diagram and the table/);

  assert.match(textReport(report()), /1 test suite also references this code \(not listed\)/);
});

test("markdown: the collapsed list quotes the line that reaches the diff", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-render-"));
  mkdirSync(join(root, "core"), { recursive: true });
  // `mod("core/")` puts its symbols in core/dep.ts at L1-L3, and line 1 is what
  // makes this file part of the radius at all.
  writeFileSync(
    join(root, "core", "dep.ts"),
    'import { thing } from "./f0.js";\nexport function s0() {\n  return thing();\n}\n',
  );

  const md = markdownReport(report(), { root });
  const quoted = '`1: import { thing } from "./f0.js";`';
  assert.ok(md.includes(quoted), "the reaching line is shown");
  // It must stay BELOW the fold: the comment's job is five circles and a table,
  // and this is the part nobody reads by default.
  assert.ok(md.indexOf(quoted) > md.indexOf("<details>"), "quoted inside the collapsed section");
  assert.ok(md.indexOf(quoted) > md.indexOf("```mermaid"), "never above the diagram");

  // No checkout, no snippet — and nothing else changes.
  const bare = markdownReport(report());
  assert.ok(!bare.includes(quoted));
  assert.ok(bare.includes("`core/dep.ts:L1-L3` — s0 (calls, depth 1)"), "the symbol is still listed");
});
