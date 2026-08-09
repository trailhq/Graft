/**
 * Resolve {@link RawEdge} intents into concrete {@link EdgeV1} edges by matching
 * names/specifiers against the whole-repo node index.
 *
 * Confidence mirrors the SCIP/Graphify model:
 *   - `extracted`: the target is certain — a match within the same file, an
 *     import specifier, or a structural containment.
 *   - `inferred`: a bare function target was resolved by a unique name match
 *     across files, which name-shadowing could in principle fool.
 * Ambiguous cross-file matches (a name defined in several files) are dropped
 * rather than guessed. Member calls are stricter: they require a receiver type
 * and owner-qualified method match because a unique bare method name says
 * nothing about the receiver.
 */
import { posix } from "node:path";
import { toPosixPath } from "../util/paths.js";
import type { EdgeV1, Kind, NodeV1, Relation } from "./types.js";
import type { RawEdge } from "./extract.js";

const IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];

/** A Go module discovered in the repo: its `module` path from `go.mod` and the repo
 * directory that `go.mod` lives in (posix, `.` for the repo root). A monorepo may hold
 * several — e.g. `backend/go.mod`, `tools/go.mod`. */
export interface GoModule {
  module: string;
  dir: string;
}

export interface ResolveOptions {
  /** The Go modules found in the repo. Enables mapping Go import package paths
   * (`example.com/app/pkg/util`) to the in-repo directory they name, relative to the
   * owning module's `go.mod` location. Empty/absent → Go imports stay external strings. */
  goModules?: GoModule[];
}

export function resolveEdges(
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  opts: ResolveOptions = {},
): EdgeV1[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const globalName = new Map<string, NodeV1[]>();
  const perFileName = new Map<string, Map<string, NodeV1[]>>();
  // Owner-qualified method index: "Owner.method" → candidate method nodes, for
  // typed member-call resolution (recvType + name → a specific class's method).
  const ownerMethod = new Map<string, NodeV1[]>();
  // Go package resolution: dir (posix) → its `.go` file node ids, for import mapping.
  const goFilesByDir = new Map<string, string[]>();
  const hasGoModules = !!opts.goModules?.length;
  for (const n of nodes) {
    if (n.kind === "file") {
      if (hasGoModules && n.path.endsWith(".go")) {
        const dir = posix.dirname(toPosixPath(n.path));
        push(goFilesByDir, dir, n.id);
      }
      continue;
    }
    push(globalName, n.name, n);
    let fileMap = perFileName.get(n.path);
    if (!fileMap) perFileName.set(n.path, (fileMap = new Map()));
    push(fileMap, n.name, n);
    if (n.kind === "method" && n.owner) {
      push(ownerMethod, `${n.owner}.${n.name}`, n);
    }
  }

  // classParents: class/interface name → its declared base-class names, from raw
  // `extends` edges (source id's own name → the base name). Used to walk up an
  // inheritance chain when a receiver's own type has no matching method.
  const classParents = new Map<string, string[]>();
  for (const e of rawEdges) {
    if (e.relation !== "extends" || !e.name) continue;
    // The declaring class's own bare name — read from its node (keyed by n.name, set
    // once at mint time) rather than re-derived by slicing e.source, which breaks once
    // ids can carry a dedup ordinal (A3's `Cache~2`).
    const ownName = byId.get(e.source)?.name;
    if (!ownName) continue;
    push(classParents, ownName, e.name);
  }

  const out: EdgeV1[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, relation: Relation, confidence: EdgeV1["confidence"]) => {
    const key = `${source}\0${relation}\0${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, target, relation, confidence });
  };

  for (const e of rawEdges) {
    if (e.relation === "contains" && e.targetId) {
      add(e.source, e.targetId, "contains", "extracted");
    } else if (e.relation === "imports" && e.specifier) {
      const target =
        hasGoModules && e.file.endsWith(".go")
          ? resolveGoImport(e.specifier, opts.goModules!, goFilesByDir)
          : resolveImport(e.specifier, e.file, byId);
      add(e.source, target, "imports", "extracted");
    } else if (e.relation === "extends" || e.relation === "implements") {
      const kinds: Kind[] = e.relation === "implements" ? ["interface"] : ["class", "interface"];
      const hit = resolveName(e.name!, e.file, kinds, perFileName, globalName);
      // an unresolved base is usually an external/imported type — keep the name.
      add(e.source, hit?.id ?? e.name!, e.relation, hit?.confidence ?? "inferred");
    } else if (e.relation === "references" && e.name && e.specifier) {
      // A named import gives both halves needed for sound resolution: the module
      // it came from and the exported name. Resolve inside that file only, so a
      // same-named symbol elsewhere in the repo cannot become a false edge.
      const targetFile = resolveImport(e.specifier, e.file, byId);
      if (!byId.has(targetFile)) continue; // external or unresolved module
      const candidates = perFileName.get(targetFile)?.get(e.name) ?? [];
      if (candidates.length === 1) add(e.source, candidates[0].id, "references", "extracted");
    } else if (e.relation === "calls") {
      if (e.viaMember) {
        if (!e.recvType) continue;
        const hit = resolveTypedMember(e.recvType, e.name!, e.file, ownerMethod, classParents);
        if (hit === "ambiguous") continue; // drop — never guess past an ambiguous owner
        if (hit) add(e.source, hit.id, "calls", hit.confidence);
        // No owner-qualified match means the call is unresolved. A unique bare
        // method name is not evidence that this receiver has that method.
        continue;
      }
      // Every language's bare-name call is a free function, except R (Phase 4):
      // an untyped `obj$method()` there sets e.kinds to also allow a "method"
      // match — see extract.ts's calleeName R branch for why (R6 methods are
      // never kind "function", so without this every such call would be
      // unconditionally unresolvable rather than just occasionally ambiguous).
      const hit = resolveName(e.name!, e.file, e.kinds ?? ["function"], perFileName, globalName);
      if (hit) add(e.source, hit.id, "calls", hit.confidence); // drop unresolved calls (too noisy)
    }
  }
  return out;
}

function push<T>(map: Map<string, T[]>, key: string, val: T): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

/**
 * Resolve a bare symbol name: same-file match first (certain → `extracted`),
 * else a unique cross-file match (→ `inferred`), else null (ambiguous/unknown).
 */
function resolveName(
  name: string,
  file: string,
  kinds: Kind[],
  perFileName: Map<string, Map<string, NodeV1[]>>,
  globalName: Map<string, NodeV1[]>,
): { id: string; confidence: EdgeV1["confidence"] } | null {
  const local = (perFileName.get(file)?.get(name) ?? []).filter((n) => kinds.includes(n.kind));
  if (local.length) return { id: local[0].id, confidence: "extracted" };
  const global = (globalName.get(name) ?? []).filter((n) => kinds.includes(n.kind));
  if (global.length === 1) return { id: global[0].id, confidence: "inferred" };
  return null;
}

/**
 * Resolve a typed member call (`recvType.name`) against the owner-qualified method
 * index, walking the receiver's extends chain when its own type has no match.
 *
 * Returns:
 *   - `{ id, confidence }` — resolved: a single candidate at some owner level (or the
 *     same-file one among several).
 *   - `"ambiguous"` — several candidates at some owner level and none is same-file;
 *     per the inviolable philosophy we drop and stop rather than guess, and we do
 *     NOT continue up the chain past this level.
 *   - `null` — the whole chain (recvType + ancestors, breadth-first, depth ≤ 3,
 *     cycle-guarded) had zero candidates at every level.
 */
function resolveTypedMember(
  recvType: string,
  name: string,
  file: string,
  ownerMethod: Map<string, NodeV1[]>,
  classParents: Map<string, string[]>,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const MAX_DEPTH = 3;
  const visited = new Set<string>([recvType]);
  let frontier = [recvType];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    for (const type of frontier) {
      const candidates = ownerMethod.get(`${type}.${name}`);
      if (!candidates || candidates.length === 0) continue; // try next ancestor
      if (candidates.length === 1) {
        const c = candidates[0];
        return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
      }
      const sameFile = candidates.find((c) => c.path === file);
      if (sameFile) return { id: sameFile.id, confidence: "extracted" };
      return "ambiguous"; // several, none same-file — drop and stop
    }
    const next: string[] = [];
    for (const type of frontier) {
      for (const parent of classParents.get(type) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return null; // chain exhausted, no candidate anywhere
}

/**
 * Resolve a module specifier to a file node id when it points inside the repo;
 * otherwise return the raw specifier (external package or unresolved path).
 */
function resolveImport(spec: string, file: string, byId: Map<string, NodeV1>): string {
  if (!spec.startsWith(".")) return spec;
  // Belt-and-braces: `node.path` is posix by construction (`../util/paths.ts`),
  // but this also accepts a hand-written or hand-edited graph.
  const dir = posix.dirname(toPosixPath(file));
  const base = posix.normalize(posix.join(dir, spec));
  const noExt = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, "");
  const candidates = [
    base,
    ...IMPORT_EXTS.map((e) => noExt + e),
    ...IMPORT_EXTS.map((e) => `${noExt}/index${e}`),
  ];
  for (const c of candidates) if (byId.has(c)) return c;
  return spec;
}

/**
 * Resolve a Go import package path to an in-repo file node when it points inside one of
 * the repo's modules; otherwise return the raw specifier (stdlib or third-party package).
 *
 * Go imports name a *package* (a directory), not a file. The package path is relative to
 * the owning module's path, so the in-repo directory is `<module go.mod dir>/<subpath>`.
 * This handles a `go.mod` anywhere in the tree — repo root or a subdirectory (monorepo).
 * When several modules' paths prefix the spec, the longest (most specific) wins. A package
 * dir may hold several `.go` files; we pick a deterministic representative (lowest id).
 */
function resolveGoImport(spec: string, modules: GoModule[], filesByDir: Map<string, string[]>): string {
  let best: { mod: GoModule; subpath: string } | null = null;
  for (const mod of modules) {
    let subpath: string | null = null;
    if (spec === mod.module) subpath = "";
    else if (spec.startsWith(mod.module + "/")) subpath = spec.slice(mod.module.length + 1);
    if (subpath === null) continue;
    if (!best || mod.module.length > best.mod.module.length) best = { mod, subpath };
  }
  if (!best) return spec; // stdlib / third-party — keep the package path

  const dir = posix.normalize(posix.join(best.mod.dir, best.subpath));
  const files = filesByDir.get(dir);
  if (!files || files.length === 0) return spec;
  return [...files].sort()[0];
}
