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

test("ruby Phase 3: private :a, :b (multi-symbol post-hoc form) marks every listed name", () => {
  const src = `
class Widget
  def a; end
  def b; end
  def c; end

  private :a, :b
end
`;
  const { nodes } = extractFile("widget.rb", src, "ruby");
  assert.equal(nodes.find((n) => n.name === "a")?.exported, false);
  assert.equal(nodes.find((n) => n.name === "b")?.exported, false);
  assert.equal(nodes.find((n) => n.name === "c")?.exported, true);
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
