# Changelog

## Unreleased

### Added

- feat: add Ruby language support (Phase 1: flat class/module/method extraction)
- feat: add Ruby language support (Phase 2: singleton methods)
- feat: add Ruby language support (Phase 3: private/protected/public visibility)
- **C/C++ language support.** One `"cpp"` grammar (`tree-sitter-cpp`) parses the
  whole family — `.c/.h/.cpp/.hpp/.cc/.cxx/.hh/.hxx` — uniformly, the same
  approach clangd and most polyglot tooling take; there's no separate `.c`-only
  language for v1. Classes, structs, enums, and template classes/functions are
  extracted, along with the two genuinely new pieces of design work this
  grammar needs beyond every other supported language: (1) a `function_definition`
  carries no `name` field — it's buried in a declarator chain that can be a
  plain identifier, an out-of-class `Class::method` qualifier, a destructor
  (`~Class`), or an operator overload (`operator==`), so a header-declared
  prototype and its `.cpp` out-of-line definition resolve to exactly one node,
  not two or zero; and (2) C++ visibility is stateful — an `access_specifier`
  token applies to every subsequent class member until the next one (default
  `private` for `class`, `public` for `struct`), unlike every other supported
  language's per-node exported check. Heritage (`: public Base`) always emits
  `extends` (C++ has no `interface` keyword), and `#include` edges capture both
  `"local.h"` and `<system>` forms. Known limitations: macros that expand to
  declarations aren't understood, template specializations are treated as
  ordinary functions/methods by name (no specialization identity), and a
  bareword `#include "local.h"` (no `./` prefix) only resolves to an in-repo
  file when it happens to match a real repo-relative path — C's directory-
  relative-without-prefix include convention isn't specially handled.

- **R language support (Phase 1: flat function extraction).** `tree-sitter-r`
  (`npm:@davisvaughan/tree-sitter-r`, since `tree-sitter-r` on npm is an
  unrelated squatted placeholder) parses `.R`/`.r` files. Every
  `name <- function(...) {}` / `name = function(...) {}` /
  `function(...) {} -> name` becomes a flat `function` node — the same
  altitude Python support already operates at for module-level `def`s, and no
  S3/S4/R6 class awareness (that convention-based, ambiguity-prone work is
  scoped as a separate Phase 2). `function_definition` carries no name field
  at all in this grammar — the identifier always comes from an enclosing
  assignment, and R's one generic `binary_operator` node is shared by every
  binary op, not just assignment, so a filtering pass was needed. Right-assign
  (`->`/`->>`) needed its own logic rather than mirroring left-assign: its low
  operator precedence means it's absorbed into the function definition's own
  `body` field instead of the function sitting inside an outer
  `binary_operator`, which only empirically dumping the real AST caught.
  `library()`/`require()`/`source()` calls are recognized as imports by
  pattern-matching the callee name (R has no import statement at the grammar
  level); `pkg::fn()` and `obj$method()` calls resolve by bare name, since
  Phase 1 has no type-binding table to back a typed member-call match yet.
  Visibility is the leading-dot naming convention only (`.helper` = internal);
  roxygen `@export` tag detection is left for a follow-up once an
  extras-comment-scanning helper exists.

- **R language support, Phase 2: S3/S4/R6 class awareness.** R's class systems
  are library *convention*, not grammar syntax, so this is the first
  "pattern-match known call idioms → sometimes a class/method" language in
  graft rather than "one grammar construct → one kind." **R6**
  (`Foo <- R6::R6Class("Foo", public = list(...), private = list(...))`) is
  the highest-value target — this repo's own dominant R OOP style — and gets
  full support: the class node, `public =`/`private =`/`active =` list
  entries as methods (private ones unexported), `inherit =` heritage, and
  `self$`/`private$` calls resolving directly to the enclosing class the same
  way Python's `self`/TS's `this` already do. **S4** (`setClass()` /
  `setMethod()`) — both are `call` nodes with side effects, essentially never
  assigned to a variable — become a class and an owned method respectively,
  with `contains =` (single or `c(...)`-vector) heritage; `setGeneric()` isn't
  specially extracted (no natural class/method mapping). **S3**
  (`generic.Class <- function() {}`) is the genuinely ambiguous one flagged in
  the plan: `read.csv`/`data.frame` are NOT S3 dispatch, and nothing in the
  grammar distinguishes them from `print.MyClass`. A `name.Class` assignment
  only becomes an S3 method when `name` is a generic registered locally via a
  `UseMethod()` call in the same file, or is one of a small curated set of
  common base-R generics (`print`, `format`, `summary`, ...) — erring toward
  false negatives (an unrecognized S3 method just stays a plain function)
  over false positives. Known gaps: S3 generics registered in a *different*
  file than their methods aren't recognized (no whole-repo pass exists yet —
  same per-file limitation Go/C++ bindings already accept); S4's
  `setMethod()` only handles a single string-literal dispatch class, not
  `signature()`-based multiple dispatch; R6 active bindings are treated as
  ordinary (exported) methods with no distinction from regular ones.

- **R language support, Phase 3: roxygen `@export` visibility and R6
  `super$` dispatch.** Scoped for an R6-plus-roxygen setup specifically (no
  S3/S4 involved). A `#' @export` roxygen tag now marks its definition
  exported regardless of the leading-dot naming convention; a definition with
  *some* roxygen doc block but no `@export` tag is instead treated as an
  explicit "not exported" (roxygen's own NAMESPACE-generation convention: only
  `@export`-tagged items are exported, so documented-but-untagged is a real
  signal, not an absence of evidence) — the naming-convention fallback only
  kicks in when there's no roxygen block at all. `comment` is a grammar extra
  (floats as an ordinary sibling rather than attaching to "the next
  statement"), so this walks backward through a definition's preceding
  `previousNamedSibling` chain collecting a contiguous roxygen (`#'`) comment
  run. R6's `super$method()` — its inheritance-dispatch keyword — now resolves
  directly to the parent class's method (via the same `inherit =` heritage
  already extracted in Phase 2), rather than falling back to a plain bare-name
  match that could just as easily match the current class's own same-named
  override. Also fixed in passing: the `R6Class(...)` call itself no longer
  generates a spurious (harmless — always unresolved and dropped, but wasted)
  `calls`-edge intent to a function literally named `"R6Class"`.

- **R language support, Phase 4: untyped R6 composition calls resolve to a
  uniquely-named method.** `private$other_obj$method()` — one class holding
  another as a field, then calling into it — was investigated against a real
  R6-heavy corpus and found to be a real, common pattern (40+ occurrences in
  one production package) that the field-type-binding table other languages
  have (C#/Go/TS's "`field <- SomeClass$new()`" pattern match) wouldn't
  actually have helped with anyway: the dominant real-world field-assignment
  shape there is constructor-parameter pass-through and `do.call(class_var$new,
  ...)` dynamic dispatch, neither of which names a class anywhere in the
  syntax a static pattern-matcher could read. The narrower, real fix: these
  calls were marked `viaMember: false` (a plain bare-name match, same as any
  free-function call in every language), but bare-name resolution only ever
  matched `"function"`-kind nodes — never `"method"` — so since R6 methods are
  always kind `"method"`, EVERY such call was unconditionally unresolvable,
  not just occasionally imprecise. Bare-name resolution for this one shape
  (an untyped `$` call, not `self`/`private`/`super`, which already resolve
  precisely) now also considers `"method"`-kind nodes, using the exact same
  "unique match resolves, ambiguous match safely drops" logic already used
  everywhere else — no new false-positive risk, only new resolutions for
  method names that happen to be unique across the repo. `pkg::fun()`
  qualified calls are untouched (never an R6 method target).

- **R language support, Phase 5: plain-list "mixin"/"extension" bundles
  recognized as classes.** Found dogfooding a full rebuild of the same real
  R6-heavy corpus (forced with `--no-reuse`, not the extraction cache) used to
  scope Phase 4: 12 files with substantial content produced zero extracted
  symbols. 11 of them shared one cause — a real, deliberate convention that
  codebase calls "Pattern-1 mixin/extension": `Foo <- list(public = list(...),
  private = list(...))`, sharing a method bundle across classes by splicing
  (`public = c(Foo$public, list(...))`) rather than `inherit =`-based
  inheritance, and so never wrapped in `R6::R6Class(...)` at all. 25 files in
  the corpus use this convention. `Name <- list(...)` is now recognized as a
  class-like container specifically when the list has a `public =` or
  `private =` entry whose own value is itself a `list(...)` call — precise
  enough that an ordinary data/config list is never mistaken for one, since
  real data never coincidentally shapes itself that way. Nothing else needed
  to change: every downstream mechanism (the `public=`/`private=` list-walk,
  method visibility, `self$`/`private$` call resolution) already worked
  purely off `ctx.enclosingKind === "class"`, indifferent to how the class
  was spelled. No heritage edge is emitted for these (splicing isn't
  `inherit =`). Re-running the same corpus rebuild after this fix: all 11
  previously-empty files now extract correctly (zero unexplained empty files
  remain — the one exception, `EDI.R`, is a package-doc-only file with no
  real code), classes 256→277, methods 1764→1916, edges 9089→9415.

## 0.9.0

### Added

- **`graft build --include-dir <name>`** — an explicit, persisted override for
  `SKIP_DIRS` (repeatable: `--include-dir build --include-dir tools`). Some
  ecosystems keep genuine hand-written source under a directory name graft
  otherwise treats as build output (e.g. a `build/` that isn't generated).
  The override is persisted per repo in Git-ignored `.graft/config.json`: set
  it once and every later no-flag `graft build`, plus the hooks/refresh path
  (which never sees CLI flags at all), include it identically. It lifts only
  graft's own skip list — in a
  Git repository, Git's ignore rules stay authoritative, so a directory that
  is both skip-listed and gitignored needs un-ignoring (or `git add -f`) too,
  the same contract indexing already applies to tracked-but-ignored files.
  Dot-directories are never overridable. Reaches the wiring graph, the Tier-2
  markdown/concept pipeline, Go module discovery, and workspace child builds
  alike, and is validated up front (a bare directory name only — no paths, no
  dot-prefixes).

### Fixed

- **`graft map` no longer promotes unrelated methods into hubs and hotspots.**
  A member call with an unknown receiver could be wired to the repository's
  only method with the same bare name, so built-ins such as `Map.set()` inflated
  an unrelated user-defined `set` method. Member calls now require an
  owner-qualified receiver-type match; unresolved calls are dropped rather
  than guessed ([#35]).

- **Indexing now respects `.gitignore`.** In Git repositories, graft indexes
  tracked files plus untracked files that Git does not ignore, so generated
  output such as `Scripts/bundles/` and `Scripts/transpiled/` is no longer
  parsed merely because its extension is supported. Nested ignore files,
  negations, and global Git excludes follow Git's own rules; non-Git directories
  retain the existing filesystem walk and built-in skip list ([#39]).

- **`graft ask` no longer lets normalization undo test-file de-ranking.** Test
  files were penalized before lexical scores were normalized, but the strongest
  test match was still normalized back to the maximum score. The test prior now
  also applies to the final lexical/graph blend, while test-seeking queries keep
  the existing unpenalized behavior ([#37]).

- **`callers` now includes imported functions used as values.** Named imports that
  are passed, returned, or stored are reported as weaker `references` edges,
  while direct invocations remain `calls` ([#34]).

- **The build banner and repo map now name the language, not its parser.** JavaScript
  files (`.js`, `.mjs`, `.cjs`) use the TypeScript grammar internally, and `.jsx`
  uses the TSX grammar, but reporting those parser names made indexed files look
  absent. Coverage now reports `javascript` and `jsx` alongside the existing
  `typescript`, `tsx`, `python`, and `go` labels ([#36]).

- **README: `init` does not write a `CLAUDE.md` section.** Claude Code receives the
  wholly-owned `.claude/skills/graft/SKILL.md`; existing `CLAUDE.md` content is
  never touched ([#36]).

- **Windows: `graft upgrade` no longer reinstalls over an npx run.** The npx-cache check
  matched `/_npx/` against a path that arrives with the platform separator, so it was
  always false on Windows and `graft upgrade` ran `npm install -g` instead of explaining
  that npx already fetches the latest build on every run.

- **Windows: a git worktree kept the graph it was seeded with, but not the record that
  makes it cheap.** The seed's copy filter dropped every sidecar next to the graph — the
  freshness fingerprint included — so the query right behind the seed found no
  fingerprint, could not diff against the parent checkout, and re-parsed the whole repo.
  It answered correctly the whole time, which is why nothing reported it; the only
  visible trace was a `(? files changed)` note instead of a count.

- **`graft init` printed one path with two separators** on Windows (`~\.codex/`), from a
  `/` concatenated onto an otherwise native display path.

- The `windows-latest` CI leg now **gates** rather than merely reporting. The 21 failures
  it shipped with are resolved: two were the real bugs above, most of the rest were tests
  asserting `/` in paths that are deliberately printed with the native separator or
  pointing a child process at `HOME` (Windows reads `USERPROFILE`), and four are now
  explicit named skips — nothing in Node's `fs` can deny a *read* on Windows, and there
  is no exec bit or `SIGTERM` to test.

- **Windows: path scoping and `map` work again.** graft stores a repo-relative path
  for every indexed file — in node ids, `node.path`, the extract cache, the freshness
  fingerprint — and it was produced with `relative()`, which returns the *platform*
  separator. So on Windows every stored path was `src\gate.ts`, while the query layer
  parses those strings with `/` by hand. Nothing errored; it just matched nothing:

  - `ask --in <path>` reported `nothing indexed under "…"` for **every** prefix,
    making path scoping unusable on the platform ([#33]).
  - `map` saw one path segment instead of several, so it emitted one single-file
    "directory" per file — on a large repo spending its whole token budget describing
    ~16 arbitrary files instead of the repo's shape ([#35]).
  - `callers <file.ts>`-style filename lookups missed.

  Repo-relative paths are now normalized to posix once, where they are created
  (`src/util/paths.ts`), instead of defensively at each consumer. Mac and Linux are
  unaffected — the conversion is the identity there, and existing graphs are
  byte-identical. **On Windows every cache key changes**, so the first `graft build`
  after upgrading re-parses the repo once and `graft check` may report drift until it
  runs. One-time, and `graft/` is a local gitignored cache — nothing to migrate.

  CI now runs a `windows-latest` leg, because this whole class of bug is invisible to
  a posix-only matrix.

### Changed

- **`--in` means the same thing on every command.** `ask --in` matched a segment-aware
  path prefix while `grep --in` and `callers --in` matched a bare substring, so
  `grep --in src` also swept up `lib/mysrc/`. All three now use the prefix rule, and
  all three accept either separator (`--in server\src\gpu` works on Windows). A prefix
  matching nothing indexed is now a loud error on all three rather than — for `grep`
  and `callers` — empty output the caller had to interpret.

  This is stricter: a mid-path fragment like `--in gpu` for `server/src/gpu` no longer
  matches. Pass a real prefix (`--in server/src/gpu`), a full file path
  (`--in src/a.ts`), or use `grep`'s pattern to match on content.

- **Duplicate-named definitions no longer silently collide onto one graph node
  id.** A branch-guarded redeclaration, a reopened class, or any other same-name
  definition within a file used to mint the exact same node id as an earlier
  definition, so the second one silently overwrote the first in every id-keyed
  lookup (`callers`, `ask`, MCP tools). Every definition now mints a unique id
  (`~2`, `~3`, ... on a document-order duplicate), and a qualified query
  (`Class.method`) now matches every duplicate, not just the first.

- **UTF-16LE source is now decoded consistently everywhere graft reads repo
  source.** `graft build`'s parse, `check`'s and `fingerprint`'s drift hashes,
  the context summarizer's input, `ask --source`'s span slicer, and `grep` each
  read files with their own `readFileSync(file, "utf8")` — hashing what the
  parser actually sees wasn't guaranteed, and a UTF-16LE file (the common
  encoding Windows tooling writes) got silently mojibake'd by some readers and
  not others. All of them now share one `readSourceFile`, so a file decodes
  identically no matter which command reads it. UTF-16BE, unsupported by
  Node's built-in decoders, is a clean skip (an empty entry) rather than a
  mojibake read.

- **`graft callers`'s zero-hit note now says when the query name itself is
  ambiguous.** When a symbol name is defined more than once, name resolution
  drops a cross-file call to it rather than guessing which definition it means
  — so a zero-hit result could really mean "something calls this, but the edge
  was dropped for being ambiguous." The note now states how many definitions
  share the name.

[#33]: https://github.com/NanoNets/Graft/issues/33
[#34]: https://github.com/NanoNets/Graft/issues/34
[#35]: https://github.com/NanoNets/Graft/issues/35
[#36]: https://github.com/NanoNets/Graft/issues/36
[#37]: https://github.com/NanoNets/Graft/issues/37
[#39]: https://github.com/NanoNets/Graft/issues/39

## 0.8.2

### Fixed

- **`graft ask` no longer buries source under test files on pytest-style repos.** The
  test-de-rank (`isTestPath`) matched test directories (`tests/`, `spec/`) and suffix
  names (`_test`, `.test`, `.spec`) but missed Python's dominant `test_*.py` filename
  **prefix** and `conftest.py`. On repos whose tests live outside a `tests/`-named
  directory (e.g. a `t/unit/` layout), tests were not de-ranked and swamped `ask`
  results. The prefix and `conftest.py` are now recognized.

## 0.8.1

### Changed

- **Every graft query now refreshes the graph before it answers.** Freshness used to be the
  `Stop` hook's job — it rebuilt once the turn had ended — so every query an agent made
  between its first edit and the end of that turn answered from a graph that no longer
  matched the file it had just changed, and it stayed that way indefinitely if the
  background sync failed. Edits made outside the agent (your editor, a branch switch, a
  stash) set no flag at all, so the statusline read `✓ synced` while the graph was behind.

  `ask`, `grep`, `callers`, `skeleton` and `map` now stat the working tree against the last
  build's fingerprint (~3ms) and rebuild only if something moved. `check` is exempt — it is
  the drift report, and refreshing first would make it always say OK.

  A refresh writes only what a query reads: the wiring graph, the `ask` sidecar, and the
  freshness record. It does **not** rewrite the markdown cards, `INDEX.md`, or your
  `.gitignore` — a query is a read, and those stay the job of an explicit `graft build`
  (which is what the Claude Code `Stop` hook already runs at the end of a turn). So the
  retrieval tools are always current, while the markdown you might `grep` by hand can lag
  an edit until the turn ends.

  The refresh is structural and `$0`: it never calls the LLM, so `graft check` still reports
  concept-node drift and stale summaries until you run `graft build --deep` yourself. A
  refresh that fails answers from the graph on disk rather than failing the query.

  ```bash
  graft ask "..." --no-refresh     # answer from the graph exactly as it is on disk
  GRAFT_NO_REFRESH=1               # same, for every command in the process
  ```

### Added

- **Incremental extraction.** `graft build` memoizes each file's parse under `graft/.cache/`
  and replays the files whose bytes have not moved, so a rebuild costs roughly the files
  that changed: on this repo (124 files) **0.74s cold against 0.18s after one edit**. Output
  is byte-identical to a cold build. The memo is discarded automatically when the extraction
  code or the graft version changes, so a stale parse can't outlive an upgrade. `graft build`
  now reports `parsed: N of M files (K replayed from cache)`, and `graft build --no-reuse`
  forces a cold parse of everything.

  Only the *parse* is skipped — every file is still read and hashed on every build. A stat
  may decide whether a query bothers rebuilding; it may not decide what the rebuild itself
  looks at, or `graft check` (which always re-hashes) could report drift that the `graft
  build` it recommends refuses to repair.

- **`GRAFT_REFRESH=hash`** — confirm every file by hashing its contents instead of trusting
  size and mtime, for tooling that rewrites files while preserving both.

### Fixed

- **A git worktree is no longer blind.** `graft/` is gitignored, so `git worktree add`
  never checks it out — and the graph is the only thing the MCP tools read. Every tool in
  a fresh worktree answered `no matching nodes` / `no graph found` for the whole session,
  and `INDEX.md` and the cards were missing too, so `grep` and the repo map came up empty.

  A query in a worktree now copies the parent checkout's graph and query sidecars in, then
  treats the difference between the two checkouts as ordinary drift. The worktree's `.git`
  is a file naming its parent, so there is nothing to configure; the copy is $0 and
  offline, and the Tier-2 meaning layer survives it (a cold rebuild would have thrown away
  every summary you paid for and re-parsed the repo). `graft build` in a worktree starts
  from the same copy, so it is incremental too — and it is what writes the worktree's
  cards and `INDEX.md`, generated from *this* checkout's code rather than copied from the
  parent's branch. A query still writes only what a query reads.

  Reads the parent, never writes to it. No-ops unless there is genuinely a built parent
  checkout on disk — a fresh clone, CI, or a cloned (rather than worktree'd) cloud session
  behaves exactly as before. `GRAFT_NO_SEED=1` turns it off.

## 0.8.0

### Changed

- **`graft init` now asks which agents to wire, instead of writing files for every
  agent it detects.** Detection keyed off directories in `$HOME`, so anyone who had
  tried several coding CLIs got instruction files and MCP configs for all of them —
  plain `graft init` effectively behaved like `--all-agents`. On a terminal it now
  shows every known agent, which ones were detected, and the exact files each would
  write, and wires only what you select (Claude Code pre-selected).

  **Migration —** `graft init` in CI, a Dockerfile, or any non-interactive shell now
  writes **nothing** and prints the command to run instead. Add `--yes` for the old
  behaviour, or `--agents <ids>` to be explicit:

  ```bash
  graft init --yes                  # wire every detected agent (pre-0.8 default)
  graft init --agents claude        # or name them
  ```

### Added

- **`graft init --dry-run`** — print every path `init` would touch, then exit without
  writing. Out-of-repo writes get their own section.
- **`graft init --no-global`** — skip every write outside the repo. Selecting the
  `agents` host writes to `~/.codex/config.toml`, `~/.codex/hooks.json`, and
  `~/.codex/hooks/graft/`; those are user-level and apply to every repo you open with
  Codex, and previously nothing suppressed the `config.toml` write (`--no-hooks` only
  covered the other two). These are now labelled `machine-wide` in the picker.
- **`graft init --yes`** — wire every detected agent without prompting.

## 0.7.0

### Changed

- **`graft/` is now a local, git-ignored cache, not a committed artifact.** Every
  `graft build` adds `graft/` to the repo's `.gitignore` itself, so the graph is
  regenerated locally (like `node_modules`) rather than shared through git. Commit
  `.claude/` (hooks, skill, statusline, `.mcp.json`) so teammates' agents pick graft
  up; each teammate runs `graft build` for their own graph. `graft check` is now a
  local freshness signal rather than a CI merge gate.

### Removed

- The `bench/` benchmark harness is no longer part of the published repo.

## 0.6.0

Consolidates the structural-traversal surface and wires the MCP server into
Claude Code. **Breaking** — see migration below.

### Breaking

- **Removed `graft callees` and `graft impact`.** Both fold into `graft callers`:
  - `graft callees <symbol>` → `graft callers <symbol> --direction out`
  - `graft impact <symbol> -d N` → `graft callers <symbol> --depth N`
  - `graft callers` with no new flags is unchanged (defaults `--direction in --depth 1`).
- **Removed MCP tools `graft_callees` and `graft_blast_radius`.** The `graft_callers`
  tool now takes optional `direction` (`in`|`out`, default `in`) and `depth`
  (default `1`) parameters covering both:
  - callees → `graft_callers { direction: "out" }`
  - blast radius → `graft_callers { depth: N }` (accepts a file path or symbol,
    same file-seed aggregation the old `graft_blast_radius` did).

  Rationale: a coding-agent tool-selection experiment showed agents never picked
  `graft_blast_radius`/`impact` (they reconstructed it by calling `callers`
  repeatedly) and never picked `callees` (they read the named file instead). One
  well-named command with flags is selected more reliably than three.

### Added

- `graft callers --direction <in|out>` — walk incoming (callers, default) or
  outgoing (callees) edges.
- `graft callers --depth <n>` — walk transitively out to depth N for the full
  blast radius (default 1 = direct edges only). For a file seed at depth >1 the
  walk aggregates over the symbols the file defines.
- `graft init` now registers the graft MCP server in the project's `.mcp.json`
  for Claude Code (previously Claude Code got only hooks + statusline + skill).
  Restart Claude Code to load it. Existing `.mcp.json` servers are preserved.

### Changed

- `graft mcp --help` and docs now list the full tool set
  (`graft_ask`, `graft_callers`, `graft_grep`, `graft_skeleton`, `graft_map`,
  `graft_check`) instead of only three.
- The bundled Claude Code skill and other-agent instructions document the
  consolidated `callers` flags.
