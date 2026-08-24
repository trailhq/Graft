/**
 * Filesystem walking used by `init`/`check` to enumerate a repo's source files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Directories that are dependency/build output, never source. */
export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  // The underscore spelling that Sphinx, CMake, Jekyll and the OCaml tools all
  // emit. Left out, a materialized build tree lands in the graph as ordinary
  // source: one repo here indexed 4,484 files of vendored WordPress against 121
  // hand-written ones, and queries slowed enough that the prompt hook's budget
  // could no longer fit them. `--include-dir _build` remains the way back in.
  "_build",
  "out",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  "venv",
]);

/** Files above this size are generated/vendored in practice, not hand-written code. */
export const MAX_FILE_BYTES = 1_000_000;

/**
 * Whether a directory named `name` should be skipped when walking a repo tree:
 * any dot-prefixed directory (`.git`, `.github`, `.vscode`, ...) or one of
 * {@link SKIP_DIRS} not named in `includes`. The single source of truth for
 * "is this dir source" — `skippedPath` and `walkFilesystem` below and the
 * git-child discovery in `graph/scopes.ts` share it, so they can never
 * independently drift on what counts as skippable.
 *
 * `includes` is the explicit, per-repo `graft build --include-dir` override
 * (persisted via `util/state.ts`'s `readIncludeDirs`, threaded in by each
 * caller) — a name in it is removed from the effective skip set for THIS
 * repo's walks. Absent/empty ≡ today's default behavior. It lifts only
 * graft's own skip list: in a Git repo, Git's ignore rules stay authoritative
 * (see {@link walkDir}).
 *
 * KNOWN LIMITATION: a dot-directory is skipped WHOLESALE and is NEVER
 * overridable, even via `includes` — unlike `SKIP_DIRS`, there is no path to
 * un-skip one. A repo that keeps real, hand-written source under a
 * dot-prefixed directory is out of scope.
 */
export function shouldSkipDir(name: string, includes?: ReadonlySet<string>): boolean {
  if (name.startsWith(".")) return true;
  if (includes?.has(name)) return false;
  return SKIP_DIRS.has(name);
}

/**
 * Recursively list all files under a directory. Skips dot-directories,
 * dependency/build directories (node_modules, dist, …) not named in
 * `includes`, and files over 1 MB.
 * In a Git worktree, tracked files plus untracked, non-ignored files come from
 * `git ls-files`; this gives indexing exactly Git's nested `.gitignore`,
 * negation, and global-exclude semantics. Initialized submodules are enumerated
 * recursively only when `followSubmodules` is true; the default preserves the
 * historical superproject boundary. Each child keeps its own ignore rules, and
 * uninitialized submodules remain absent. Non-Git directories retain the plain
 * filesystem walk. `includes` lifts only the built-in skip list — it never
 * overrides Git's ignore rules (un-ignore or `git add -f` a directory to
 * index it, the same contract as tracked-but-ignored files).
 */
export interface WalkOptions {
  /** Include initialized Git submodules recursively. Default false. */
  followSubmodules?: boolean;
}

export function walkDir(
  dir: string,
  includes?: ReadonlySet<string>,
  opts: WalkOptions = {},
): string[] {
  return gitVisibleFiles(dir, includes, opts.followSubmodules === true) ?? walkFilesystem(dir, includes);
}

/** Git's canonical working-tree file set, relative to `dir`. Tracked files are
 * deliberately included even when a later ignore rule matches them; `.gitignore`
 * only controls untracked files in Git, and graft follows the same contract. */
function gitVisibleFiles(
  dir: string,
  includes?: ReadonlySet<string>,
  followSubmodules = false,
  traversal?: { topRoot: string; activeRoots: Set<string> },
): string[] | null {
  const root = resolve(dir);
  if (!followSubmodules) return gitVisibleFilesShallow(root, includes);

  const state = traversal ?? { topRoot: root, activeRoots: new Set<string>() };
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  if (state.activeRoots.has(rootKey)) return [];
  state.activeRoots.add(rootKey);

  // Following uses `-t --stage` so one process can distinguish gitlinks from
  // tracked and untracked files. `-z` keeps either form safe for unusual paths.
  const result = spawnSync(
    "git",
    ["ls-files", "-t", "--stage", "--cached", "--others", "--exclude-standard", "-z", "--"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
    state.activeRoots.delete(rootKey);
    return null;
  }

  // A path can have multiple stage records during a merge. Collapse those
  // records and remember if any of them identifies the path as a gitlink.
  const entries = new Map<string, { gitlink: boolean }>();
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    if (record.length < 2 || record[1] !== " ") continue;

    const tag = record[0];
    const body = record.slice(2);
    let rel: string;
    let gitlink = false;
    if (tag === "?") {
      rel = body;
    } else {
      const tab = body.indexOf("\t");
      if (tab === -1) continue;
      gitlink = body.startsWith("160000 ");
      rel = body.slice(tab + 1);
    }
    if (!rel) continue;
    const prior = entries.get(rel);
    entries.set(rel, { gitlink: gitlink || prior?.gitlink === true });
  }

  const out = new Set<string>();
  for (const [rel, entry] of entries) {
    const abs = resolve(root, rel);
    // Filter against the original superproject path. Otherwise a submodule
    // mounted at vendor/ or build/ would bypass the parent's skip policy when
    // recursion resets its relative root.
    if (skippedPath(relative(state.topRoot, abs), includes)) continue;

    if (entry.gitlink) {
      // A deinitialized gitlink can resolve upward to the superproject when Git
      // runs inside it. Requiring the child's own .git prevents duplicate,
      // mis-prefixed parent files and recursive loops.
      if (!existsSync(join(abs, ".git"))) continue;
      let childFiles = gitVisibleFiles(abs, includes, true, state);
      if (childFiles === null) {
        // Do not let one broken child recreate a "healthy but incomplete"
        // graph. Match the top-level fail-soft contract locally: fall back to
        // the filesystem for this child only, preserving the parent repo's Git
        // visibility and every built-in skip/size guard. Child Git ignore rules
        // are unavailable in this exceptional path, just as they are when the
        // top-level Git command fails and walkDir uses its filesystem fallback.
        // Let an unreadable filesystem fallback surface rather than claiming a
        // healthy graph that silently omitted the child again.
        childFiles = walkFilesystem(abs, includes);
      }
      for (const file of childFiles) out.add(file);
      continue;
    }

    try {
      const stat = lstatSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    } catch {
      // A tracked file deleted from the working tree is still printed by
      // `--cached`; absence means it is not part of the current source set.
      continue;
    }
    out.add(abs);
  }

  state.activeRoots.delete(rootKey);
  return [...out].sort();
}

/** The historical, non-recursive Git path. Kept separate so the default does
 * exactly the same command, filtering, ordering, and duplicate handling as it
 * did before submodule support existed. */
function gitVisibleFilesShallow(root: string, includes?: ReadonlySet<string>): string[] | null {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") return null;

  const out: string[] = [];
  for (const rel of result.stdout.split("\0")) {
    if (!rel || skippedPath(rel, includes)) continue;
    const abs = resolve(root, rel);
    try {
      const stat = lstatSync(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    } catch {
      // A tracked file deleted from the working tree is still printed by
      // `--cached`; absence means it is not part of the current source set.
      continue;
    }
    out.push(abs);
  }
  return out;
}

/** A path (git-relative, either separator) is skipped when any of its
 * segments is a skippable directory name — the final segment doubles as the
 * dot-FILE check (`.eslintrc.js` and friends are not source either). */
function skippedPath(path: string, includes?: ReadonlySet<string>): boolean {
  return path.replace(/\\/g, "/").split("/").some((segment) => shouldSkipDir(segment, includes));
}

function walkFilesystem(dir: string, includes?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, includes)) continue;
      out.push(...walkFilesystem(full, includes));
    } else if (entry.isFile()) {
      if (entry.name.startsWith(".")) continue; // dot-files are not source either
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}
