/**
 * Language packs — a language graft never heard of, one directory away.
 *
 * Every built-in breadth-tier language is a row in generic.ts plus a grammar the
 * `tree-sitter-wasm` bundle happens to ship. A language the bundle lacks would need a
 * vendored binary in graft's own tree, and a language only one team uses would need a
 * row nobody else wants. A pack moves both out of graft: a directory holding the
 * grammar wasm, the tags query and a manifest, discovered at build time from
 *
 *   <repo>/.graft/langs/<name>/pack.json    (travels with the repo)
 *   ~/.graft/langs/<name>/pack.json         (this machine, every repo)
 *
 * with the repo-level pack winning a name clash. A pack contributes exactly what a
 * built-in row does — extensions, grammar, tags query, optionally one LSP server row —
 * and is refused, with one stderr line, when it would take a language away from a repo:
 * a name or an extension another tier already owns, a grammar or query file that is
 * not there. Refusal never fails the build; the repo indexes as it did before.
 *
 * The manifest:
 *
 *   {
 *     "name": "moon",
 *     "extensions": [".moon"],
 *     "grammar": "tree-sitter-moon.wasm",
 *     "tags": "tags.scm",
 *     "lsp": { "command": "moon-lsp", "args": ["--stdio"], "languageId": "moon" }
 *   }
 *
 * Paths are relative to the pack directory. `tags` is optional — without it the
 * grammar goes through generic.ts's node-kind walker (symbols, no calls), as OCaml and
 * Zig do today. `lsp.args` defaults to none, `lsp.languageId` to the pack's name.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { languageOf } from "./extract.js";
import { containerLangOf } from "./container.js";
import { GENERIC_LANGS, genericLangOf, registerGenericLang } from "./generic.js";
import { registerLspServer } from "./lsp/registry.js";

export interface LanguagePack {
  name: string;
  extensions: string[];
  grammar: string;
  tags?: string;
  lsp?: { command: string; args?: string[]; languageId?: string };
}

export interface PackLoadResult {
  /** Pack names registered by this call (already-registered packs are not repeated). */
  loaded: string[];
  /** Directories that held a pack.json graft could not accept, with the reason. */
  skipped: Array<{ dir: string; reason: string }>;
}

/** The directories searched for `<name>/pack.json`, in priority order. */
export function packDirs(root: string, home: string = homedir()): string[] {
  return [join(resolve(root), ".graft", "langs"), join(home, ".graft", "langs")];
}

const NAME = /^[a-z][a-z0-9_]*$/;
const registered = new Set<string>(); // pack names
const registeredDirs = new Set<string>(); // pack directories, so a re-scan is silent
const seenRoots = new Set<string>();

/**
 * Discover and register the packs that apply to `root`. Idempotent per root: the walk
 * (`listSourceFiles`), the `-e` validation and a test may each call it, and the first
 * call does the work. Returns what it loaded and what it refused; a refused pack is
 * also reported on stderr (`warn`), because silence here is how a language quietly
 * goes missing from a graph.
 */
export function loadLanguagePacks(
  root: string,
  opts: { home?: string; warn?: (message: string) => void } = {},
): PackLoadResult {
  const home = opts.home ?? homedir();
  const key = `${resolve(root)}\0${home}`;
  const result: PackLoadResult = { loaded: [], skipped: [] };
  if (seenRoots.has(key)) return result;
  seenRoots.add(key);
  const warn = opts.warn ?? ((m: string) => console.error(m));

  for (const base of packDirs(root, home)) {
    let entries: string[];
    try {
      entries = readdirSync(base).sort();
    } catch {
      continue; // no such directory — the common case
    }
    for (const entry of entries) {
      const dir = join(base, entry);
      try {
        if (!statSync(dir).isDirectory() || !existsSync(join(dir, "pack.json"))) continue;
      } catch {
        continue;
      }
      if (registeredDirs.has(dir)) continue; // loaded for another (root, home) pair already
      const outcome = loadPack(dir);
      if (outcome.ok) {
        registeredDirs.add(dir);
        result.loaded.push(outcome.name);
      } else {
        result.skipped.push({ dir, reason: outcome.reason });
        warn(`graft: language pack skipped (${dir}): ${outcome.reason}`);
      }
    }
  }
  return result;
}

type Outcome = { ok: true; name: string } | { ok: false; reason: string };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

/** Register one pack, or say why it cannot be. */
function loadPack(dir: string): Outcome {
  let pack: LanguagePack;
  try {
    pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as LanguagePack;
  } catch (err) {
    return refuse(`pack.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof pack.name !== "string" || !NAME.test(pack.name)) return refuse(`"name" must match ${NAME} (got ${JSON.stringify(pack.name)})`);
  if (registered.has(pack.name)) return refuse(`a pack named "${pack.name}" is already loaded (a repo-level pack wins over ~/.graft/langs)`);
  if (GENERIC_LANGS.some((l) => l.name === pack.name)) return refuse(`"${pack.name}" is a built-in language`);
  if (!Array.isArray(pack.extensions) || pack.extensions.length === 0 || !pack.extensions.every((e) => typeof e === "string" && /^\.[A-Za-z0-9_+-]+$/.test(e)))
    return refuse(`"extensions" must be a non-empty list like [".moon"]`);
  const exts = pack.extensions.map((e) => e.toLowerCase());
  for (const e of exts) {
    // A probe file name is enough: every tier decides by extension alone.
    const owner = languageOf(`x${e}`) ?? containerLangOf(`x${e}`)?.name ?? genericLangOf(`x${e}`)?.name;
    if (owner) return refuse(`extension ${e} is already indexed as ${owner}`);
  }
  if (typeof pack.grammar !== "string") return refuse(`"grammar" must name the wasm file`);
  const wasmPath = join(dir, pack.grammar);
  if (!existsSync(wasmPath)) return refuse(`grammar not found: ${pack.grammar}`);
  let queryPath: string | undefined;
  if (pack.tags !== undefined) {
    if (typeof pack.tags !== "string") return refuse(`"tags" must name the tags query file`);
    queryPath = join(dir, pack.tags);
    if (!existsSync(queryPath)) return refuse(`tags query not found: ${pack.tags}`);
  }
  if (pack.lsp !== undefined && (typeof pack.lsp !== "object" || typeof pack.lsp.command !== "string"))
    return refuse(`"lsp" must be { "command": "…", "args": […], "languageId": "…" }`);

  registerGenericLang({ name: pack.name, exts, wasm: pack.name, wasmPath, queryPath });
  if (pack.lsp) {
    registerLspServer({
      languages: [pack.name],
      command: pack.lsp.command,
      args: Array.isArray(pack.lsp.args) ? pack.lsp.args : [],
      languageId: pack.lsp.languageId ?? pack.name,
    });
  }
  registered.add(pack.name);
  return { ok: true, name: pack.name };
}

/** Test seam: forget every loaded pack and root, so tests can load fixtures afresh. */
export function resetLanguagePacksForTest(): void {
  registered.clear();
  registeredDirs.clear();
  seenRoots.clear();
}
