/**
 * Tests for C/C++ extraction in the Tier-1 code graph. Builds a small header/source
 * pair in a temp dir and asserts the emitted nodes (classes, structs, enums, template
 * classes, methods) and edges (contains, extends, calls, includes) match the AST walk
 * in extract.ts. The header/source-split case (a method declared in a `.h` and defined
 * out-of-line in a `.cpp`) is the main risk area — get it wrong and half of every
 * method in a real C++ codebase silently disappears from the graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const WIDGET_H = `#pragma once

class Base1 {
public:
    void foo();
};

class Base2 {
public:
    void bar();
};

class Helper {
public:
    void ping() {}
    int publicField() { return 1; }
private:
    void hidden() {}
};

class Internal {
    void secret() {}
};

namespace app {

class Widget : public Base1, private Base2 {
public:
    Widget();
    ~Widget();
    void render();
    int width() const;
    static int nextId();
    void useHelper() { this->helper_.ping(); }

private:
    int width_;
    Helper helper_;
};

template<typename T>
class Box {
public:
    T value;
};

enum class Color { Red, Green, Blue };

struct Point {
    int x;
    int y;
    int sum() { return x + y; }
};

}  // namespace app
`;

const WIDGET_CPP = `#include "widget.h"
#include <algorithm>

namespace app {

Widget::Widget() : width_(0) {}

Widget::~Widget() {}

void Widget::render() {
    width_ = this->width();
}

int Widget::width() const {
    return width_;
}

int Widget::nextId() {
    return 1;
}

int freeHelper() {
    return Widget::nextId();
}

int useStd() {
    return std::max(1, 2);
}

}  // namespace app
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-cpp-"));
  writeFileSync(join(dir, "widget.h"), WIDGET_H);
  writeFileSync(join(dir, "widget.cpp"), WIDGET_CPP);
  return dir;
}

function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("C++ extraction: classes, structs, enums, template class", async () => {
  const dir = makeFixture();
  try {
    const result = await buildGraph(dir);
    assert.ok(result.languages.includes("cpp"), "languages should include cpp");
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.equal(nodeById(graph, "widget.h#Widget")?.kind, "class");
    assert.equal(nodeById(graph, "widget.h#Point")?.kind, "struct");
    assert.equal(nodeById(graph, "widget.h#Color")?.kind, "enum");

    const box = nodeById(graph, "widget.h#Box");
    assert.equal(box?.kind, "class");
    // template_declaration's span/signature is attributed to the class node, so
    // the card doesn't cut off the `template<typename T>` line.
    assert.match(box!.signature ?? "", /^template<typename T>/);
    assert.match(box!.signature ?? "", /class Box/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C++ extraction: header prototype + out-of-line definition resolve to ONE node", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // The critical assertion: `void render();` in widget.h is a bare prototype
    // (no body) and is skipped entirely — only the `.cpp`'s out-of-line
    // `Widget::render() {}` emits a node. Not two nodes, not zero.
    const renders = graph.nodes.filter((n) => n.name === "render" && n.kind === "method");
    assert.equal(renders.length, 1, "exactly one node for render(), not duplicated or missing");
    assert.equal(renders[0].id, "widget.cpp#Widget.render");
    assert.equal(renders[0].owner, "Widget");
    assert.equal(nodeById(graph, "widget.h#Widget.render"), undefined, "no node should exist in the header");

    // Same story for the constructor, destructor, and a static method.
    assert.equal(nodeById(graph, "widget.cpp#Widget.Widget")?.owner, "Widget");
    assert.equal(nodeById(graph, "widget.cpp#Widget.~Widget")?.owner, "Widget");
    assert.equal(nodeById(graph, "widget.cpp#Widget.nextId")?.owner, "Widget");

    // Base1/Base2's own prototype-only methods (never defined anywhere) emit no nodes.
    assert.equal(graph.nodes.some((n) => n.name === "foo"), false);
    assert.equal(graph.nodes.some((n) => n.name === "bar"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C++ extraction: visibility via access_specifier state-tracking", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.equal(nodeById(graph, "widget.h#Helper.ping")?.exported, true);
    assert.equal(nodeById(graph, "widget.h#Helper.hidden")?.exported, false);
    // No explicit `private:` needed — a class defaults to private.
    assert.equal(nodeById(graph, "widget.h#Internal.secret")?.exported, false);
    // No explicit `public:` needed — a struct defaults to public.
    assert.equal(nodeById(graph, "widget.h#Point.sum")?.exported, true);
    assert.equal(nodeById(graph, "widget.h#Widget.useHelper")?.exported, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C++ extraction: heritage edges (multiple inheritance, both -> extends)", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const widget = nodeById(graph, "widget.h#Widget")!;
    const toBase1 = graph.edges.find(
      (e) => e.relation === "extends" && e.source === widget.id && e.target === "widget.h#Base1",
    );
    const toBase2 = graph.edges.find(
      (e) => e.relation === "extends" && e.source === widget.id && e.target === "widget.h#Base2",
    );
    assert.ok(toBase1, "Widget should extend Base1 (public)");
    assert.ok(toBase2, "Widget should extend Base2 (private) — C++ has no interface keyword, every base is extends");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C++ extraction: call edges — member (this->), qualified (Class::method)", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    // this->width() from within an out-of-line method resolves via the receiver
    // special-case (no bindings lookup needed: "this" -> ctx.enclosingClass).
    const memberCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "widget.cpp#Widget.render" && e.target === "widget.cpp#Widget.width",
    );
    assert.ok(memberCall, "Widget::render should have a resolved calls edge to Widget::width via this->");

    // this->helper_.ping() resolves via a member-field type binding (handleCpp),
    // same file as the field declaration so the binding pass sees both.
    const fieldCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "widget.h#Widget.useHelper" && e.target === "widget.h#Helper.ping",
    );
    assert.ok(fieldCall, "Widget::useHelper should resolve this->helper_.ping() via the member-field binding");

    // Widget::nextId() — explicit qualified call — resolves via recvType supplied
    // directly from the qualifier (bypassing bindings entirely).
    const qualifiedCall = graph.edges.find(
      (e) => e.relation === "calls" && e.source === "widget.cpp#freeHelper" && e.target === "widget.cpp#Widget.nextId",
    );
    assert.ok(qualifiedCall, "freeHelper should resolve the qualified Widget::nextId() call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C++ extraction: #include edges, local and system forms", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const local = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "widget.cpp" && e.target === "widget.h",
    );
    assert.ok(local, `#include "widget.h" should be captured`);

    const system = graph.edges.find(
      (e) => e.relation === "imports" && e.source === "widget.cpp" && e.target === "algorithm",
    );
    assert.ok(system, "#include <algorithm> should be captured, stripped of angle brackets");
    assert.equal(nodeById(graph, "algorithm"), undefined, "a system header never resolves to an in-repo node");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C++ extraction: contains edges (file -> class -> method nesting)", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    const widget = nodeById(graph, "widget.h#Widget")!;
    assert.ok(
      graph.edges.some((e) => e.relation === "contains" && e.source === "widget.h" && e.target === widget.id),
      "widget.h should contain Widget",
    );
    const useHelper = nodeById(graph, "widget.h#Widget.useHelper")!;
    assert.ok(
      graph.edges.some((e) => e.relation === "contains" && e.source === widget.id && e.target === useHelper.id),
      "Widget should contain its in-class inline method useHelper",
    );
    // Out-of-line methods are NOT nested under the class node lexically (same as
    // Go's receiver-qualified methods) — they're contained by the file directly.
    const render = nodeById(graph, "widget.cpp#Widget.render")!;
    assert.ok(
      graph.edges.some((e) => e.relation === "contains" && e.source === "widget.cpp" && e.target === render.id),
      "widget.cpp should directly contain the out-of-line Widget::render definition",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C — the same grammar (tree-sitter-cpp parses C as a near-superset) over a
// header/source split. What C adds beyond the C++ cases above: prototypes,
// typedefs and unions in a header are the symbols a reader navigates by, so
// they must be nodes; a prototype must not shadow its definition at a call
// site; and a same-file forward declaration must not mint a second node.
// ---------------------------------------------------------------------------

const APP_H = `#pragma once

typedef struct { int x; int y; } Point;
typedef int Id;
typedef struct Node { struct Node *next; } Node;
typedef enum Mode { FAST, SLOW } Mode;
union Value { int i; float f; };
enum Color { RED, GREEN };

int run(int argc);
char *name_of(Id id);
extern int (*callback)(int);
`;

const APP_C = `#include "app.h"

static int helper(void);

int run(int argc) { return helper() + argc; }

static int helper(void) { return 1; }
`;

const MAIN_C = `#include "app.h"

int main(void) { return run(0); }
`;

function makeCFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-c-"));
  writeFileSync(join(dir, "app.h"), APP_H);
  writeFileSync(join(dir, "app.c"), APP_C);
  writeFileSync(join(dir, "main.c"), MAIN_C);
  return dir;
}

test("C extraction: .c files are indexed by the depth tier", async () => {
  const dir = makeCFixture();
  try {
    const result = await buildGraph(dir);
    assert.ok(result.languages.includes("c"), `languages should include "c", got ${result.languages}`);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.equal(nodeById(graph, "app.c#run")?.kind, "function");
    assert.equal(nodeById(graph, "main.c#main")?.kind, "function");
    // `static int helper(void);` + its definition below: ONE node, the definition.
    const helpers = graph.nodes.filter((n) => n.path === "app.c" && n.name === "helper");
    assert.equal(helpers.length, 1, `forward declaration must not mint a second node: ${helpers.map((n) => n.id)}`);
    assert.equal(helpers[0].span, "L7-L7", "the surviving node is the definition, not the forward declaration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C extraction: header prototypes, typedefs and unions become nodes", async () => {
  const dir = makeCFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.equal(nodeById(graph, "app.h#run")?.kind, "function", "prototype");
    assert.equal(nodeById(graph, "app.h#name_of")?.kind, "function", "prototype returning a pointer");
    assert.equal(nodeById(graph, "app.h#callback"), undefined, "a function-pointer VARIABLE is not a prototype");

    assert.equal(nodeById(graph, "app.h#Point")?.kind, "struct", "typedef of an anonymous struct takes the struct's kind");
    assert.equal(nodeById(graph, "app.h#Id")?.kind, "type", "typedef of a scalar is a type alias");
    assert.equal(nodeById(graph, "app.h#Node")?.kind, "struct");
    assert.equal(nodeById(graph, "app.h#Node~2"), undefined, "typedef struct Node {…} Node; is ONE node");
    assert.equal(nodeById(graph, "app.h#Mode")?.kind, "enum");
    assert.equal(nodeById(graph, "app.h#Mode~2"), undefined, "typedef enum Mode {…} Mode; is ONE node");
    assert.equal(nodeById(graph, "app.h#Value")?.kind, "struct", "a union is a nominal aggregate, like a struct");
    assert.equal(nodeById(graph, "app.h#Color")?.kind, "enum");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C extraction: a cross-file call resolves to the definition, not the header prototype", async () => {
  const dir = makeCFixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    const calls = graph.edges.filter((e) => e.relation === "calls");

    assert.ok(
      calls.some((e) => e.source === "main.c#main" && e.target === "app.c#run"),
      `main() -> run() should resolve to the definition; got ${JSON.stringify(calls)}`,
    );
    assert.ok(!calls.some((e) => e.source === "main.c#main" && e.target === "app.h#run"), "never to the prototype");
    assert.ok(calls.some((e) => e.source === "app.c#run" && e.target === "app.c#helper"), "same-file call resolves locally");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
