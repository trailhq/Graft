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
