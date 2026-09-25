/**
 * Repo-wide ratchet: a native grammar package must never be a static import.
 *
 * #323 — `import kotlin from "tree-sitter-kotlin"` (or any of its siblings) at
 * the top of a module runs the instant that module is loaded, before argv is
 * read. On a platform with no prebuild and no compiler, that import throws and
 * takes the whole CLI down with a node-gyp-build stack trace that never says
 * "graft" — `--version`, `--help`, and every language other than Kotlin died
 * with it. #337 replaced the static imports in extract.ts with `createRequire`
 * calls behind a per-language try/catch; #217 later moved the require itself
 * behind a `grammarOf()` so the module loads on first *parse*, not at import.
 *
 * The regression this guards against is not "someone edits extract.ts wrong" —
 * it is "someone adds an eighth call site". A grep over one file only proves
 * the seven names it currently checks; a new file, or a refactor that
 * re-exports one of these packages under a different name, sails past a scan
 * scoped like that. So this walks the real TypeScript AST over every file in
 * `src/`, not a fixed list, and keys on the import target, not the surrounding
 * text — `import x from "tree-sitter-kotlin"`, `import * as k from "..."`, and
 * a bare `import "tree-sitter-kotlin"` are the same node to this scan.
 *
 * `tree-sitter` itself (the core, JS-only package) is not on the banned list:
 * it has no prebuild to be missing and loading it cannot reproduce #323.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SRC = join(import.meta.dirname, "..", "src");

// The exact packages GRAMMAR_MODULES in src/graph/extract.ts loads lazily.
// Kept as a literal list, not an import from extract.ts: importing that module
// here would defeat the point if it ever regressed back to eager loading.
const BANNED_GRAMMAR_PACKAGES = [
  "tree-sitter-typescript",
  "tree-sitter-python",
  "tree-sitter-go",
  "tree-sitter-java",
  "tree-sitter-kotlin",
  "tree-sitter-swift",
  "tree-sitter-php",
  "tree-sitter-r",
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

/** Every static `import ... from "<banned>"` (or bare `import "<banned>"`) in one file. */
function staticGrammarImports(path: string, source: string): string[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (BANNED_GRAMMAR_PACKAGES.includes(node.moduleSpecifier.text)) hits.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

test("no source file statically imports a native grammar package (#323)", () => {
  const offenders: string[] = [];
  for (const path of walk(SRC)) {
    const hits = staticGrammarImports(path, readFileSync(path, "utf8"));
    if (hits.length > 0) offenders.push(`${path.slice(SRC.length + 1)}: ${hits.join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `a native grammar package is imported statically — it must be loaded lazily ` +
      `(createRequire + try/catch, see src/graph/extract.ts) so a missing prebuild ` +
      `costs one language, not the whole CLI:\n${offenders.join("\n")}`,
  );
});

test("the scanner can actually catch a static grammar import", () => {
  const fixture = `import kotlin from "tree-sitter-kotlin";\nexport const x = kotlin;\n`;
  assert.deepEqual(staticGrammarImports("fixture.ts", fixture), ["tree-sitter-kotlin"]);
});

test("the scanner does not flag the core tree-sitter package or a lazy require", () => {
  const fixture = `import Parser from "tree-sitter";\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nrequire("tree-sitter-kotlin");\n`;
  assert.deepEqual(staticGrammarImports("fixture.ts", fixture), []);
});
