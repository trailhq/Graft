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
