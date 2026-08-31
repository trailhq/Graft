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

test("ruby Phase 1: a bare identifier used as an assignment RHS (a parameter read) is not a call candidate", async () => {
  // `name` exists as a real top-level function in this file, so a
  // false-positive "calls" edge from `@name = name` (where `name` is
  // unambiguously the `initialize` parameter, not a call) would actually
  // resolve to it — proving the assertion below isn't vacuous the way it
  // would be if `name` resolved to nothing regardless.
  const src = `
def name
  "shadow"
end

class Person
  def initialize(name)
    @name = name
  end
end
`;
  const { dir, graph } = await buildAndRead({ "person.rb": src });
  try {
    assert.equal(
      graph.edges.some(
        (e) =>
          e.relation === "calls" &&
          e.source === "person.rb#Person.initialize" &&
          e.target === "person.rb#name",
      ),
      false,
      "a bare identifier on an assignment's right-hand side must not be treated as a call",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
