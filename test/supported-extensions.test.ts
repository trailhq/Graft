/**
 * `-e` extension validation (#98): a `graft build -e "<ext>"` must not silently index
 * nothing — the CLI warns on any extension no parser claims. These test the pure helper
 * the warning is built on: the supported set (depth + breadth + container) and which
 * inputs fall outside it, including normalization (leading dot optional, case-insensitive).
 *
 * `.vue` was the extension originally reported in #98 and is used below as a
 * SUPPORTED case: the container tier now claims it (#97). `.svelte` and `.astro`
 * carried the unsupported side until the container tier claimed them too, and
 * they now sit alongside `.vue`. The unsupported side is carried by `.hbs`,
 * which no tier parses — the day someone adds it, this file is where the
 * substitution happens again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { supportedExtensions, unsupportedExtensions } from "../src/graph/source-files.js";

test("supportedExtensions covers both tiers, sorted and de-duped", () => {
  const exts = supportedExtensions();
  // depth tier
  for (const e of [".ts", ".tsx", ".py", ".go", ".java", ".js", ".php", ".kt", ".kts", ".swift"]) assert.ok(exts.includes(e), `depth ${e}`);
  // breadth tier
  for (const e of [".rs", ".rb", ".c", ".cpp"]) assert.ok(exts.includes(e), `breadth ${e}`);
  // container tier
  for (const e of [".vue", ".svelte", ".astro"]) assert.ok(exts.includes(e), `container ${e}`);
  // de-duped (.java is in BOTH tiers but must appear once) and sorted
  assert.equal(exts.filter((e) => e === ".java").length, 1, ".java de-duped across tiers");
  assert.deepEqual(exts, [...exts].sort(), "sorted");
});

test("unsupportedExtensions flags only what has no parser (the #98 repro)", () => {
  // no parser → flagged
  assert.deepEqual(unsupportedExtensions([".hbs"]), [".hbs"]);
  // mixed: supported ones drop out, unsupported stay
  assert.deepEqual(unsupportedExtensions([".ts", ".vue", ".rs", ".hbs"]), [".hbs"]);
  // fully-supported input → nothing flagged, every container extension included
  assert.deepEqual(unsupportedExtensions([".ts", ".php", ".c", ".vue", ".svelte", ".astro"]), []);
});

test("extension normalization: missing dot and mixed case still match a parser", () => {
  // a user typing `-e vue` or `-e .TS` should be judged on the normalized form
  assert.deepEqual(unsupportedExtensions(["ts"]), [], "no leading dot still recognized");
  assert.deepEqual(unsupportedExtensions([".TS", ".Php"]), [], "case-insensitive");
  assert.deepEqual(unsupportedExtensions(["vue"]), [], "container extension recognized without a dot too");
  assert.deepEqual(unsupportedExtensions(["Astro", ".SVELTE"]), [], "the new container extensions normalize too");
  assert.deepEqual(unsupportedExtensions(["Hbs"]), ["Hbs"], "unsupported still flagged, echoed as the user typed it");
});
