/**
 * The blast radius as a viewer graph.
 *
 * This is the Context tab of the page a PR comment links to, so the two things that
 * matter are that it carries the SAME names the comment shows — one computation, not
 * two — and that its edges point the way the viewer words them: the affected area
 * depends on the changed one, never the reverse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { blastVizGraph } from "../src/blast/viz.js";
import { repoLabel } from "../src/blast/blast-cli.js";
import type { BlastReport, ChangedArea, ImpactedModule, Seed } from "../src/blast/blast.js";
import type { ChangedFile, DiffLine } from "../src/blast/diff.js";

function mod(label: string, from: string[], symbols: number): ImpactedModule {
  return {
    label, labelSource: "named", key: label,
    files: [`${label}dep.ts`],
    from,
    symbols: Array.from({ length: symbols }, (_, i) => ({
      id: `${label}dep.ts#s${i}`, name: `s${i}`, kind: "function",
      path: `${label}dep.ts`, span: `L${i + 1}-L${i + 3}`, relation: "calls", depth: i + 1,
    })),
  };
}

function area(label: string, files: string[]): ChangedArea {
  return {
    label, labelSource: "named", key: label, files, seeds: files.length,
    tests: "none", testFiles: [], changedTestFiles: [],
    reached: 0, behavioural: 2, unreached: ["doThing", "doOther"], seedNames: ["doThing"],
  };
}

/** A changed function, and the hunk git reported inside its span. */
function seed(name: string, path: string, span: string, kind = "function"): Seed {
  return { id: `${path}#${name}`, name, kind, path, span, wholeFile: false };
}

function changedFile(path: string, lines: DiffLine[], start = 2): ChangedFile {
  return {
    path, status: "modified",
    ranges: [{ start, end: start + lines.length - 1 }],
    hunks: [{ start, end: start + lines.length - 1, lines, dropped: 0 }],
  };
}

function report(): BlastReport {
  return {
    basis: "origin/main...HEAD", depth: 2,
    changed: [changedFile("src/a.ts", [
      { n: null, sign: "-", text: "  return 1;" },
      { n: 2, sign: "+", text: "  return 2;" },
    ])],
    unindexed: [".github/workflows/x.yml"],
    deleted: [],
    seeds: [seed("doThing", "src/a.ts", "L1-L4"), seed("Options", "src/a.ts", "L9-L12", "interface")],
    impacted: [],
    modules: [mod("Query Freshness Gate", ["src/a.ts", "test/a.test.ts"], 2), mod("MCP Tool Surface", ["src/a.ts"], 1)],
    testModules: [mod("Test Suites", ["src/a.ts"], 9)],
    areas: [area("LLM Failure Gate", ["src/a.ts"])],
  };
}

test("blast viz: one node per area, typed so the viewer colours and legends itself", () => {
  const g = blastVizGraph(report());

  assert.deepEqual(
    g.nodes.map((n) => `${n.type}:${n.name}`),
    ["changed:LLM Failure Gate", "affected:Query Freshness Gate", "affected:MCP Tool Surface"],
    "the names are the comment's names — the page is not a second computation",
  );
  // Test-only dependents stay out here too: 9 symbols of "your tests call this"
  // would be the biggest node on the canvas.
  assert.ok(!g.nodes.some((n) => n.name === "Test Suites"), "test-only clusters are not drawn");
  assert.equal(g.meta.nodeCount, 3);
  assert.equal(g.meta.skippedFiles, 1, "changed files no parser claims are carried, not hidden");
});

test("blast viz: edges are the dependency, so the viewer's wording comes out right", () => {
  const g = blastVizGraph(report());

  assert.deepEqual(g.edges.map((e) => `${e.source} -${e.relation}-> ${e.target}`), [
    "affected:Query Freshness Gate -depends_on-> changed:LLM Failure Gate",
    "affected:MCP Tool Surface -depends_on-> changed:LLM Failure Gate",
  ]);
  // `test/a.test.ts` reached the first module but belongs to no area, so it must not
  // produce a dangling edge the viewer would silently drop.
  assert.equal(g.edges.length, 2);
});

test("blast viz: a changed node names what it edited, and says it once about tests", () => {
  const g = blastVizGraph(report());
  const [changed] = g.nodes;

  // The old copy counted ("2 files, 3 symbols") and then said the same thing about
  // tests twice, with `0 of 2` reading like a coverage score.
  assert.equal(
    changed.summary,
    "Edits doThing, plus Options in 1 file. No test reaches this code.",
    "the symbols it edited, then one sentence on tests",
  );
  assert.ok(!/0 of 2/.test(changed.summary), "no ratio that reads as coverage");
});

test("blast viz: a changed node shows its hunk, split by symbol", () => {
  const g = blastVizGraph(report());
  const [changed] = g.nodes;

  assert.equal(changed.evidence?.length, 1, "only doThing's span holds the hunk");
  const [ev] = changed.evidence!;
  // Grep-able: a reader can type the symbol name, not a line span.
  assert.equal(ev.label, "doThing · src/a.ts:1-4");
  assert.deepEqual(ev.lines, [
    { n: null, sign: "-", text: "  return 1;" },
    { n: 2, sign: "+", text: "  return 2;" },
  ]);
});

test("blast viz: an affected node quotes the line that reaches the diff", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-blast-ev-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // s0's span is L1-L3, and line 2 is the call that put it in the radius.
  writeFileSync(
    join(root, "Query Freshness Gatedep.ts"),
    "export function s0() {\n  return doThing(1);\n}\n",
  );

  const g = blastVizGraph(report(), { root });
  const affected = g.nodes.find((n) => n.type === "affected");

  assert.equal(
    affected?.summary,
    "Not edited by this PR. 2 symbols here reach code it changed — nearest is s0, 1 hop away.",
    "leads with the fact that this area is collateral, not part of the diff",
  );
  const [ev] = affected!.evidence!;
  assert.deepEqual(ev.lines, [{ n: 2, sign: " ", text: "  return doThing(1);" }]);
  assert.equal(ev.note, "calls doThing", "says WHICH changed symbol this line reaches");
});

test("blast viz: a file-level dependent is quoted at its import, not at its doc comment", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-blast-imp-"));
  // A whole-file node: nothing in it names a changed SYMBOL, and its first line is
  // a doc comment — quoting that spent a code block to say nothing.
  writeFileSync(
    join(root, "Query Freshness Gatedep.ts"),
    '/**\n * A module.\n */\nimport { thing } from "./a.js";\n',
  );
  const r = report();
  r.modules = [{
    ...r.modules[0],
    symbols: [{ id: "x", name: "dep.ts", kind: "file", path: "Query Freshness Gatedep.ts", span: "L1-L4", relation: "imports", depth: 1 }],
  }];

  const [ev] = blastVizGraph(r, { root }).nodes.find((n) => n.type === "affected")!.evidence!;
  assert.deepEqual(ev.lines, [{ n: 4, sign: " ", text: 'import { thing } from "./a.js";' }], "the import line, matched on the changed module");
  assert.equal(ev.note, "imports");

  // And with nothing to point at, no block at all rather than a `/**`.
  writeFileSync(join(root, "Query Freshness Gatedep.ts"), "/**\n * A module.\n */\nconst x = 1;\n");
  const quiet = blastVizGraph(r, { root: mkdtempSync(join(tmpdir(), "graft-empty-")) });
  assert.equal(quiet.nodes.find((n) => n.type === "affected")?.evidence, undefined);
});

test("blast viz: an unreadable file costs the snippet, not the page", () => {
  // No root: nothing to read. The nodes, names and edges must all survive.
  const g = blastVizGraph(report());
  const affected = g.nodes.find((n) => n.type === "affected");
  assert.equal(affected?.evidence, undefined);
  assert.equal(affected?.sources.length, 2, "the paths are still listed");
  assert.equal(g.edges.length, 2);
});

test("blast viz: nothing is capped, unlike the comment's diagram", () => {
  const r = report();
  r.modules = Array.from({ length: 12 }, (_, i) => mod(`Area ${i}`, ["src/a.ts"], 1));

  const g = blastVizGraph(r);

  assert.equal(g.nodes.length, 13, "a pannable canvas has no reason to drop areas");
  assert.equal(g.edges.length, 12);
});

test("blast viz: the page is titled after the repository, not the checkout directory", () => {
  // CI checks a pull request out into a directory named for the job — ours is `pr` —
  // so a published page announced itself as "pr". The remote is the repository.
  const dir = mkdtempSync(join(tmpdir(), "pr"));
  assert.equal(repoLabel(dir), basename(dir), "no remote: the directory name is all there is");

  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:NanoNets/Graft.git"]);
  assert.equal(repoLabel(dir), "Graft", "an ssh remote names the repo, not the owner or the path");

  execFileSync("git", ["-C", dir, "remote", "set-url", "origin", "https://github.com/NanoNets/Graft"]);
  assert.equal(repoLabel(dir), "Graft", "and an https remote with no .git suffix reads the same");
});

test("blast viz: an empty radius says why, instead of publishing a blank canvas", () => {
  // A lockfile- or workflow-only PR has no radius, and the page published for it
  // was a blank canvas behind a link promising a diagram — indistinguishable from
  // a broken export.
  const r = report();
  r.areas = [];
  r.modules = [];
  r.changed = [
    { path: ".github/workflows/x.yml", status: "modified", ranges: [{ start: 1, end: 1 }] },
    { path: "package-lock.json", status: "modified", ranges: [{ start: 1, end: 1 }] },
  ];
  r.unindexed = [".github/workflows/x.yml", "package-lock.json"];

  const g = blastVizGraph(r);
  assert.equal(g.nodes.length, 0);
  assert.match(g.meta.emptyNote ?? "", /no parser claims 2 changed files/);
  assert.match(g.meta.emptyNote ?? "", /\.github\/workflows\/x\.yml, package-lock\.json/);

  // A radius that exists needs no excuse — the note must not appear on a real page.
  assert.equal(blastVizGraph(report()).meta.emptyNote, undefined);

  // Changed code with no dependents is a different answer from unparsed files.
  const orphan = report();
  orphan.areas = [];
  orphan.modules = [];
  orphan.unindexed = [];
  assert.match(blastVizGraph(orphan).meta.emptyNote ?? "", /no resolved dependents/);
});
