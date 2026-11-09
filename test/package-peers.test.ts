/**
 * Installing the package runs nothing and warns about nothing.
 *
 * An install script in the dependency tree is what made `npm install -g` compile
 * C: the depth tier's grammars were native addons, and `tree-sitter-kotlin` has no
 * prebuilt binary, so node-gyp ran (slowly, and not at all without a compiler).
 * They are WASM now (src/graph/depth-parser.ts) and the addons are dev
 * dependencies. An unmet peer is what printed a wall of "ERESOLVE overriding peer
 * dependency" warnings: tree-sitter-swift asked for a tree-sitter the package
 * didn't ship. The repo's own `overrides` hide that here, because npm applies
 * overrides only to the project it is run in, never to the people installing the
 * package, so both are read off the lockfile instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
type Entry = {
  version: string;
  dev?: boolean;
  hasInstallScript?: boolean;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, Entry> };
/** What `npm install` of the published package puts on disk: the lockfile minus dev-only entries. */
const shipped = Object.entries(lock.packages).filter(([path, e]) => path !== "" && !e.dev);
const nameOf = (path: string): string => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

/** `version` satisfies `range`, for the plain `^x.y.z` ranges grammars use, joined by `||`. */
function satisfies(version: string, range: string): boolean {
  const [maj, min, pat] = version.split(".").map(Number);
  return range.split("||").some((part) => {
    const m = /^\s*\^(\d+)\.(\d+)\.(\d+)\s*$/.exec(part);
    assert.ok(m, `peer range "${part.trim()}" is not a ^x.y.z range; teach this test to read it`);
    const [a, b, c] = m.slice(1).map(Number);
    if (a !== maj) return false;
    if (a > 0) return min! > b! || (min === b && pat! >= c!);
    return min === b && pat! >= c!;
  });
}

test("no dependency of the package runs an install script, so installing it compiles nothing", () => {
  const scripted = shipped.filter(([, e]) => e.hasInstallScript).map(([path, e]) => `${nameOf(path)}@${e.version}`);
  assert.deepEqual(scripted, []);
});

test("every required peer of a dependency ships with the package, in a version it accepts", () => {
  const versions = new Map(shipped.map(([path, e]) => [nameOf(path), e.version]));
  const clashes: string[] = [];
  for (const [path, e] of shipped) {
    for (const [peer, range] of Object.entries(e.peerDependencies ?? {})) {
      if (e.peerDependenciesMeta?.[peer]?.optional) continue;
      const have = versions.get(peer);
      if (!have || !satisfies(have, range)) clashes.push(`${nameOf(path)} wants ${peer} ${range}, ships ${have ?? "none"}`);
    }
  }
  assert.deepEqual(clashes, []);
});

test("the range check reads carets the way npm does", () => {
  assert.ok(satisfies("0.21.1", "^0.21.0"));
  assert.ok(!satisfies("0.21.1", "^0.22.1"));
  assert.ok(satisfies("0.21.1", "^0.22.1 || ^0.21.1"));
  assert.ok(satisfies("1.4.0", "^1.3.0"));
  assert.ok(!satisfies("2.0.0", "^1.3.0"));
});
