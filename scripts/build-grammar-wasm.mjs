/**
 * Compiles the depth-tier grammars whose npm package ships no .wasm into
 * src/graph/grammars/, and records every depth grammar's .wasm in grammars.json.
 *
 * The depth tier parses on web-tree-sitter (src/graph/depth-parser.ts) with the
 * exact grammar versions the native addons were built from. Most of those packages
 * ship a .wasm next to the addon; python, kotlin and swift don't, so this builds
 * theirs from the package's own src/ (parser.c and scanner.c, never regenerated
 * from grammar.js) with the tree-sitter CLI. The output is committed, so a build
 * needs no compiler: `npm run build` only copies it (scripts/vendor-grammars.mjs).
 *
 * swift's scanner relies on behaviour wasm32 doesn't share with the native addon,
 * so its copy is patched first (PATCHES, below). Without the patches its parses
 * go wrong after the first file.
 *
 * grammars.json pins the bytes test/depth-parity.ts last passed with: for each
 * .wasm, the package version and the file's sha256 (and for a built one, the hash
 * of the C it was built from). test/depth-grammars.test.ts fails when any of that
 * drifts, so bumping a grammar package means running this, then the parity check
 * against real repos.
 *
 * The build is reproducible: the same package and CLI give the same bytes. The CLI
 * fetches wasi-sdk on first use (about 600 MB under ~/.cache/tree-sitter).
 *
 * Usage: node scripts/build-grammar-wasm.mjs            build all three, record all
 *        node scripts/build-grammar-wasm.mjs --record   record only, build nothing
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAMMARS } from "./vendor-grammars.mjs";

/** The tree-sitter CLI that compiles them. */
const CLI = "0.27.1";

/** Source edits applied to the copy that is compiled, never to node_modules:
 * [file under src/, exact text, replacement]. */
export const PATCHES = {
  "tree-sitter-swift": [
    // The `!` operator's suppressor mask is bit 32 of a uint64_t; wasm32's
    // `unsigned long` is 32 bits.
    ["scanner.c", "1UL << FAKE_TRY_BANG", "1ULL << FAKE_TRY_BANG"],
    // The mask is tested with `1 << suppressor`, an int shift past bit 31. The
    // native addon is built at -O3, where that undefined shift vectorizes into a
    // test that passes for every index: the addon drops the scanner's `!` whenever
    // any symbol is valid, which is always, since `!` itself is. So `x!.y` parses
    // its `!` with the grammar's own lexer. Dropping the test reproduces that.
    ["scanner.c", "if (!(suppressing_symbols & 1 << suppressor)) {", "if (0) {"],
    // calloc(0, …) may return NULL in wasm, and the scanner then keeps its state at
    // address 0, where other writes clobber it.
    ["scanner.c", "calloc(0, sizeof(struct ScannerState))", "calloc(1, sizeof(struct ScannerState))"],
  ],
};

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const builtDir = join(root, "src", "graph", "grammars");
const require = createRequire(join(root, "package.json"));

/** sha256 over a grammar's C sources as published, the part the .wasm is made of. */
export function sourceHash(pkgDir) {
  const h = createHash("sha256");
  for (const f of ["parser.c", "scanner.c"]) {
    const p = join(pkgDir, "src", f);
    if (existsSync(p)) h.update(f).update(readFileSync(p));
  }
  return h.digest("hex");
}

export const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function compile(module, pkg, file) {
  // A copy, so neither the patches nor the CLI's build files touch node_modules.
  const work = join(root, "node_modules", ".cache", "grammar-wasm", module);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const f of ["src", "grammar.js", "package.json", "tree-sitter.json"]) {
    if (existsSync(join(pkg, f))) cpSync(join(pkg, f), join(work, f), { recursive: true });
  }
  for (const [name, from, to] of PATCHES[module] ?? []) {
    const p = join(work, "src", name);
    const text = readFileSync(p, "utf8");
    if (!text.includes(from)) throw new Error(`${module}: patch target not found in src/${name}: ${from}`);
    writeFileSync(p, text.replace(from, to));
  }
  execFileSync("npx", ["--yes", `tree-sitter-cli@${CLI}`, "build", "--wasm", "-o", join(builtDir, file), "."], {
    cwd: work,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  rmSync(work, { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const recordOnly = process.argv.includes("--record");
  const manifest = {};
  for (const { module, files, built } of GRAMMARS) {
    const pkg = dirname(require.resolve(`${module}/package.json`));
    const { version } = require(`${module}/package.json`);
    for (const file of files) {
      if (built && !recordOnly) compile(module, pkg, file);
      const path = built ? join(builtDir, file) : join(pkg, file);
      manifest[file] = built
        ? { module, version, cli: CLI, source: sourceHash(pkg), patches: (PATCHES[module] ?? []).length, sha256: sha256(path) }
        : { module, version, sha256: sha256(path) };
      console.log(`${built && !recordOnly ? "built" : "recorded"} ${file} (${module}@${version})`);
    }
  }
  writeFileSync(join(builtDir, "grammars.json"), JSON.stringify(manifest, null, 2) + "\n");
}
