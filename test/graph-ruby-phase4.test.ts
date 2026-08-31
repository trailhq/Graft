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
