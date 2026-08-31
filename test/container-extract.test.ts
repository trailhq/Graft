/**
 * The container tier: files that wrap another language, `.vue` being the case
 * that motivated it.
 *
 * The assertion that matters in every test here is the SPAN. Slicing the script
 * block out is easy; putting its symbols back on the right `.vue` line is where
 * this can go quietly wrong, and a span that is off by one is worse than no
 * indexing at all — graft's whole promise is that its `file:line` is exact, so a
 * plausible-but-wrong line sends the reader somewhere else with full confidence.
 *
 * Every fixture below is written as an array of lines and joined, so the
 * expected line numbers are the array indices + 1 and can be read off the source
 * rather than counted by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  warmContainerGrammars,
  extractContainer,
  containerLangOf,
  containerExtensions,
  isContainerWarm,
} from "../src/graph/container.js";
import { supportedExtensions } from "../src/graph/source-files.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

const VUE = containerLangOf("Any.vue")!;
const ASTRO = containerLangOf("Any.astro")!;

/** Same contract as `sfc`, named for the Astro fixtures so the two fixture
 * shapes are not confused when a test fails. */
const astro = sfc;

/** Line N of the fixture is `lines[N - 1]` — that is the whole point. */
function sfc(lines: string[]): string {
  return lines.join("\n") + "\n";
}

function spanOf(nodes: { name: string; span: string }[], name: string): string {
  const hit = nodes.find((n) => n.name === name);
  assert.ok(hit, `no node named ${name} (got: ${nodes.map((n) => n.name).join(", ")})`);
  return hit.span;
}

test("container: registry claims .vue and reports it as supported", () => {
  assert.equal(containerLangOf("src/components/Card.vue")?.name, "vue");
  assert.equal(containerLangOf("src/components/Card.VUE")?.name, "vue", "extension match is case-insensitive");
  assert.equal(containerLangOf("src/lib/util.ts"), null);
  assert.ok(containerExtensions().includes(".vue"));
  // Without this, the -e warning added in #100 would call .vue unsupported at
  // the very moment it became supported.
  assert.ok(supportedExtensions().includes(".vue"), ".vue must be in the -e supported set");
});

test("container: spans point at the .vue line, not the script line", async () => {
  await warmContainerGrammars(["vue"]);
  assert.ok(isContainerWarm("vue"), "vue grammar must be available in tree-sitter-wasms");

  const lines = [
    "<template>",                                //  1
    "  <p>{{ title }}</p>",                      //  2
    "</template>",                               //  3
    "",                                          //  4
    '<script setup lang="ts">',                  //  5
    'import { ref } from "vue";',                //  6
    "",                                          //  7
    "const title = ref('hi');",                  //  8
    "",                                          //  9
    "export function shout(what: string) {",     // 10
    "  return what.toUpperCase();",              // 11
    "}",                                         // 12
    "</script>",                                 // 13
  ];

  const { nodes } = extractContainer("Card.vue", sfc(lines), VUE);

  // Line 10 in the file; line 6 inside the script block. Getting 6 here would
  // be the exact failure this tier exists to avoid.
  assert.equal(spanOf(nodes, "shout"), "L10-L12");
});

test("container: a script with nothing above it still lands right", async () => {
  await warmContainerGrammars(["vue"]);

  const lines = [
    '<script setup lang="ts">',        // 1
    "export function first() {}",      // 2
    "</script>",                       // 3
    "",                                // 4
    "<template><b/></template>",       // 5
  ];

  // The offset is 0 here, so this is the case a naive implementation passes and
  // the previous test catches. Kept because it is also the case a fix for the
  // previous test could break.
  assert.equal(spanOf(extractContainer("A.vue", sfc(lines), VUE).nodes, "first"), "L2-L2");
});

test("container: both script blocks are extracted, each with its own offset", async () => {
  await warmContainerGrammars(["vue"]);

  const lines = [
    '<script lang="ts">',                  //  1
    "export function onlyInOptions() {}",  //  2
    "</script>",                           //  3
    "",                                    //  4
    '<script setup lang="ts">',            //  5
    "function onlyInSetup() {}",           //  6
    "</script>",                           //  7
  ];

  const { nodes } = extractContainer("Two.vue", sfc(lines), VUE);
  assert.equal(spanOf(nodes, "onlyInOptions"), "L2-L2");
  assert.equal(spanOf(nodes, "onlyInSetup"), "L6-L6");

  // Whatever the inner extractor does or doesn't emit is its business — the
  // container's job is only to relocate what comes back. A plain `const` is not
  // a symbol in the TypeScript tier, and it must not become one here either.
  assert.equal(nodes.filter((n) => n.kind === "file").length, 1, "exactly one file node");
});

test("container: a name defined in both blocks gets two nodes, not one", async () => {
  await warmContainerGrammars(["vue"]);

  const lines = [
    "<script>",                    // 1
    "function dup() {}",           // 2
    "</script>",                   // 3
    "<script setup>",              // 4
    "function dup() {}",           // 5
    "</script>",                   // 6
  ];

  const { nodes, rawEdges } = extractContainer("Dup.vue", sfc(lines), VUE);
  const dups = nodes.filter((n) => n.name === "dup");

  assert.equal(dups.length, 2, "both definitions survive");
  assert.equal(new Set(dups.map((n) => n.id)).size, 2, "ids are distinct");
  assert.deepEqual(dups.map((n) => n.span).sort(), ["L2-L2", "L5-L5"]);

  // The renamed id must be carried into that block's edges, or the graph points
  // at a node that does not exist.
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of rawEdges) {
    assert.ok(ids.has(e.source), `edge source ${e.source} has no node`);
    if (e.targetId) assert.ok(ids.has(e.targetId), `edge target ${e.targetId} has no node`);
  }
});

test("container: the file node describes the .vue, not the script block", async () => {
  await warmContainerGrammars(["vue"]);

  const lines = [
    "<template>",                     // 1
    "  <p>hola</p>",                  // 2
    "</template>",                    // 3
    "<script setup>",                 // 4
    "const x = 1;",                   // 5
    "</script>",                      // 6
    "<style>.a{color:red}</style>",   // 7
  ];
  const source = sfc(lines);

  const { nodes } = extractContainer("Card.vue", source, VUE);
  const file = nodes[0];

  assert.equal(file.kind, "file");
  assert.equal(file.id, "Card.vue");
  assert.equal(file.span, "L1-L8", "spans the whole SFC, template and style included");
  assert.equal(file.chars, source.length);
  // Depth-tier origin: these symbols carry real bindings and import specifiers,
  // so they must not take resolve.ts's generic guess-by-name path.
  assert.equal(file.origin, "ast");
});

test("container: an SFC with no usable script degrades to a file node", async () => {
  await warmContainerGrammars(["vue"]);

  for (const [label, lines] of [
    ["no script at all", ["<template>", "  <p>static</p>", "</template>"]],
    ["empty script", ["<script></script>", "<template><p/></template>"]],
  ] as const) {
    const { nodes, rawEdges } = extractContainer("Empty.vue", sfc([...lines]), VUE);
    assert.equal(nodes.length, 1, `${label}: file node only`);
    assert.equal(nodes[0].kind, "file");
    assert.equal(rawEdges.length, 0, `${label}: no edges`);
  }
});

test("container: multi-byte characters above the script do not shift the spans", async () => {
  await warmContainerGrammars(["vue"]);

  // Accents and an emoji in the template: if the slice were taken by byte offset
  // against a UTF-16 string, the script would be cut in the wrong place and the
  // symbol would move or vanish.
  const lines = [
    "<template>",                                  // 1
    "  <p>Configuración 🚚 españolísima</p>",      // 2
    "</template>",                                 // 3
    '<script setup lang="ts">',                    // 4
    "export function envío() { return 1; }",       // 5
    "</script>",                                   // 6
  ];

  assert.equal(spanOf(extractContainer("Acc.vue", sfc(lines), VUE).nodes, "envío"), "L5-L5");
});

test("container: a .vue file goes through a real build end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-container-"));
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "src", "helper.ts"),
    "export function greet(name: string) {\n  return `hi ${name}`;\n}\n",
  );
  writeFileSync(
    join(dir, "src", "Card.vue"),
    sfc([
      "<template>",                                   // 1
      "  <p>{{ label }}</p>",                         // 2
      "</template>",                                  // 3
      "",                                             // 4
      '<script setup lang="ts">',                     // 5
      'import { greet } from "./helper";',            // 6
      "",                                             // 7
      "export function label() {",                    // 8
      "  return greet('world');",                     // 9
      "}",                                            // 10
      "</script>",                                    // 11
    ]),
  );

  const outDir = join(dir, "graft");
  await buildGraph(dir, outDir, { reuse: false });
  const graph = readGraph(wiringPath(outDir));

  const label = graph.nodes.find((n) => n.name === "label" && n.path.endsWith("Card.vue"));
  assert.ok(label, "the .vue symbol is in the built graph");
  assert.equal(label.span, "L8-L10");

  // The payoff of routing through the depth tier rather than a generic grammar:
  // the import resolves, so the call from the SFC into a .ts module is a real edge.
  const greet = graph.nodes.find((n) => n.name === "greet");
  assert.ok(greet, "the .ts target is in the graph");
  assert.ok(
    graph.edges.some((e) => e.source === label.id && e.target === greet.id && e.relation === "calls"),
    "the SFC's call into the .ts helper resolved",
  );
});

/**
 * The check has to see every tier the build writes (#236).
 *
 * `checkGraph` re-extracts and diffs against the committed graph, so a tier it
 * cannot extract reads as `removed` — and because the remedy it prints is
 * `graft build`, which wrote those very nodes, the drift can never be cleared.
 * That made `graft check` exit non-zero forever on any repo holding a `.vue`
 * file, which is fatal for the CI drift gate it exists to be.
 *
 * Asserted on a clean build with NOTHING changed in between: the only correct
 * answer there is "in sync", so any drift at all is the bug.
 */
test("container: a clean build of a .vue file checks as in sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-container-check-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "Hello.vue"),
    sfc([
      "<template><div @click=\"greet\">{{ msg }}</div></template>",
      '<script setup lang="ts">',
      "const msg = 'hi';",
      "function greet(): void {",
      "  console.log(msg);",
      "}",
      "</script>",
    ]),
  );

  const outDir = join(dir, "graft");
  await buildGraph(dir, outDir, { reuse: false });
  const built = readGraph(wiringPath(outDir));
  assert.ok(
    built.nodes.some((n) => n.path.endsWith("Hello.vue")),
    "precondition: the build extracted the .vue file",
  );

  const check = await checkGraph(dir, { contextDir: outDir });
  assert.deepEqual(check.removed, [], "a tier the build wrote must not read as removed");
  assert.deepEqual(check.added, []);
  assert.deepEqual(check.changed, []);
  assert.equal(check.ok, true, "a clean build checks OK");
});

/* ---------------------------------------------------------------------------
 * Astro. Same tier, different fence: the embedded block is the `---`
 * frontmatter (`frontmatter` → `frontmatter_js_block`) rather than a
 * `<script>` element, and it holds TypeScript.
 *
 * Frontmatter usually opens on line 1, which makes the offset 0 — the case a
 * naive implementation passes. The tests below therefore lead with a fixture
 * whose fence is pushed down the file, because that is the one that fails when
 * the shift is dropped.
 * ------------------------------------------------------------------------- */

test("container: registry claims .astro and reports it as supported", () => {
  assert.equal(containerLangOf("src/pages/index.astro")?.name, "astro");
  assert.equal(containerLangOf("src/pages/Index.ASTRO")?.name, "astro", "extension match is case-insensitive");
  assert.ok(containerExtensions().includes(".astro"));
  assert.ok(supportedExtensions().includes(".astro"), ".astro must be in the -e supported set");
});

test("container: spans point at the .astro line, not the frontmatter line", async () => {
  await warmContainerGrammars(["astro"]);
  assert.ok(isContainerWarm("astro"), "astro grammar must be available in tree-sitter-wasms");

  const lines = [
    "<!-- a comment above the fence pushes it down the file -->", //  1
    "---",                                                        //  2
    'import Card from "../components/Card.astro";',               //  3
    "",                                                           //  4
    "const rows = await load();",                                 //  5
    "",                                                           //  6
    "export function shout(what: string) {",                      //  7
    "  return what.toUpperCase();",                               //  8
    "}",                                                          //  9
    "---",                                                        // 10
    "<main>",                                                     // 11
    "  <Card rows={rows} />",                                     // 12
    "</main>",                                                    // 13
  ];

  const { nodes } = extractContainer("pages/index.astro", astro(lines), ASTRO);

  // Line 7 in the file; line 6 inside the frontmatter block. Getting 6 here
  // would be the exact failure this tier exists to avoid.
  assert.equal(spanOf(nodes, "shout"), "L7-L9");
});

test("container: a fence at the top of the file still lands right", async () => {
  await warmContainerGrammars(["astro"]);

  const lines = [
    "---",                          // 1
    "export function first() {}",   // 2
    "---",                          // 3
    "<b />",                        // 4
  ];

  // Offset 0 — the shape almost every real .astro file has, and the one a fix
  // for the previous test could break.
  assert.equal(spanOf(extractContainer("A.astro", astro(lines), ASTRO).nodes, "first"), "L2-L2");
});

test("container: multi-byte characters inside the frontmatter do not shift the spans", async () => {
  await warmContainerGrammars(["astro"]);

  // Cyrillic and an emoji above the symbol: if the slice were taken by byte
  // offset against a UTF-16 string, the block would be cut in the wrong place
  // and the symbol would move or vanish.
  const lines = [
    "---",                                        // 1
    'const title = "Поход в горы 🥾";',           // 2
    'const note = "Регламент участия";',          // 3
    "export function label() {",                  // 4
    "  return title;",                            // 5
    "}",                                          // 6
    "---",                                        // 7
    "<h1>{title}</h1>",                           // 8
  ];

  assert.equal(spanOf(extractContainer("Ru.astro", astro(lines), ASTRO).nodes, "label"), "L4-L6");
});

test("container: the file node describes the .astro, not the frontmatter block", async () => {
  await warmContainerGrammars(["astro"]);

  const lines = [
    "---",                            // 1
    "const x = 1;",                   // 2
    "---",                            // 3
    "<main>",                         // 4
    "  <p>{x}</p>",                   // 5
    "</main>",                        // 6
    "<style>.a{color:red}</style>",   // 7
  ];
  const source = astro(lines);

  const { nodes } = extractContainer("Card.astro", source, ASTRO);
  const file = nodes[0];

  assert.equal(file.kind, "file");
  assert.equal(file.id, "Card.astro");
  assert.equal(file.span, "L1-L8", "spans the whole component, markup and style included");
  assert.equal(file.chars, source.length);
  assert.equal(file.origin, "ast");
});

test("container: an .astro with no usable frontmatter degrades to a file node", async () => {
  await warmContainerGrammars(["astro"]);

  for (const [label, lines] of [
    ["no frontmatter at all", ["<main>", "  <p>static</p>", "</main>"]],
    ["empty frontmatter", ["---", "---", "<p />"]],
    // A `<script src>` has an empty `raw_text`, not a missing one: the block is
    // found and handed over, and the inner extractor returns nothing from it.
    ["external script only", ["<main>", '  <script src="/boot.js"></script>', "</main>"]],
  ] as const) {
    const { nodes, rawEdges } = extractContainer("Empty.astro", astro([...lines]), ASTRO);
    assert.equal(nodes.length, 1, `${label}: file node only`);
    assert.equal(nodes[0].kind, "file");
    assert.equal(rawEdges.length, 0, `${label}: no edges`);
  }
});

/* ---------------------------------------------------------------------------
 * Astro client `<script>`: the second embedded shape. Nested in the markup
 * rather than at the root, and living in the same tree as the frontmatter, so
 * the risks are (a) the offset, again, now with a much larger shift, and
 * (b) document order across two different node types.
 * ------------------------------------------------------------------------- */

test("container: a client <script> nested in the markup is extracted", async () => {
  await warmContainerGrammars(["astro"]);

  const lines = [
    "---",                                    //  1
    "const title = 'hi';",                    //  2
    "---",                                    //  3
    "<main>",                                 //  4
    "  <section>",                            //  5
    "    <p>{title}</p>",                     //  6
    "    <script>",                           //  7
    "      export function boot() {",         //  8
    "        return 1;",                      //  9
    "      }",                                // 10
    "    </script>",                          // 11
    "  </section>",                           // 12
    "</main>",                                // 13
  ];

  // Three levels down, and 7 lines below the fence: the offset here is neither
  // zero nor the frontmatter's.
  assert.equal(spanOf(extractContainer("Deep.astro", astro(lines), ASTRO).nodes, "boot"), "L8-L10");
});

test("container: fence and scripts come back in document order, each with its own offset", async () => {
  await warmContainerGrammars(["astro"]);

  const lines = [
    "---",                              //  1
    "export function fromFence() {}",   //  2
    "---",                              //  3
    "<script>",                         //  4
    "function firstScript() {}",        //  5
    "</script>",                        //  6
    "<p>between</p>",                   //  7
    "<script>",                         //  8
    "function secondScript() {}",       //  9
    "</script>",                        // 10
  ];

  const { nodes } = extractContainer("Order.astro", astro(lines), ASTRO);
  assert.equal(spanOf(nodes, "fromFence"), "L2-L2");
  assert.equal(spanOf(nodes, "firstScript"), "L5-L5");
  assert.equal(spanOf(nodes, "secondScript"), "L9-L9");
  assert.equal(nodes.filter((n) => n.kind === "file").length, 1, "exactly one file node");
});

test("container: a name defined in both the fence and a script gets two nodes", async () => {
  await warmContainerGrammars(["astro"]);

  const lines = [
    "---",                    // 1
    "function dup() {}",      // 2
    "---",                    // 3
    "<script>",               // 4
    "function dup() {}",      // 5
    "</script>",              // 6
  ];

  const { nodes, rawEdges } = extractContainer("Dup.astro", astro(lines), ASTRO);
  const dups = nodes.filter((n) => n.name === "dup");

  assert.equal(dups.length, 2, "both definitions survive");
  assert.equal(new Set(dups.map((n) => n.id)).size, 2, "ids are distinct");
  assert.deepEqual(dups.map((n) => n.span).sort(), ["L2-L2", "L5-L5"]);

  const ids = new Set(nodes.map((n) => n.id));
  for (const e of rawEdges) {
    assert.ok(ids.has(e.source), `edge source ${e.source} has no node`);
    if (e.targetId) assert.ok(ids.has(e.targetId), `edge target ${e.targetId} has no node`);
  }
});

test("container: a <script> holding data, not code, is left alone", async () => {
  await warmContainerGrammars(["astro"]);

  // JSON-LD parses fine as a TypeScript block, so nothing downstream would
  // complain — it would just mint nodes out of a structured-data blob.
  const lines = [
    "<head>",                                             //  1
    '  <script type="application/ld+json">',              //  2
    '    {"@type": "Organization", "name": "Acme"}',      //  3
    "  </script>",                                        //  4
    "  <script type=application/json>",                   //  5
    '    {"a": 1}',                                       //  6
    "  </script>",                                        //  7
    '  <script type="module">',                           //  8
    "    export function real() {}",                      //  9
    "  </script>",                                        // 10
    "</head>",                                            // 11
  ];

  const { nodes } = extractContainer("Data.astro", astro(lines), ASTRO);
  assert.equal(spanOf(nodes, "real"), "L9-L9", 'type="module" is JavaScript and is indexed');
  assert.equal(nodes.length, 2, "the file node and `real` — the two data blocks contribute nothing");
});

test("container: isJavaScriptScript reads the type attribute, defaulting to JS", async () => {
  await warmContainerGrammars(["astro"]);

  // Exercised through extraction rather than by hand-building nodes, so the
  // assertion is about behaviour and not about a helper's signature.
  for (const [tag, indexed] of [
    ["<script>", true],
    ['<script is:inline>', true],
    ['<script type="module">', true],
    ["<script type=text/javascript>", true],
    ['<script type="text/typescript">', true],
    ['<script type="application/ld+json">', false],
    ['<script type="importmap">', false],
    ['<script type="speculationrules">', false],
    ["<script type={dynamic}>", false],
  ] as const) {
    const { nodes } = extractContainer("T.astro", astro(["<div>", `  ${tag}`, "  function probe() {}", "  </script>", "</div>"]), ASTRO);
    const hit = nodes.some((n) => n.name === "probe");
    assert.equal(hit, indexed, `${tag} should ${indexed ? "" : "not "}be indexed`);
  }
});

test("container: Vue does not descend into the template — nesting is opt-in per shape", async () => {
  await warmContainerGrammars(["vue"]);

  // Astro's row is `nested`; Vue's is not. A <script> written inside a Vue
  // template is markup the framework never runs as a module, and indexing it
  // would be a behaviour change to `.vue` smuggled in with the Astro work.
  const lines = [
    "<template>",                     // 1
    "  <div>",                        // 2
    "    <script>",                   // 3
    "      function inTemplate() {}", // 4
    "    </script>",                  // 5
    "  </div>",                       // 6
    "</template>",                    // 7
  ];

  const { nodes } = extractContainer("Nested.vue", sfc(lines), VUE);
  assert.equal(nodes.length, 1, "file node only");
  assert.ok(!nodes.some((n) => n.name === "inTemplate"));
});
