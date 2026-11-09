/**
 * Copies the depth tier's WASM grammars into dist/vendor/grammars/. Runs as part
 * of `npm run build`; src/graph/depth-parser.ts loads them from there.
 *
 * The grammar packages are dev dependencies only. As dependencies they were native
 * addons, and installing the package compiled C wherever one had no prebuilt
 * binary (tree-sitter-kotlin has none at all). What the depth tier needs from each
 * is one .wasm: the package's own where it ships one, else the one
 * scripts/build-grammar-wasm.mjs compiled from its source into src/graph/grammars/.
 * Each grammar's license comes along.
 *
 * Usage: node scripts/vendor-grammars.mjs [outDir]   (default dist/vendor)
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = resolve(process.argv[2] ?? join(root, "dist", "vendor"));
const outDir = join(vendorDir, "grammars");
const require = createRequire(join(root, "package.json"));

/** Mirrors DEPTH_WASM in src/graph/depth-parser.ts, which a test holds this to. */
export const GRAMMARS = [
  { module: "tree-sitter-typescript", files: ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"] },
  { module: "tree-sitter-python", files: ["tree-sitter-python.wasm"], built: true },
  { module: "tree-sitter-go", files: ["tree-sitter-go.wasm"] },
  { module: "tree-sitter-r", files: ["tree-sitter-r.wasm"] },
  { module: "tree-sitter-java", files: ["tree-sitter-java.wasm"] },
  { module: "tree-sitter-kotlin", files: ["tree-sitter-kotlin.wasm"], built: true },
  { module: "tree-sitter-swift", files: ["tree-sitter-swift.wasm"], built: true },
  { module: "tree-sitter-php", files: ["tree-sitter-php.wasm"] },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(outDir, { recursive: true, force: true });
  // Where earlier builds put the native tree-sitter-swift binaries: a dist/ built
  // before would otherwise keep them, and pack them.
  rmSync(join(vendorDir, "tree-sitter-swift"), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const { module, files, built } of GRAMMARS) {
    const pkg = dirname(require.resolve(`${module}/package.json`));
    const { version } = require(`${module}/package.json`);
    for (const file of files) {
      const from = built ? join(root, "src", "graph", "grammars", file) : join(pkg, file);
      if (!existsSync(from)) throw new Error(`${module}@${version}: ${from} is missing`);
      copyFileSync(from, join(outDir, file));
    }
    copyFileSync(join(pkg, "LICENSE"), join(outDir, `${module}.LICENSE`));
  }
  console.log(`vendored grammars → ${outDir} (${GRAMMARS.flatMap((g) => g.files).length} wasm)`);
}
