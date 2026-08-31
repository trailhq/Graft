# Ruby language support — design

Status: approved for implementation planning
Date: 2026-08-31
Precedent: `feat/r-support` (R language support, phases 1-5, commits `0697665`, `ebaefde`, `424fdb4`, `6899b5a`, `eae0ce5`)

## Goal

Add Ruby to graft's full-fidelity extraction tier: classes, modules, instance
and singleton methods, visibility, mixin composition, and the common
accessor/dynamic-method idioms, wired into the same `graph/extract.ts`
pipeline the other full-fidelity languages (TypeScript, Python, Go, Java,
PHP, R) already share.

## Non-goals

- Dynamic metaprogramming beyond `define_method` — `method_missing`,
  `class_eval`/`instance_eval`, `send`/`__send__`, `Class.new`/`Struct.new`
  anonymous class bodies, `refine` (refinements), and monkey-patching via
  reopened core classes produce no extraction. This mirrors R's precedent of
  erring toward false negatives over guessing (see R Phase 1/2 doc comments
  on `read.csv` vs. S3 dispatch): a symbol graft can't confidently place is a
  symbol graft should drop, not misplace.
- A type-binding/receiver table for resolving `obj.method` calls to a known
  class. Like R (and unlike Java's more elaborate binding work), untyped
  calls resolve by bare-name matching, augmented in Phase 4 for module
  methods pulled in via `include`/`extend`/`prepend`.
- LSP-based enrichment. Ruby is a full-fidelity language from day one, not
  routed through the breadth-tier LSP path.

## Architecture

Same shape as every other full-fidelity language: no new files, no new
pipeline stage. All logic lives in the existing `ctx.lang`-gated walk in
`src/graph/extract.ts`, with Ruby-specific helper functions colocated near
the language's call sites (matching where `rS3Split`, `rR6ParentClass`,
`collectRGenerics`, etc. live for R).

- `src/graph/extract.ts` — add `"ruby"` to the `Language` union, register the
  `.rb` extension → `ruby` grammar, add `describeRuby(node, ctx)` and its
  phase-specific helpers.
- `src/graph/bindings.ts` — add a `lang === "ruby"` branch to the def-name
  extraction dispatch (mirrors the existing `rDefName` branch).
- `src/graph/resolve.ts` — Phase 4 threads an optional `RawEdge.kinds`
  override the same way R's Phase 4 does, so an unqualified module-mixin
  call can match "method"-kind nodes without changing the general
  bare-name resolution logic.
- `package.json` — add `"tree-sitter-ruby": "^0.23.1"` (same 0.23.x
  generation as `tree-sitter-php`/`tree-sitter-java`).
- `test/graph-languages.test.ts` — register the new language/extension like
  every other language does.
- One new test file per phase: `test/graph-ruby.test.ts` (Phase 1),
  `test/graph-ruby-phase2.test.ts` ... `test/graph-ruby-phase5.test.ts`,
  mirroring `test/graph-r*.test.ts`.
- `CHANGELOG.md` — one entry per phase.
- `README.md` — Ruby joins the full-fidelity tier list once all phases land
  (mirrors R's `ab35844`/`0c5bf60`, done as the final doc commit, not
  per-phase).

## Phases

### Phase 1 — flat class/module-aware extraction

Wire the `tree-sitter-ruby` grammar. Extract:

- `class Foo` / `class Foo < Bar` → class-kind node; `< Bar` becomes a
  heritage/`extends`-style edge to `Bar` (Ruby's single inheritance is
  simpler than R6's `inherit=`, but the edge shape is the same).
- `module Foo` → module-kind node (namespacing container; mixin-target
  status comes in Phase 4).
- `def name` → method-kind node, owned by its lexically enclosing
  class/module (Ruby method defs nest lexically, unlike R's S3/S4, so this
  is closer to Java/Go's nested-method ownership than to R's Phase-1/2
  split).
- Nested `class`/`module` (namespacing via `module A; class B; end; end` or
  `A::B`) — ownership follows lexical nesting.
- Calls: bare `foo(...)`/`foo` and `obj.method(...)` resolve by name the
  same way R's Phase 1 does (no type-binding table yet).

This phase alone already gives Ruby class/module ownership that R didn't
get until partway through its Phase 2, because Ruby's grammar hands us real
`class`/`module` nodes instead of a naming convention to infer.

### Phase 2 — singleton methods

- `def self.name` (class/singleton method on the enclosing class) and
  `def obj.name` (singleton method on a specific object, rare but valid
  syntax) → method-kind nodes with a distinct singleton marker, analogous
  to how Java distinguishes static methods.
- `class << self ... end` (singleton class block) — every `def` inside is
  treated as a singleton method of the enclosing class, same as `def
  self.name`.

### Phase 3 — visibility

- Bare `private`/`protected`/`public` calls with no arguments switch the
  visibility mode for every subsequent `def` in the same class/module body
  until the next mode switch or the end of the body.
- `private def foo; end` (inline, method as the sole argument) and
  `private :foo` / `private def_name_symbol` (post-hoc, by symbol) mark a
  single already-defined or being-defined method.
- Default visibility is public; `initialize` is always private regardless
  of the surrounding mode (Ruby language rule).

This is Ruby's analogue of R's roxygen `@export` (Phase 3), but strictly
easier: it's native syntax with unambiguous semantics, not a doc-comment
convention graft has to parse and guess at.

### Phase 4 — mixin composition edges

- `include Mod`, `extend Mod`, `prepend Mod` (bare call, module name
  resolvable in the same file or globally by name) inside a class/module
  body → a resolved edge from the enclosing class to the named module
  (heritage-like edge, same edge shape as the Phase 1 `< Bar` superclass
  edge but tagged with the mixin kind: include/extend/prepend).
- An unqualified `obj.method(...)` call where `method` isn't found as an
  instance method on any locally known class now also matches module
  methods reachable via that class's `include`/`extend`/`prepend` edges —
  implemented via the same optional `RawEdge.kinds` override R's Phase 4
  threads through `resolve.ts`, not a new resolution mechanism.
- Ambiguous matches (multiple equally-plausible targets) drop silently,
  same safe-default as every other bare-name resolution in graft.

### Phase 5 — synthesized accessors and `define_method`

- `attr_accessor :x, :y`, `attr_reader :x`, `attr_writer :x` inside a class
  body synthesize method-kind nodes (`x`, `x=` for accessor/writer, `x`
  only for reader) owned by the enclosing class, with public visibility
  (Ruby's default for `attr_*`-generated methods) unless the current
  visibility mode says otherwise.
- `define_method(:name) { ... }` / `define_method(:name) do ... end` →
  a method-kind node named `name`, owned by the enclosing class/module,
  with the block body walked for nested calls exactly like an ordinary
  `def` body. (Scope decision confirmed 2026-08-31: included, unlike other
  metaprogramming forms, because it's idiomatic in common Ruby DSL code —
  ActiveRecord, RSpec-style libraries — not just an edge case.)

This is Ruby's analogue of R's Phase 5 (plain-list mixin bundles
synthesizing class-like nodes from a call): new nodes materialized from a
recognized call shape rather than from `def`/`class` syntax directly.

## Testing

Each phase ships with its own test file (`test/graph-ruby*.test.ts`),
covering: node kinds/ownership for the phase's new shapes, edge resolution
for any new edge kind, and at least one "shape that looks similar but isn't"
negative case per phase (mirroring R's `read.csv` vs. `print.Foo`
discipline) — e.g. Phase 3 must not treat `private_method_call_result` as
a `private` visibility switch; Phase 4 must not treat a bare `include` in
a non-class/module context (e.g. inside `Comparable`'s own definition) as
a spurious self-mixin edge.

`test/graph-languages.test.ts` gets the standard extension-registration
assertions every language has.

## Rollout

Same commit-per-phase structure as R: five feature commits (one per phase,
each with its own test file and CHANGELOG entry), no cross-phase
dependencies skipped — Phase 2 depends on Phase 1's class/module nodes,
Phase 3 depends on Phase 1's method nodes, Phase 4 depends on Phase 1's
class/module nodes and Phase 1's bare-name resolution, Phase 5 depends on
Phase 1's class body walk. A final docs commit adds Ruby to the README
full-fidelity tier list and condenses the CHANGELOG entries, matching R's
`ab35844`/`0c5bf60`.
