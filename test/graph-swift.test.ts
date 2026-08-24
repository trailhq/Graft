/**
 * Full-fidelity Swift extraction (the depth tier), promoted from the generic
 * breadth tier the same way Kotlin was (#130).
 *
 * What these pin, and why each matters:
 *  - the kind split the breadth tier could not make: `class_declaration` is ONE
 *    node type for `class` / `struct` / `enum` / `actor` / `extension`, told
 *    apart only by their own keyword token — the tags query labelled all of
 *    them "class";
 *  - extension member attribution, Swift's biggest structural quirk: a method
 *    declared in `extension Point` must belong to Point (owner, enclosingClass,
 *    member-call resolution), not to a node named "extension";
 *  - call edges at all — the breadth tier's swift query had NO @reference.call
 *    captures, so every Swift repo had symbols and zero wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { extractFile, type RawEdge } from "../src/graph/extract.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function extract(source: string): { nodes: NodeV1[]; rawEdges: RawEdge[] } {
  return extractFile("app/Model.swift", source, "swift");
}

function byName(nodes: NodeV1[], name: string): NodeV1[] {
  return nodes.filter((n) => n.name === name);
}

test("swift: the five class_declaration keywords map to their real kinds", () => {
  const { nodes } = extract(`
class Animal {}
struct Point {}
enum Direction {}
actor Counter {}
protocol Greeter {}
typealias Distance = Double
`);
  assert.equal(byName(nodes, "Animal")[0]?.kind, "class");
  assert.equal(byName(nodes, "Point")[0]?.kind, "struct");
  assert.equal(byName(nodes, "Direction")[0]?.kind, "enum");
  assert.equal(byName(nodes, "Counter")[0]?.kind, "class"); // actor: class-like, no dedicated kind
  assert.equal(byName(nodes, "Greeter")[0]?.kind, "interface");
  assert.equal(byName(nodes, "Distance")[0]?.kind, "type");
});

test("swift: functions are methods inside a type, functions at top level", () => {
  const { nodes } = extract(`
func helper() {}

struct Point {
  func norm() -> Double { return 0 }
}

protocol Greeter {
  func greet(name: String) -> String
}
`);
  assert.equal(byName(nodes, "helper")[0]?.kind, "function");
  const norm = byName(nodes, "norm")[0];
  assert.equal(norm?.kind, "method");
  assert.equal(norm?.owner, "Point");
  const greet = byName(nodes, "greet")[0];
  assert.equal(greet?.kind, "method");
  assert.equal(greet?.owner, "Greeter");
});

test("swift: an initializer is a method named after its type", () => {
  const { nodes } = extract(`
class Animal {
  init(legs: Int) {}
}
`);
  const inits = byName(nodes, "Animal").filter((n) => n.kind === "method");
  assert.equal(inits.length, 1);
  assert.equal(inits[0]?.owner, "Animal");
});

test("swift: extension members belong to the extended type", () => {
  const { nodes, rawEdges } = extract(`
struct Point {
  var x = 0.0
}

extension Point {
  func scaled(by f: Double) -> Point { return helper() }
}
`);
  const scaled = byName(nodes, "scaled")[0];
  assert.equal(scaled?.kind, "method");
  assert.equal(scaled?.owner, "Point", "an extension method's owner is the extended type");
  // The extension node itself is a member-contributing scope, not a second type
  // declaration — kind "module", so the real `struct Point` stays the unique
  // type named Point (see the resolution test below for what that protects).
  assert.deepEqual(
    byName(nodes, "Point").map((n) => n.kind).sort(),
    ["module", "struct"],
  );
  // The call inside the extension method attributes to the method, not the file.
  const call = rawEdges.find((e) => e.relation === "calls" && e.name === "helper");
  assert.ok(call?.source.includes("scaled"), "call attributed to the extension method");
});

test("swift: call edges — bare, member with receiver, self and super", () => {
  const { rawEdges } = extract(`
class Animal {
  func greet() {}
  func walk() {
    self.greet()
    super.describe()
    helper()
  }
}

func helper() {
  let a = Animal()
  a.walk()
}
`);
  const calls = rawEdges.filter((e) => e.relation === "calls");
  const selfCall = calls.find((e) => e.name === "greet");
  assert.equal(selfCall?.viaMember, true);
  assert.equal(selfCall?.recvType, "Animal", "`self` resolves to the enclosing type");
  const superCall = calls.find((e) => e.name === "describe");
  assert.equal(superCall?.viaMember, true);
  const bare = calls.find((e) => e.name === "helper");
  assert.equal(bare?.viaMember, false);
  const member = calls.find((e) => e.name === "walk");
  assert.equal(member?.viaMember, true);
});

test("swift: trailing-closure bodies still yield the calls inside them", () => {
  const { rawEdges } = extract(`
func helper() {
  run { done() }
}
`);
  const calls = rawEdges.filter((e) => e.relation === "calls").map((e) => e.name);
  assert.ok(calls.includes("done"), "call inside a trailing closure is captured");
});

test("swift: inheritance clause yields extends edges with bare names", () => {
  const { rawEdges } = extract(`
import Foundation

class Animal: Foundation.NSObject, Greeter {}
protocol Greeter: AnyObject {}
`);
  const ext = rawEdges.filter((e) => e.relation === "extends").map((e) => e.name);
  assert.deepEqual(ext.sort(), ["AnyObject", "Greeter", "NSObject"]);
});

test("swift: imports become module-path import edges", () => {
  const { rawEdges } = extract(`
import UIKit
import struct Foundation.Date
`);
  const imports = rawEdges.filter((e) => e.relation === "imports").map((e) => e.specifier);
  assert.deepEqual(imports.sort(), ["Foundation.Date", "UIKit"]);
});

test("swift: visibility — only private/fileprivate hide a symbol", () => {
  const { nodes } = extract(`
public func a() {}
open class B {}
internal func c() {}
func d() {}
private func e() {}
fileprivate func f() {}

public class G {
  private(set) var count = 0
  private func hidden() {}
}
`);
  for (const name of ["a", "B", "c", "d", "G"]) {
    assert.equal(byName(nodes, name)[0]?.exported, true, `${name} exported`);
  }
  for (const name of ["e", "f", "hidden"]) {
    assert.equal(byName(nodes, name)[0]?.exported, false, `${name} hidden`);
  }
});

test("swift: top-level let/var are variables; type properties are not nodes", () => {
  const { nodes } = extract(`
let topLevel = 42
private var hidden = 1

class Animal {
  var legs = 4
}
`);
  assert.equal(byName(nodes, "topLevel")[0]?.kind, "variable");
  assert.equal(byName(nodes, "topLevel")[0]?.exported, true);
  assert.equal(byName(nodes, "hidden")[0]?.exported, false);
  assert.equal(byName(nodes, "legs").length, 0, "a stored property is a field, not a node");
});

/** Resolution-level pins (extract → resolve, through buildGraph): the three call
 * shapes whose per-language handling is easy to silently lose — implicit-self
 * member calls, free-function calls FROM a method, and initializer calls, which
 * in Swift are ordinary call nodes with no `new` to mark them (Python's case,
 * with struct/enum initializers as routine as class ones). */
async function buildSwift(files: Record<string, string>): Promise<GraphV1> {
  const d = mkdtempSync(join(tmpdir(), "graft-swift-"));
  mkdirSync(join(d, "Sources"), { recursive: true });
  for (const [name, src] of Object.entries(files)) writeFileSync(join(d, "Sources", name), src);
  const r = await buildGraph(d);
  const graph = readGraph(wiringPath(r.contextDir));
  assert.ok(graph, "graph built");
  return graph!;
}

function callEdges(graph: GraphV1): Array<{ from: string; to: string }> {
  const name = (id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? id;
  return graph.edges
    .filter((e) => e.relation === "calls")
    .map((e) => ({ from: name(e.source), to: name(e.target) }));
}

test("swift: implicit-self member calls resolve, and so do free-function calls from a method", async () => {
  const graph = await buildSwift({
    "Animal.swift": `
class Animal {
  func greet() {}
  func walk() {
    greet()
    helper()
  }
}

func helper() {}
`,
  });
  const calls = callEdges(graph);
  assert.ok(
    calls.some((c) => c.from === "walk" && c.to === "greet"),
    "implicit-self call resolves to the sibling method",
  );
  assert.ok(
    calls.some((c) => c.from === "walk" && c.to === "helper"),
    "a real free-function call from the same method still resolves",
  );
});

test("swift: initializer calls resolve to the constructed type (class and struct)", async () => {
  const graph = await buildSwift({
    "Model.swift": `
class Animal {}
struct Point {}
`,
    "Main.swift": `
func make() {
  let a = Animal()
  let p = Point()
}
`,
  });
  const calls = callEdges(graph);
  assert.ok(calls.some((c) => c.from === "make" && c.to === "Animal"), "class initializer edge");
  assert.ok(calls.some((c) => c.from === "make" && c.to === "Point"), "struct initializer edge");
});

test("swift: an extension does not make its type's name ambiguous", async () => {
  // The regression this pins: an `extension Animal` minted as a second CLASS named
  // Animal made every `Animal()` initializer call and `: Animal` heritage target
  // ambiguous, so they dropped. As kind "module" the extension stays out of
  // type-name resolution — and its methods still resolve as Animal's.
  const graph = await buildSwift({
    "Animal.swift": `
class Animal {
  init(legs: Int) {}
  func walk() {}
}

extension Animal {
  func run() { walk() }
}
`,
    "Main.swift": `
class Dog: Animal {}

func make() {
  let a = Animal(legs: 4)
}
`,
  });
  const calls = callEdges(graph);
  assert.ok(calls.some((c) => c.from === "make" && c.to === "Animal"), "initializer resolves");
  assert.ok(calls.some((c) => c.from === "run" && c.to === "walk"), "extension method wired in");
  const dog = graph.nodes.find((n) => n.name === "Dog");
  assert.ok(
    graph.edges.some(
      (e) =>
        e.relation === "extends" &&
        e.source === dog?.id &&
        graph.nodes.find((n) => n.id === e.target)?.kind === "class",
    ),
    "heritage resolves to the class declaration, not the extension",
  );
});

test("swift: receiver-typed member calls resolve through bindings", async () => {
  // The four binding clues, each feeding resolveRecvType a receiver type:
  // an initializer-call local, a typed parameter, a field (bare and via self.),
  // and a type-member (static) call on the type's own uppercase name.
  const graph = await buildSwift({
    "Zoo.swift": `
class Repo {
  func save() {}
}

class Keeper {
  func wave() {}
}

class Vet {
  func check() {}
}

class Animal {
  func eat() {}
  static func census() {}
}

class Zoo {
  var keeper: Keeper
  let repo = Repo()
  init(keeper k: Keeper) { self.keeper = k }
  func feed(animal: Animal) {
    let vet = Vet()
    vet.check()
    animal.eat()
    keeper.wave()
    self.repo.save()
    Animal.census()
  }
}
`,
  });
  const calls = callEdges(graph);
  const from = calls.filter((c) => c.from === "feed").map((c) => c.to).sort();
  // "Vet" is the `Vet()` initializer call itself, resolved by the ctor fallback.
  assert.deepEqual(from, ["Vet", "census", "check", "eat", "save", "wave"]);
});

test("swift: a typed receiver reaches methods declared in an extension", async () => {
  const graph = await buildSwift({
    "Point.swift": `
struct Point {}

extension Point {
  func scaled() {}
}
`,
    "Main.swift": `
func use() {
  let p = Point()
  p.scaled()
}
`,
  });
  const calls = callEdges(graph);
  assert.ok(
    calls.some((c) => c.from === "use" && c.to === "scaled"),
    "extension method resolves via the receiver's bound type",
  );
});

test("swift: an ambiguous implicit-self widening drops rather than guesses", async () => {
  // `save` is a method on TWO classes in different files; a bare `save()` inside a
  // third class matches neither uniquely, so no edge may be minted.
  const graph = await buildSwift({
    "A.swift": `class A { func save() {} }`,
    "B.swift": `class B { func save() {} }`,
    "C.swift": `class C { func work() { save() } }`,
  });
  const calls = callEdges(graph);
  assert.ok(
    !calls.some((c) => c.from === "work"),
    "ambiguous bare name resolves to nothing, never a guess",
  );
});
