# Ruby Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ruby to graft's full-fidelity extraction tier — classes, modules, instance/singleton methods, visibility, mixin composition, and `attr_*`/`define_method` synthesis — wired into the existing `src/graph/extract.ts` pipeline the same way R, PHP, Java, Go, Python, and TypeScript already are.

**Architecture:** No new files, no new pipeline stage. All new logic lives in the existing `ctx.lang`-gated dispatch inside `src/graph/extract.ts` (a `describeRuby` definition-recognizer plus colocated Ruby helper functions, mirroring `describeR`/`rS3Split`/etc.), with one small `src/graph/bindings.ts` dispatch addition and zero changes to `src/graph/resolve.ts` (its `RawEdge.kinds` override, added for R's Phase 4, is already generic and Ruby reuses it as-is).

**Tech Stack:** `tree-sitter` (already a dependency), `tree-sitter-ruby@^0.23.1` (new dependency, same 0.23.x generation as `tree-sitter-php`/`tree-sitter-java`).

**Spec:** `docs/superpowers/specs/2026-08-31-ruby-support-design.md`

## Global Constraints

- `tree-sitter-ruby` version: `^0.23.1` (exact value confirmed against the npm registry during planning).
- No dynamic metaprogramming beyond `define_method` — `method_missing`, `class_eval`/`instance_eval`, `send`/`__send__`, `Class.new`/`Struct.new` anonymous bodies, and `refine` produce no extraction (per spec Non-goals).
- No receiver-type binding table — untyped member calls resolve by bare name only, exactly like R. `self.method` is the one exception (resolves via the existing language-agnostic `ctx.enclosingClass` mechanism in `resolveRecvType`, already shared code — no Ruby-specific binding logic needed for it).
- No LSP enrichment routing — Ruby is full-fidelity (`origin: "ast"`) from Task 1 onward.
- One commit per task, each with its own test file, following the existing `test/graph-r*.test.ts` naming convention (`test/graph-ruby*.test.ts`).
- `CHANGELOG.md` gets one entry per task; `README.md`'s full-fidelity tier list is updated once, in the final task (matches how R's README/CHANGELOG condensing landed as a separate final commit).

## Grammar Grounding (from direct inspection, not guessed)

These exact `tree-sitter-ruby@0.23.1` node types and field names were confirmed by parsing sample Ruby source during planning and are used verbatim in the tasks below:

| Ruby syntax | Node type | Fields |
|---|---|---|
| `class Foo` / `class Foo < Bar` | `class` | `name` (constant), `superclass` (wraps a `constant`), `body` |
| `module Foo` | `module` | `name` (constant), `body` |
| `def foo; end` | `method` | `name`, `parameters`, `body` |
| `def self.foo; end` | `singleton_method` | `object` (a `self` node), `name`, `parameters`, `body` |
| `def obj.foo; end` | `singleton_method` | `object` (an `identifier`, not `self`), `name`, `parameters`, `body` |
| `class << self ... end` | `singleton_class` | `value` (a `self` node), `body` |
| `foo(1)` / `obj.bar` / `self.baz` / `Klass.qux` | `call` | `receiver` (optional), `method`, `arguments` (optional `argument_list`), `block` (optional `do_block`) |
| bare `private` / `protected` / `public` / `module_function` | `identifier` (NOT `call` — no parens, no args) | — |
| `private def foo; end` | `call` (method=`private`) whose `argument_list`'s sole child is a `method` node | — |
| `private :foo` | `call` (method=`private`) whose `argument_list`'s sole child is a `simple_symbol` (text `:foo`) | — |
| `include Mod` / `extend Mod` / `prepend Mod` | `call` (method = one of those three, `receiver` absent) | `arguments` → `argument_list` of `constant` nodes |
| `attr_accessor :x, :y` (also `attr_reader`/`attr_writer`) | `call` (method = one of those three, `receiver` absent) | `arguments` → `argument_list` of `simple_symbol` nodes |
| `define_method(:name) { ... }` / `do...end` | `call` (method=`define_method`) | `arguments` → `argument_list` with one `simple_symbol`; `block` → `block` or `do_block` |
| `:foo` | `simple_symbol` | text is `:foo` (leading colon included) |
| `@name` | `instance_variable` | — |

---

### Task 1: Grammar wiring + Phase 1 (flat class/module/method extraction)

**Files:**
- Modify: `package.json`
- Modify: `src/graph/extract.ts`
- Modify: `src/graph/bindings.ts`
- Modify: `test/graph-languages.test.ts`
- Create: `test/graph-ruby.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `Language` union gains `"ruby"`. `languageOf("foo.rb") === "ruby"`, `languageLabelOf("foo.rb") === "ruby"`. `extractFile(rel, source, "ruby")` returns `{ nodes, rawEdges }` with `class`/`module`/`method`/`function` kind nodes; the resolved graph (via `buildGraph`/`readGraph`) carries `contains` edges, `extends` edges for `class Foo < Bar`, and `calls` edges for `self.method`/bare calls.
- Consumes: nothing from later tasks (this is the foundation).

- [ ] **Step 1: Add the grammar dependency**

```bash
npm install tree-sitter-ruby@^0.23.1
```

Verify `package.json`'s `dependencies` block now has `"tree-sitter-ruby": "^0.23.1"` alphabetically placed next to the other `tree-sitter-*` entries (after `tree-sitter-python`, before `tree-sitter-typescript`).

- [ ] **Step 2: Write the failing test**

Create `test/graph-ruby.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFile, languageOf, languageLabelOf } from "../src/graph/extract.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

test("ruby: .rb maps to the ruby grammar and label", () => {
  assert.equal(languageOf("app/models/user.rb"), "ruby");
  assert.equal(languageLabelOf("app/models/user.rb"), "ruby");
  assert.equal(languageOf("app/models/user.txt"), null);
});

const ANIMAL_RB = `
module Greeting
  def hi
    "hi"
  end
end

class Animal
  def speak
    "..."
  end

  def initialize(name)
    @name = name
  end
end

class Dog < Animal
  def bark
    "woof"
  end
end

def top_level_helper
  1
end
`;

test("ruby Phase 1: extracts modules/classes/methods with correct kind and ownership", () => {
  const { nodes } = extractFile("animal.rb", ANIMAL_RB, "ruby");
  const byName = (name: string) => nodes.find((n) => n.name === name);

  assert.equal(byName("Greeting")?.kind, "module");
  assert.equal(byName("Animal")?.kind, "class");
  assert.equal(byName("Dog")?.kind, "class");

  assert.equal(byName("hi")?.kind, "method");
  assert.equal(byName("hi")?.owner, "Greeting");
  assert.equal(byName("speak")?.kind, "method");
  assert.equal(byName("speak")?.owner, "Animal");
  assert.equal(byName("bark")?.owner, "Dog");

  assert.equal(byName("top_level_helper")?.kind, "function");
  assert.equal(byName("top_level_helper")?.owner, undefined);
});

test("ruby Phase 1: initialize is not exported, everything else defaults to exported", () => {
  const { nodes } = extractFile("animal.rb", ANIMAL_RB, "ruby");
  assert.equal(nodes.find((n) => n.name === "initialize")?.exported, false);
  assert.equal(nodes.find((n) => n.name === "speak")?.exported, true);
  assert.equal(nodes.find((n) => n.name === "hi")?.exported, true);
});

test("ruby Phase 1: class Dog < Animal resolves to an extends edge", async () => {
  const { dir, graph } = await buildAndRead({ "animal.rb": ANIMAL_RB });
  try {
    const edge = graph.edges.find(
      (e) => e.relation === "extends" && e.source === "animal.rb#Dog" && e.target === "animal.rb#Animal",
    );
    assert.ok(edge, "Dog --extends--> Animal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 1: contains edges wire file to top-level defs, class to its methods", async () => {
  const { dir, graph } = await buildAndRead({ "animal.rb": ANIMAL_RB });
  try {
    assert.ok(
      graph.edges.some((e) => e.relation === "contains" && e.source === "animal.rb" && e.target === "animal.rb#Animal"),
    );
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "contains" && e.source === "animal.rb#Animal" && e.target === "animal.rb#Animal.speak",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 1: a bare top-level call resolves by name", async () => {
  const src = `
def helper
  1
end

def caller
  helper
end
`;
  const { dir, graph } = await buildAndRead({ "calls.rb": src });
  try {
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "calls.rb#caller" && e.target === "calls.rb#helper",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 1: self.method resolves via the enclosing class", async () => {
  const src = `
class Widget
  def a
    self.b
  end

  def b
    1
  end
end
`;
  const { dir, graph } = await buildAndRead({ "widget.rb": src });
  try {
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "widget.rb#Widget.a" && e.target === "widget.rb#Widget.b",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 1: a bare super() with no explicit callee emits no call edge", async () => {
  const src = `
class Animal
  def initialize(name); end
end

class Dog < Animal
  def initialize(name)
    super(name)
  end
end
`;
  const { dir, graph } = await buildAndRead({ "dog.rb": src });
  try {
    assert.equal(
      graph.edges.some((e) => e.relation === "calls" && e.source === "dog.rb#Dog.initialize"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test test/graph-ruby.test.ts`
Expected: FAIL — `languageOf` returns `null` for `.rb` (ruby not yet registered), and `extractFile(..., "ruby")` fails the TypeScript build (`"ruby"` isn't assignable to `Language`).

- [ ] **Step 4: Wire the grammar and extension**

In `src/graph/extract.ts`, add the import near the other grammar imports:

```typescript
import Ruby from "tree-sitter-ruby";
```

Extend the `Language` union:

```typescript
export type Language = "typescript" | "tsx" | "python" | "go" | "java" | "php" | "r" | "ruby";
```

Add to `EXTENSIONS` (after the `.php` entry, before the `.r` entry — the ordering only matters for longest-suffix-first cases, and `.rb` doesn't collide with any existing suffix):

```typescript
  { ext: ".rb", grammar: "ruby", label: "ruby" },
```

Add to `GRAMMARS`:

```typescript
const GRAMMARS: Record<Language, unknown> = {
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
  go: Go,
  r: R,
  java: Java,
  php: PHP.php,
  ruby: Ruby,
};
```

Add to `CALL_TYPES`:

```typescript
  ruby: new Set(["call"]),
```

Add an empty `RUBY_KINDS` table next to `R_KINDS`, with the same "kind computed dynamically" rationale as R and Go:

```typescript
// Ruby: `class`/`module`/`method`/`singleton_method` all carry a real `name`
// field, but a bare `method` node's KIND depends on whether it's lexically
// inside a class/module (→ "method") or at top level (→ "function") — same
// promotion Python does for `function_definition` — so it's resolved
// dynamically in describeRuby() rather than a static table lookup.
const RUBY_KINDS: Record<string, Kind> = {};
```

Add it to `KINDS_BY_LANG`:

```typescript
  ruby: RUBY_KINDS,
```

- [ ] **Step 5: Add `describeRuby` and wire it into `describe()`**

In `describe()`, add the dispatch (after the `php` closure-detection branch, before the function falls through to the shared TS/PHP-named-def logic):

```typescript
  if (ctx.lang === "ruby") return describeRuby(node, ctx);
```

Add `describeRuby` and its helpers near the R-specific functions at the bottom of the file:

```typescript
/**
 * Ruby definition shapes for Phase 1: `class`, `module`, and `def` (plain
 * instance/top-level methods — `def self.x`/`def obj.x`/`class << self` land
 * in Phase 2). Unlike R, Ruby's grammar hands us real class/module nodes
 * directly — there's no S3/S4-style naming-convention inference to do here.
 */
function describeRuby(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "class" || node.type === "module") {
    const nameNode = node.childForFieldName("name");
    // `class A::B` (compact nesting) names itself via a `scope_resolution`
    // node, not a plain `constant` — deliberately unhandled (Phase 1 stays to
    // the common `class Foo` / `module Foo` shape; see spec's "erring toward
    // false negatives" precedent).
    if (nameNode?.type !== "constant") return null;
    const body = node.childForFieldName("body");
    const hashNode = body ?? node;
    return {
      name: nameNode.text,
      kind: node.type === "class" ? "class" : "module",
      headerEnd: (body ?? node).startIndex,
      hashNode,
    };
  }
  if (node.type === "method") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const body = node.childForFieldName("body");
    return {
      name: nameNode.text,
      // A `def` promotes to "method" only when lexically nested inside a
      // class/module — a top-level `def` is a free function for our
      // purposes, mirroring Python's own function→method promotion.
      kind: ctx.enclosingClass !== null ? "method" : "function",
      headerEnd: (body ?? node).startIndex,
      hashNode: body ?? node,
    };
  }
  return null;
}
```

- [ ] **Step 6: Extend `enclosingClass` propagation to cover Ruby modules**

In `walk()`, find:

```typescript
    const enclosingClass =
      desc.kind === "class" || javaTypeDecl
        ? desc.name
        : isGoMethod
          ? goReceiverType(node)
          : (desc.owner ?? ctx.enclosingClass);
```

Replace with:

```typescript
    // Ruby modules own methods and are mixin targets exactly like classes do
    // (see Phase 4) — `enclosingClass` is reused as the generic "nearest
    // owning type" slot, not literally class-only, matching how Java already
    // widens it for interfaces/enums/structs via javaTypeDecl.
    const rubyModuleDecl = ctx.lang === "ruby" && desc.kind === "module";
    const enclosingClass =
      desc.kind === "class" || javaTypeDecl || rubyModuleDecl
        ? desc.name
        : isGoMethod
          ? goReceiverType(node)
          : (desc.owner ?? ctx.enclosingClass);
```

- [ ] **Step 7: Add the `extends` heritage edge for `class Foo < Bar`**

In `heritageEdges()`, add a branch (the function already special-cases `java`/`python`/`r`; add `ruby` alongside them):

```typescript
  if (ctx.lang === "ruby") {
    const superclass = node.childForFieldName("superclass");
    const constant = superclass?.namedChildren[0];
    if (constant?.type === "constant") {
      edges.push({ source: classId, relation: "extends", name: constant.text, file: ctx.rel });
    }
    return edges;
  }
```

- [ ] **Step 8: Add `rubyCallee` and wire it into `calleeName()`**

At the very top of `calleeName()` (before the `if (lang === "java")` branch — Ruby's `call` node has no `function` field at all, so it must be intercepted before the shared `fn = node.childForFieldName("function")` line the same way Java and PHP already are):

```typescript
  if (lang === "ruby") return rubyCallee(node);
```

Add the helper near the other Ruby functions:

```typescript
/**
 * Ruby's `call` node splits the callee into `receiver` + `method` fields
 * (never a single `function` field), so it's intercepted before the shared
 * lookup every other language uses. `self.method` resolves directly to the
 * enclosing class via the already-generic "self" handling in
 * resolveRecvType — no Ruby-specific binding table needed. Every other
 * receiver shape (`obj.method`, `Klass.method`, or no receiver at all) is a
 * bare-name match: there's no type-binding table (see spec Non-goals), so
 * `receiver` is deliberately left unset rather than passed through as an
 * unresolvable string. `super(...)`'s implicit callee (no `method` field at
 * all) returns null — no call edge, matching the "erring toward false
 * negatives" precedent.
 */
function rubyCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string; kinds?: Kind[] } | null {
  const methodNode = node.childForFieldName("method");
  if (!methodNode) return null;
  const receiverNode = node.childForFieldName("receiver");
  if (receiverNode?.type === "self") return { name: methodNode.text, viaMember: true, receiver: "self" };
  return { name: methodNode.text, viaMember: false };
}
```

- [ ] **Step 9: Add the `exported` computation for Ruby**

Find the `exported:` ternary chain in `walk()`:

```typescript
      exported:
        ctx.lang === "python"
          ? !desc.name.startsWith("_")
          : ctx.lang === "go"
            ? goExported(desc.name)
            : ctx.lang === "r"
              ? rExported(desc.name, ctx, node)
              : ctx.lang === "java"
                ? javaExported(node)
                : ctx.lang === "php"
                  ? phpExported(node)
                  : tsExported(node),
```

Add a `ruby` branch:

```typescript
      exported:
        ctx.lang === "python"
          ? !desc.name.startsWith("_")
          : ctx.lang === "go"
            ? goExported(desc.name)
            : ctx.lang === "r"
              ? rExported(desc.name, ctx, node)
              : ctx.lang === "java"
                ? javaExported(node)
                : ctx.lang === "php"
                  ? phpExported(node)
                  : ctx.lang === "ruby"
                    ? rubyExported(desc.name)
                    : tsExported(node),
```

Add the Phase-1 baseline helper (Phase 3 will replace this with real visibility tracking):

```typescript
/**
 * Phase 1 baseline, ahead of Phase 3's real private/protected/public
 * tracking: `initialize` is unconditionally private by Ruby language rule
 * regardless of the surrounding visibility mode, so it's correct standalone
 * and Phase 3 layers on top of it rather than replacing it.
 */
function rubyExported(name: string): boolean {
  return name !== "initialize";
}
```

- [ ] **Step 10: Wire `bindings.ts`**

In `defName()`, add a branch (after the `r` branch, before `php`):

```typescript
  if (lang === "ruby") {
    const rubyDefTypes = new Set(["class", "module", "method", "singleton_method"]);
    if (rubyDefTypes.has(node.type)) return node.childForFieldName("name")?.text ?? null;
    return null;
  }
```

In `visit()`'s language dispatch, add a `ruby` branch next to R's (no binding collection — see spec Non-goals, same reasoning as R's own "no classes yet" comment, except Ruby's reason is "no type-binding table by design," not "no classes yet"):

```typescript
  // Ruby has no receiver-type binding table by design (see spec Non-goals) —
  // self.method resolves directly via ctx.enclosingClass, and every other
  // member call is a bare-name match. No handleRuby needed.
  else if (lang === "ruby") void 0;
```

- [ ] **Step 11: Register Ruby in the language-registration test**

Open `test/graph-languages.test.ts` and find the existing per-language registration assertions (one block per language — R's is the most recent). Add a matching block for Ruby's `.rb` extension, following the exact same assertion shape already used there (extension→grammar, extension→label, and inclusion in `depthExtensions()`).

- [ ] **Step 12: Run the test to verify it passes**

Run: `node --import tsx --test test/graph-ruby.test.ts test/graph-languages.test.ts`
Expected: PASS

- [ ] **Step 13: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS (no other test file references the `Language` union exhaustively in a way a new variant would break, but this catches it if one does)

- [ ] **Step 14: Add the CHANGELOG entry**

Add to the top of `CHANGELOG.md`, under an `## [Unreleased]` heading (create one if absent, following the file's existing entry format):

```markdown
### Added
- feat: add Ruby language support (Phase 1: flat class/module/method extraction)
```

- [ ] **Step 15: Commit**

```bash
git add package.json package-lock.json src/graph/extract.ts src/graph/bindings.ts test/graph-languages.test.ts test/graph-ruby.test.ts CHANGELOG.md
git commit -m "feat: add Ruby language support (Phase 1: flat class/module extraction)"
```

---

### Task 2: Phase 2 — singleton methods

**Files:**
- Modify: `src/graph/extract.ts`
- Create: `test/graph-ruby-phase2.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `describeRuby`, `WalkCtx`, `mintId` from Task 1.
- Produces: `singleton_method` nodes (`def self.x`, `def obj.x`) and methods inside `class << self` blocks are extracted as `kind: "method"` nodes owned by the enclosing class — no new `Kind` variant (matches how Java's own static methods are also plain `kind: "method"`, indistinguishable from instance methods in the schema).

- [ ] **Step 1: Write the failing test**

Create `test/graph-ruby-phase2.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFile } from "../src/graph/extract.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-phase2-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

test("ruby Phase 2: def self.x is a method owned by the enclosing class", () => {
  const src = `
class Animal
  def self.create(name)
    new(name)
  end
end
`;
  const { nodes } = extractFile("animal.rb", src, "ruby");
  const create = nodes.find((n) => n.name === "create");
  assert.equal(create?.kind, "method");
  assert.equal(create?.owner, "Animal");
});

test("ruby Phase 2: def obj.x (arbitrary-receiver singleton method) is handled the same way", () => {
  const src = `
class Animal
  def obj.tag; end
end
`;
  const { nodes } = extractFile("animal.rb", src, "ruby");
  const tag = nodes.find((n) => n.name === "tag");
  assert.equal(tag?.kind, "method");
  assert.equal(tag?.owner, "Animal");
});

test("ruby Phase 2: methods inside class << self ... end are owned by the enclosing class", async () => {
  const src = `
class Animal
  class << self
    def factory
      1
    end
  end
end
`;
  const { dir, graph } = await buildAndRead({ "animal.rb": src });
  try {
    const factory = graph.nodes.find((n) => n.id === "animal.rb#Animal.factory");
    assert.equal(factory?.owner, "Animal");
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "contains" && e.source === "animal.rb#Animal" && e.target === "animal.rb#Animal.factory",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 2: a self.x call resolves to a singleton method via self", async () => {
  const src = `
class Animal
  def self.a
    self.b
  end

  def self.b
    1
  end
end
`;
  const { dir, graph } = await buildAndRead({ "animal.rb": src });
  try {
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "animal.rb#Animal.a" && e.target === "animal.rb#Animal.b",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/graph-ruby-phase2.test.ts`
Expected: FAIL — `singleton_method` nodes aren't recognized by `describeRuby` yet (returns `null`, so `create`/`tag`/`factory` aren't found), and methods inside `class << self` aren't reached (nothing intercepts `singleton_class`).

- [ ] **Step 3: Handle `singleton_method` in `describeRuby`**

Add a branch to `describeRuby` (after the `method` branch):

```typescript
  if (node.type === "singleton_method") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const body = node.childForFieldName("body");
    return {
      name: nameNode.text,
      // Owned by the enclosing class regardless of whether the receiver was
      // `self` or an arbitrary object expression (`def obj.x`) — Phase 2's
      // scope is recognizing the shape, not modeling per-object singleton
      // methods distinctly (no schema field exists for that distinction
      // anyway; see Java's own static methods for precedent).
      kind: "method",
      headerEnd: (body ?? node).startIndex,
      hashNode: body ?? node,
    };
  }
```

- [ ] **Step 4: Intercept `singleton_class` in `walk()`**

`singleton_class` (`class << self ... end`) doesn't itself mint a definition — it just re-parents its body's ordinary `method` nodes to the *already*-enclosing class, which they already are (`class << self` never changes lexical nesting — the enclosing class is unchanged). Verify with a quick trace: `describeRuby` for a `method` node already reads `ctx.enclosingClass`, which was set when `Animal`'s own class node was walked and never changes again until a *different* class/module is entered — `singleton_class` is not a class/module node, so plain recursion through its `namedChildren` (already the default fallback for any non-definition node) reaches `factory` with `ctx.enclosingClass` still `"Animal"`. **No code change is needed for this step** — it already works via `describe()` returning `null` for `singleton_class` and the shared `for (const child of node.namedChildren) walk(child, ctx, out, edges, minted);` fallback at the end of `walk()`.

Delete this step's premise from the plan by verifying it directly: run the Step 2 test file again after Step 3 alone.

Run: `node --import tsx --test test/graph-ruby-phase2.test.ts`
Expected: PASS (all four cases, including the `class << self` one, since `singleton_class` needed no special-casing — only `def self.x`/`def obj.x` did).

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Add the CHANGELOG entry**

```markdown
- feat: add Ruby language support (Phase 2: singleton methods)
```

- [ ] **Step 7: Commit**

```bash
git add src/graph/extract.ts test/graph-ruby-phase2.test.ts CHANGELOG.md
git commit -m "feat: Ruby Phase 2 -- singleton methods (def self.x, def obj.x, class << self)"
```

---

### Task 3: Phase 3 — visibility

**Files:**
- Modify: `src/graph/extract.ts`
- Create: `test/graph-ruby-phase3.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `describeRuby`, `WalkCtx`, `rubyExported` from Tasks 1-2.
- Produces: `WalkCtx` gains `rubyVisibility: "public" | "protected" | "private"` (mode-switch state) and `rubyPostHocVisibility: ReadonlyMap<string, "protected" | "private">` (per-class-body pre-scan for `private :sym`/`protected :sym`). `rubyExported` is replaced by a visibility-aware computation consumed the same way (called from the same `exported:` ternary slot).

- [ ] **Step 1: Write the failing test**

Create `test/graph-ruby-phase3.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";

test("ruby Phase 3: defaults to public, switches to private on a bare `private`", () => {
  const src = `
class Widget
  def pub_a; end

  private

  def priv_b; end
  def priv_c; end
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  const byName = (n: string) => nodes.find((x) => x.name === n);
  assert.equal(byName("pub_a")?.exported, true);
  assert.equal(byName("priv_b")?.exported, false);
  assert.equal(byName("priv_c")?.exported, false);
});

test("ruby Phase 3: switches back to public on a bare `public`", () => {
  const src = `
class Widget
  private
  def a; end
  public
  def b; end
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "a")?.exported, false);
  assert.equal(nodes.find((n) => n.name === "b")?.exported, true);
});

test("ruby Phase 3: protected is treated as not-exported, same as private", () => {
  const src = `
class Widget
  protected
  def a; end
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "a")?.exported, false);
});

test("ruby Phase 3: private def foo; end (inline form) marks only that method", () => {
  const src = `
class Widget
  def pub_a; end
  private def priv_b; end
  def pub_c; end
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "pub_a")?.exported, true);
  assert.equal(nodes.find((n) => n.name === "priv_b")?.exported, false);
  assert.equal(nodes.find((n) => n.name === "pub_c")?.exported, true);
});

test("ruby Phase 3: private :foo (post-hoc symbol form) marks an already-defined method", () => {
  const src = `
class Widget
  def a; end
  def b; end

  private :a
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "a")?.exported, false);
  assert.equal(nodes.find((n) => n.name === "b")?.exported, true);
});

test("ruby Phase 3: initialize stays private regardless of the surrounding visibility mode", () => {
  const src = `
class Widget
  public
  def initialize; end
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "initialize")?.exported, false);
});

test("ruby Phase 3: a nested class resets the visibility mode back to public", () => {
  const src = `
class Outer
  private
  def a; end

  class Inner
    def b; end
  end
end
`;
  const { nodes } = extractFile("outer.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "a")?.exported, false);
  assert.equal(nodes.find((n) => n.name === "b")?.exported, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/graph-ruby-phase3.test.ts`
Expected: FAIL — every method is currently `exported: true` except `initialize` (Task 1's baseline).

- [ ] **Step 3: Add the visibility fields to `WalkCtx`**

In the `WalkCtx` interface, add (near the other Ruby-Phase-N fields once Task 2 has established the pattern — for now, near `rSuperClass`):

```typescript
  // Ruby (Phase 3): the current visibility mode inside a class/module body —
  // starts "public", switches on a bare `private`/`protected`/`public`
  // identifier statement, and applies FORWARD ONLY to subsequent sibling
  // defs (Ruby language semantics). Reset to "public" whenever a genuinely
  // new class/module body is entered (mirrors rSuperClass's reset rule) —
  // NOT reset per-definition, since it must stay live across sibling defs.
  rubyVisibility: "public" | "protected" | "private";
  // Ruby (Phase 3): names marked private/protected by a POST-HOC symbol
  // call (`private :foo`) anywhere in the CURRENT class/module body,
  // pre-scanned once when that body is entered (see rubyPostHocVisibility())
  // — because such a call can appear textually after the def it targets,
  // a single forward pass over rubyVisibility can't see it in time. Reset
  // whenever a new class/module body is entered, same trigger as
  // rubyVisibility.
  rubyPostHoc: ReadonlyMap<string, "protected" | "private">;
```

Seed both in `extractFile()`'s initial `ctx`:

```typescript
    rubyVisibility: "public",
    rubyPostHoc: EMPTY_MAP,
```

Add the shared empty-map constant next to `EMPTY_SET`:

```typescript
const EMPTY_MAP: ReadonlyMap<string, "protected" | "private"> = new Map();
```

- [ ] **Step 4: Pre-scan post-hoc visibility when entering a class/module body**

In `walk()`, in the `childCtx` construction (the same block Task 1 touched for `enclosingClass`), reset/recompute both fields whenever a new class/module is entered — find the `rSuperClass:` line and add alongside it:

```typescript
      rSuperClass: desc.kind === "class" ? (ctx.lang === "r" ? rR6ParentClass(node) : null) : ctx.rSuperClass,
      rubyVisibility:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module") ? "public" : ctx.rubyVisibility,
      rubyPostHoc:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module")
          ? rubyPostHocVisibility(node)
          : ctx.rubyPostHoc,
```

Add the pre-scan helper near the other Ruby functions:

```typescript
/**
 * One shallow pass over a class/module's own `body`, collecting every
 * `private :sym`/`protected :sym` post-hoc call — see WalkCtx.rubyPostHoc's
 * doc comment for why this can't be folded into the forward
 * rubyVisibility pass. Deliberately shallow (direct body children only,
 * `namedChildren` not a full recursive walk) — a `private :sym` nested
 * inside a conditional or another method body is not a class-level
 * visibility declaration and should not be treated as one.
 */
function rubyPostHocVisibility(classOrModuleNode: Parser.SyntaxNode): ReadonlyMap<string, "protected" | "private"> {
  const body = classOrModuleNode.childForFieldName("body");
  if (!body) return EMPTY_MAP;
  const out = new Map<string, "protected" | "private">();
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "call") continue;
    const methodNode = stmt.childForFieldName("method");
    if (methodNode?.type !== "identifier") continue;
    if (methodNode.text !== "private" && methodNode.text !== "protected") continue;
    const args = stmt.childForFieldName("arguments");
    const sym = args?.namedChildren[0];
    if (sym?.type === "simple_symbol") out.set(sym.text.slice(1), methodNode.text as "protected" | "private");
  }
  return out;
}
```

- [ ] **Step 5: Track the forward mode-switch and the inline `private def foo; end` form**

Bare `private`/`protected`/`public` is a plain `identifier` node (not a `call` — see the grounding table), so it needs interception in `walk()`'s generic (non-definition) path, at the same level as the existing `identifier`-handling branch for imported-symbol references. Find:

```typescript
  } else if (
    node.type === "identifier" &&
    !isDirectCallee(node, callTypes) &&
    !isDeclarationName(node)
  ) {
```

This existing branch already only fires for identifiers that are references, not declarations or callees — a bare `private` statement is neither a callee (no call node wraps it) nor a declaration name, so it currently falls into this branch and gets treated as an unmatched reference lookup (harmless no-op, since `ctx.importedSymbols` is always empty for Ruby). Add a Ruby visibility-mode check ahead of it as its own branch:

```typescript
  } else if (
    ctx.lang === "ruby" &&
    node.type === "identifier" &&
    (node.text === "private" || node.text === "protected" || node.text === "public") &&
    node.parent?.type === "body_statement"
  ) {
    // Forward-only mode switch — mutate the SAME ctx object's visibility
    // isn't possible (ctx is threaded by value through sibling calls), so
    // this rebinds `ctx` for the remainder of this walk() call's sibling
    // loop. That's safe: `ctx` here is a local parameter binding, and this
    // node has no children to descend into (bare identifier), so there is
    // no risk of a child seeing a stale value — only later SIBLINGS (walked
    // by the caller's own loop, which reads ctx.rubyVisibility fresh each
    // iteration since it's captured in the shared childCtx object) do, and
    // that's exactly the forward-only semantics wanted. See Step 6 for how
    // the sibling loop actually observes this.
    return;
  }
```

This alone can't mutate the caller's loop state (each `walk()` call gets its own `ctx` parameter). The actual mode-switch has to live where the sibling loop iterates — in the shared `for (const child of node.namedChildren) walk(child, childCtx, out, edges, minted);` fallback at the end of `walk()`. Replace that single generic loop with a Ruby-aware version used only when `ctx.lang === "ruby"` and the node is a class/module `body_statement` (the only place a mode switch can legally appear at the level that matters):

Find the final line of `walk()`:

```typescript
  for (const child of node.namedChildren) walk(child, ctx, out, edges, minted);
}
```

Replace with:

```typescript
  if (ctx.lang === "ruby" && node.type === "body_statement") {
    let visibility = ctx.rubyVisibility;
    for (const child of node.namedChildren) {
      const switchTo = rubyVisibilitySwitch(child);
      if (switchTo) {
        visibility = switchTo;
        continue;
      }
      walk(child, { ...ctx, rubyVisibility: visibility }, out, edges, minted);
    }
    return;
  }
  for (const child of node.namedChildren) walk(child, ctx, out, edges, minted);
}
```

Add the mode-switch detector, and delete the now-redundant Step-5 `identifier` branch above (it's superseded by this — a bare `private`/`protected`/`public` is now consumed entirely by the `body_statement` loop's `continue`, never reaching the generic identifier-reference branch at all):

```typescript
/** A bare `private`/`protected`/`public` statement (no call, no args) — the
 * mode-switch form. Returns the mode to switch to, or null if `node` isn't
 * one. `module_function` is deliberately NOT handled — it has dual
 * public-singleton-method/private-instance-method semantics with no clean
 * fit in this schema; see the plan's Task 3 notes. */
function rubyVisibilitySwitch(node: Parser.SyntaxNode): "public" | "protected" | "private" | null {
  if (node.type !== "identifier") return null;
  if (node.text === "private" || node.text === "protected" || node.text === "public") return node.text;
  return null;
}
```

- [ ] **Step 6: Handle the inline `private def foo; end` form**

This shape is a `call` node (`method` field = `private`/`protected`, `arguments` → a single `method` node) — it must be intercepted before the generic `callTypes.has(node.type)` call-edge path treats it as an ordinary call to a function named "private". In the `body_statement` loop added in Step 5, before calling `walk()` on a non-switch child, check for this shape and rewrite the visibility inline rather than descending normally:

```typescript
      const inline = rubyInlineVisibility(child);
      if (inline) {
        walk(inline.methodNode, { ...ctx, rubyVisibility: inline.visibility }, out, edges, minted);
        continue;
      }
      walk(child, { ...ctx, rubyVisibility: visibility }, out, edges, minted);
```

(This replaces the plain `walk(child, ...)` call from Step 5 — the full loop body is now: check switch, check inline, else walk normally.)

Add the detector:

```typescript
/** `private def foo; end` / `protected def foo; end` — the inline form.
 * Returns the wrapped method node and the one-off visibility to apply to it
 * (independent of, and without mutating, the surrounding mode-switch
 * state), or null if `node` isn't this shape. */
function rubyInlineVisibility(
  node: Parser.SyntaxNode,
): { methodNode: Parser.SyntaxNode; visibility: "protected" | "private" } | null {
  if (node.type !== "call") return null;
  const methodField = node.childForFieldName("method");
  if (methodField?.type !== "identifier") return null;
  if (methodField.text !== "private" && methodField.text !== "protected") return null;
  const args = node.childForFieldName("arguments");
  const sole = args?.namedChildren[0];
  if (sole?.type !== "method" && sole?.type !== "singleton_method") return null;
  return { methodNode: sole, visibility: methodField.text as "protected" | "private" };
}
```

- [ ] **Step 7: Replace `rubyExported` with the full visibility computation**

Replace the Task 1 `rubyExported` function:

```typescript
function rubyExported(name: string): boolean {
  return name !== "initialize";
}
```

with:

```typescript
/**
 * `initialize` is unconditionally private by Ruby language rule, regardless
 * of the surrounding visibility mode. Otherwise: a post-hoc `private
 * :name`/`protected :name` in the current class/module body wins over the
 * forward mode-switch state (it's a more specific, deliberate override);
 * absent that, the current mode-switch state (already resolved to an inline
 * override, if any, by the caller passing a one-off ctx — see
 * rubyInlineVisibility) decides.
 */
function rubyExported(name: string, ctx: WalkCtx): boolean {
  if (name === "initialize") return false;
  const postHoc = ctx.rubyPostHoc.get(name);
  if (postHoc) return false;
  return ctx.rubyVisibility === "public";
}
```

Update its one call site (the `exported:` ternary from Task 1 Step 9):

```typescript
                  : ctx.lang === "ruby"
                    ? rubyExported(desc.name, ctx)
                    : tsExported(node),
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --import tsx --test test/graph-ruby-phase3.test.ts`
Expected: PASS

- [ ] **Step 9: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS — pay particular attention to `test/graph-ruby.test.ts` and `test/graph-ruby-phase2.test.ts` (the `body_statement` loop rewrite in Step 5 changes how every Ruby class/module body is walked, not just visibility-bearing ones).

- [ ] **Step 10: Add the CHANGELOG entry**

```markdown
- feat: add Ruby language support (Phase 3: private/protected/public visibility)
```

- [ ] **Step 11: Commit**

```bash
git add src/graph/extract.ts test/graph-ruby-phase3.test.ts CHANGELOG.md
git commit -m "feat: Ruby Phase 3 -- private/protected/public visibility"
```

---

### Task 4: Phase 4 — mixin composition edges

**Files:**
- Modify: `src/graph/extract.ts`
- Create: `test/graph-ruby-phase4.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `rubyCallee`, `WalkCtx.enclosingClass` from Tasks 1-3.
- Produces: `include Mod`/`extend Mod`/`prepend Mod` inside a class/module body emit an `extends`-relation `RawEdge` from the enclosing class/module to `Mod` (reusing the existing `extends` relation — the schema has no separate `includes`/mixin relation, and adding one would touch the breadth tier and viewer beyond this plan's scope). Non-self member calls (`obj.method`) gain `kinds: ["function", "method"]` so bare-name resolution can match methods pulled in via mixins — this needs **no `resolve.ts` change**, since `RawEdge.kinds` and its generic handling in `resolve.ts` already exist from R's own Phase 4.

- [ ] **Step 1: Write the failing test**

Create `test/graph-ruby-phase4.test.ts`. Tests assert on the RESOLVED graph (`buildGraph`/`readGraph`), not on `extractFile()`'s unresolved `RawEdge[]` — this repo's convention (see `test/graph-r-phase4.test.ts`) verifies functional outcomes (does the edge resolve, to what target) rather than internal fields like `kinds`/`viaMember`, which are implementation detail. Each fixture defines every module it references so the edge actually resolves instead of being silently dropped as unresolved.

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-phase4-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

test("ruby Phase 4: include Mod resolves to an extends edge", async () => {
  const src = `
module Comparable2
  def cmp; end
end

class Widget
  include Comparable2
end
`;
  const { dir, graph } = await buildAndRead({ "widget.rb": src });
  try {
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "extends" && e.source === "widget.rb#Widget" && e.target === "widget.rb#Comparable2",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 4: extend and prepend each resolve to their own extends edge", async () => {
  const src = `
module Enumerable2
  def each2; end
end

module Loud2
  def shout; end
end

class Widget
  extend Enumerable2
  prepend Loud2
end
`;
  const { dir, graph } = await buildAndRead({ "widget.rb": src });
  try {
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "extends" && e.source === "widget.rb#Widget" && e.target === "widget.rb#Enumerable2",
      ),
    );
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "extends" && e.source === "widget.rb#Widget" && e.target === "widget.rb#Loud2",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 4: include Mod1, Mod2 resolves one edge per module", async () => {
  const src = `
module Mod1
  def a; end
end

module Mod2
  def b; end
end

class Widget
  include Mod1, Mod2
end
`;
  const { dir, graph } = await buildAndRead({ "widget.rb": src });
  try {
    assert.ok(graph.edges.some((e) => e.relation === "extends" && e.source === "widget.rb#Widget" && e.target === "widget.rb#Mod1"));
    assert.ok(graph.edges.some((e) => e.relation === "extends" && e.source === "widget.rb#Widget" && e.target === "widget.rb#Mod2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 4: does not emit a spurious calls edge to a function literally named include", async () => {
  const src = `
module Comparable2
  def cmp; end
end

class Widget
  include Comparable2
end
`;
  const { dir, graph } = await buildAndRead({ "widget.rb": src });
  try {
    assert.equal(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "widget.rb#Widget" && e.target.endsWith("#include"),
      ),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 4: a mixed-in module's method is reachable from an untyped member call", async () => {
  // The real point of Phase 4: Loud#shout is defined only inside the
  // module, never on Widget directly, yet an untyped `w.shout` still
  // resolves — bare-name resolution doesn't distinguish "defined directly
  // on this class" from "pulled in via include" once kinds widens to
  // include "method".
  const src = `
module Loud
  def shout; end
end

class Widget
  include Loud
end

class Caller
  def use(w)
    w.shout
  end
end
`;
  const { dir, graph } = await buildAndRead({ "widget.rb": src });
  try {
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" && e.source === "widget.rb#Caller.use" && e.target === "widget.rb#Loud.shout",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/graph-ruby-phase4.test.ts`
Expected: FAIL — no `extends` edges for `include`/`extend`/`prepend` yet (they currently fall through as ordinary, unresolvable `calls` edges), and `kinds` is never set on any Ruby `calls` edge, so the mixed-in-method member call never resolves.

- [ ] **Step 3: Intercept `include`/`extend`/`prepend` inside the call-edge branch**

Find the `callTypes.has(node.type)` branch in `walk()` (the one Task 1's `rubyCallee` plugs into via `calleeName`):

```typescript
  } else if (callTypes.has(node.type)) {
    const consumedCallee = ctx.lang === "r" && node.type === "call" ? rCalleeName(node) : null;
    const isConsumedRClassCall =
      consumedCallee === "R6Class" || (consumedCallee === "list" && rIsMixinContainer(node));
    const callee = isConsumedRClassCall ? null : calleeName(node, ctx.lang);
```

Add a Ruby mixin check ahead of the `callee` computation, mirroring how R's `isConsumedRClassCall` suppresses the ordinary call-edge path for a shape that means something else entirely:

```typescript
  } else if (callTypes.has(node.type)) {
    const rubyMixins = ctx.lang === "ruby" && ctx.enclosingClass !== null ? rubyMixinTargets(node) : [];
    if (rubyMixins.length > 0) {
      for (const target of rubyMixins) {
        edges.push({ source: ctx.parentId, relation: "extends", name: target, file: ctx.rel });
      }
      return;
    }
    const consumedCallee = ctx.lang === "r" && node.type === "call" ? rCalleeName(node) : null;
    const isConsumedRClassCall =
      consumedCallee === "R6Class" || (consumedCallee === "list" && rIsMixinContainer(node));
    const callee = isConsumedRClassCall ? null : calleeName(node, ctx.lang);
```

Add the helper near `rubyCallee`:

```typescript
const RUBY_MIXIN_KEYWORDS = new Set(["include", "extend", "prepend"]);

/**
 * `include Mod`/`extend Mod`/`prepend Mod` (bare, no receiver) inside a
 * class/module body — every named `constant` argument becomes a mixin
 * target. Returns [] for anything else (an ordinary call, or `foo.include
 * Bar` with an explicit receiver, which isn't mixin composition).
 */
function rubyMixinTargets(node: Parser.SyntaxNode): string[] {
  const methodNode = node.childForFieldName("method");
  if (methodNode?.type !== "identifier" || !RUBY_MIXIN_KEYWORDS.has(methodNode.text)) return [];
  if (node.childForFieldName("receiver")) return [];
  const args = node.childForFieldName("arguments");
  return (args?.namedChildren ?? []).filter((c) => c.type === "constant").map((c) => c.text);
}
```

- [ ] **Step 4: Widen `kinds` for non-self member calls in `rubyCallee`**

Replace the Task 1 `rubyCallee`:

```typescript
function rubyCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string; kinds?: Kind[] } | null {
  const methodNode = node.childForFieldName("method");
  if (!methodNode) return null;
  const receiverNode = node.childForFieldName("receiver");
  if (receiverNode?.type === "self") return { name: methodNode.text, viaMember: true, receiver: "self" };
  return { name: methodNode.text, viaMember: false };
}
```

with:

```typescript
function rubyCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string; kinds?: Kind[] } | null {
  const methodNode = node.childForFieldName("method");
  if (!methodNode) return null;
  const receiverNode = node.childForFieldName("receiver");
  if (receiverNode?.type === "self") return { name: methodNode.text, viaMember: true, receiver: "self" };
  // Phase 4: a receiver present but not `self` (an explicit obj.method(),
  // Klass.method(), or — with no receiver at all — a bare call inside a
  // class body) has no type-binding table to resolve against (see spec
  // Non-goals), so it's a bare-name match widened to also match "method"
  // kind nodes — the same RawEdge.kinds override R's own Phase 4
  // introduced, resolve.ts already handles it generically. This is what
  // makes a mixed-in module's methods reachable: resolveName() doesn't
  // distinguish "defined directly on this class" from "pulled in via
  // include" — it just matches by name and kind.
  if (receiverNode) return { name: methodNode.text, viaMember: false, kinds: ["function", "method"] };
  return { name: methodNode.text, viaMember: false };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test test/graph-ruby-phase4.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Add the CHANGELOG entry**

```markdown
- feat: add Ruby language support (Phase 4: include/extend/prepend mixin edges)
```

- [ ] **Step 8: Commit**

```bash
git add src/graph/extract.ts test/graph-ruby-phase4.test.ts CHANGELOG.md
git commit -m "feat: Ruby Phase 4 -- include/extend/prepend mixin composition edges"
```

---

### Task 5: Phase 5 — synthesized accessors and `define_method`

**Files:**
- Modify: `src/graph/extract.ts`
- Create: `test/graph-ruby-phase5.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `describeRuby`, `rubyExported`, `WalkCtx` from Tasks 1-4.
- Produces: `attr_accessor`/`attr_reader`/`attr_writer :sym[, ...]` synthesize one or two method-kind nodes per symbol, owned by the enclosing class. `define_method(:name) { ... }` / `do...end` synthesizes one method-kind node named `name`, with its block body walked exactly like an ordinary `def` body (so calls made inside it are still extracted).

- [ ] **Step 1: Write the failing test**

Create `test/graph-ruby-phase5.test.ts`:

Node-level facts (kind/owner/exported) use `extractFile()` directly, matching the repo's own precedent (`test/graph-php.test.ts`); `define_method`'s nested-call resolution needs the full resolved graph.

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFile } from "../src/graph/extract.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-phase5-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

test("ruby Phase 5: attr_accessor synthesizes a reader and a writer per symbol", () => {
  const src = `
class Widget
  attr_accessor :name, :age
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  const byName = (n: string) => nodes.filter((x) => x.name === n);
  assert.equal(byName("name")[0]?.kind, "method");
  assert.equal(byName("name")[0]?.owner, "Widget");
  assert.equal(byName("name=")[0]?.kind, "method");
  assert.ok(byName("age")[0]);
  assert.ok(byName("age=")[0]);
});

test("ruby Phase 5: attr_reader synthesizes only a reader", () => {
  const src = `
class Widget
  attr_reader :species
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.ok(nodes.find((n) => n.name === "species"));
  assert.equal(nodes.find((n) => n.name === "species="), undefined);
});

test("ruby Phase 5: attr_writer synthesizes only a writer", () => {
  const src = `
class Widget
  attr_writer :color
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "color"), undefined);
  assert.ok(nodes.find((n) => n.name === "color="));
});

test("ruby Phase 5: synthesized accessors respect the current visibility mode", () => {
  const src = `
class Widget
  attr_accessor :pub

  private

  attr_accessor :priv
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "pub")?.exported, true);
  assert.equal(nodes.find((n) => n.name === "priv")?.exported, false);
});

test("ruby Phase 5: define_method(:x) { ... } synthesizes a method resolving calls in its body", async () => {
  const src = `
class Widget
  define_method(:dynamic) do
    helper
  end

  def helper; end
end
`;
  const { dir, graph } = await buildAndRead({ "widget.rb": src });
  try {
    const dyn = graph.nodes.find((n) => n.name === "dynamic");
    assert.equal(dyn?.kind, "method");
    assert.equal(dyn?.owner, "Widget");
    assert.ok(graph.edges.some((e) => e.relation === "calls" && e.source === dyn?.id && e.target === "widget.rb#Widget.helper"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruby Phase 5: define_method with a { } block (not do...end) is recognized the same way", () => {
  const src = `
class Widget
  define_method(:dynamic) { 1 }
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "dynamic")?.kind, "method");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/graph-ruby-phase5.test.ts`
Expected: FAIL — `attr_accessor`/`attr_reader`/`attr_writer`/`define_method` calls are currently just ordinary (unresolvable) `calls` edges; no method nodes are synthesized.

- [ ] **Step 3: Intercept `attr_*` and `define_method` alongside the Phase 4 mixin check**

Extend the same `callTypes.has(node.type)` interception point Task 4 added, right after the `rubyMixins` check:

```typescript
    const rubyMixins = ctx.lang === "ruby" && ctx.enclosingClass !== null ? rubyMixinTargets(node) : [];
    if (rubyMixins.length > 0) {
      for (const target of rubyMixins) {
        edges.push({ source: ctx.parentId, relation: "extends", name: target, file: ctx.rel });
      }
      return;
    }
    if (ctx.lang === "ruby" && ctx.enclosingClass !== null) {
      const synthesized = rubySynthesizedMethods(node, ctx);
      if (synthesized.length > 0) {
        for (const s of synthesized) emitRubySynthesizedMethod(s, ctx, out, edges, minted);
        return;
      }
    }
```

- [ ] **Step 4: Implement `rubySynthesizedMethods`**

Add near `rubyMixinTargets`:

```typescript
interface RubySynthesizedMethod {
  name: string;
  hashNode: Parser.SyntaxNode; // span for signature/body_hash/body_text
  headerEnd: number;
}

/**
 * `attr_accessor`/`attr_reader`/`attr_writer :sym[, ...]` and
 * `define_method(:name) { ... }` — call shapes that stand for one or more
 * method definitions with no `def`/`method` node of their own. Returns []
 * for anything else, so the caller can safely fall through to the ordinary
 * call-edge path.
 */
function rubySynthesizedMethods(node: Parser.SyntaxNode, ctx: WalkCtx): RubySynthesizedMethod[] {
  const methodNode = node.childForFieldName("method");
  if (methodNode?.type !== "identifier") return [];
  if (node.childForFieldName("receiver")) return [];
  const args = node.childForFieldName("arguments");
  const symbols = (args?.namedChildren ?? []).filter((c) => c.type === "simple_symbol").map((c) => c.text.slice(1));

  if (methodNode.text === "attr_reader") return symbols.map((s) => ({ name: s, hashNode: node, headerEnd: node.startIndex }));
  if (methodNode.text === "attr_writer") return symbols.map((s) => ({ name: `${s}=`, hashNode: node, headerEnd: node.startIndex }));
  if (methodNode.text === "attr_accessor") {
    return symbols.flatMap((s) => [
      { name: s, hashNode: node, headerEnd: node.startIndex },
      { name: `${s}=`, hashNode: node, headerEnd: node.startIndex },
    ]);
  }
  if (methodNode.text === "define_method") {
    const sym = args?.namedChildren[0];
    if (sym?.type !== "simple_symbol") return [];
    const block = node.childForFieldName("block");
    if (!block) return [];
    return [{ name: sym.text.slice(1), hashNode: block, headerEnd: block.startIndex }];
  }
  return [];
}
```

- [ ] **Step 5: Implement `emitRubySynthesizedMethod`**

This mints and pushes a `NodeV1` + its `contains` edge exactly the way `walk()`'s main definition-handling block does for an ordinary `def`, and — for `define_method` only — descends into the block body so nested calls are still captured (an `attr_*`-synthesized method has no body to descend into).

```typescript
function emitRubySynthesizedMethod(
  m: RubySynthesizedMethod,
  ctx: WalkCtx,
  out: NodeV1[],
  edges: RawEdge[],
  minted: Set<string>,
): void {
  const base = `${ctx.rel}#${[...ctx.scope, m.name].join(".")}`;
  const id = mintId(base, minted);
  out.push({
    id,
    name: m.name,
    kind: "method",
    path: ctx.rel,
    span: `L${m.hashNode.startPosition.row + 1}-L${m.hashNode.endPosition.row + 1}`,
    signature: clean(ctx.source.slice(m.hashNode.startIndex, m.headerEnd)),
    exported: rubyExported(m.name, ctx),
    origin: "ast",
    body_hash: contentHash(m.hashNode.text),
    body_text: searchBody(m.hashNode.text),
    summary_state: "pending",
    summary: null,
    crux: null,
    owner: ctx.enclosingClass ?? undefined,
  });
  edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
  // define_method's block body can contain further calls/definitions — walk
  // it under a child scope exactly like an ordinary method body would get.
  // attr_* synthesized methods have no such body (m.hashNode is the whole
  // call node, nothing further to descend into beyond what the outer walk
  // already will).
  if (m.hashNode.type === "block" || m.hashNode.type === "do_block") {
    const childCtx: WalkCtx = {
      ...ctx,
      scope: [...ctx.scope, m.name],
      enclosingKind: "method",
      parentId: id,
    };
    for (const child of m.hashNode.namedChildren) walk(child, childCtx, out, edges, minted);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --import tsx --test test/graph-ruby-phase5.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Add the CHANGELOG entry**

```markdown
- feat: add Ruby language support (Phase 5: attr_accessor/reader/writer and define_method synthesis)
```

- [ ] **Step 9: Commit**

```bash
git add src/graph/extract.ts test/graph-ruby-phase5.test.ts CHANGELOG.md
git commit -m "feat: Ruby Phase 5 -- attr_* accessors and define_method synthesis"
```

---

### Task 6: Docs — README full-fidelity tier + CHANGELOG condensing

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing code-level — this is the final documentation pass, matching R's own `ab35844`/`0c5bf60` commits.

- [ ] **Step 1: Add Ruby to the README's full-fidelity tier list**

Open `README.md` and find the full-fidelity tier's language list (the block listing TypeScript/Python/Go/Java/PHP/R with their one-line capability summaries — R's own entry, e.g. `**R** (\`.R\`/\`.r\` — plain functions, S3/S4/R6 classes and methods, roxygen ...)`, is the template to match). Add a Ruby entry in the same format, alphabetically placed, summarizing this plan's phases in one line:

```markdown
- **Ruby** (`.rb` — classes, modules, instance/singleton methods, private/protected/public visibility, include/extend/prepend mixin composition, attr_accessor/reader/writer and define_method synthesis)
```

- [ ] **Step 2: Condense the CHANGELOG entries into one bullet**

Open `CHANGELOG.md`. Replace the five separate `feat: add Ruby language support (Phase N: ...)` bullets added across Tasks 1-5 with a single condensed bullet in the `## [Unreleased]` section, following the exact pattern of R's own `docs: condense the R CHANGELOG entry to one bullet` commit:

```markdown
- feat: add Ruby language support (classes, modules, instance/singleton methods, visibility, mixin composition, attr_* and define_method synthesis)
```

- [ ] **Step 3: Verify the full test suite still passes**

Run: `npm test`
Expected: PASS (docs-only change, but confirms nothing was accidentally left broken from Task 5)

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: Ruby joins the full-fidelity tier in the README"
```

---

## Self-Review Notes

- **Spec coverage:** every phase in `docs/superpowers/specs/2026-08-31-ruby-support-design.md` maps 1:1 to a task (Phase 1→Task 1, Phase 2→Task 2, Phase 3→Task 3, Phase 4→Task 4, Phase 5→Task 5); the spec's final README/CHANGELOG step maps to Task 6. The Non-goals section (no metaprogramming beyond `define_method`, no type-binding table, no LSP) is enforced structurally — no task adds any of them.
- **Implementation clarifications made during planning, within spec scope:** (1) singleton methods get `kind: "method"` like every other method, not a new `Kind` variant — the schema has no field for it and Java's own static methods already set this precedent; (2) mixin edges reuse the existing `extends` relation rather than adding a new one, since a `RawEdge`/`EdgeV1` schema change would ripple into the breadth tier and viewer, outside this plan's scope; (3) Phase 4's `kinds` widening needs zero `resolve.ts` changes, since R's own Phase 4 already made that mechanism generic.
- **Type consistency check:** `rubyExported` changes signature between Task 1 (`(name: string)`) and Task 3 (`(name: string, ctx: WalkCtx)`) — Task 3 Step 7 explicitly shows updating the one call site. `WalkCtx.rubyVisibility`/`rubyPostHoc` are introduced in Task 3 and consumed by Task 5's `emitRubySynthesizedMethod` via `rubyExported(m.name, ctx)` — same signature, no drift.
