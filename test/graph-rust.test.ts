import { test } from "node:test";
import assert from "node:assert/strict";
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust/bindings/node/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectBindings } from "../src/graph/bindings.js";
import { buildGraph } from "../src/graph/build.js";
import { extractFile } from "../src/graph/extract.js";
import { readGraph } from "../src/graph/write.js";

test("Rust extraction: definitions, owners, module scopes, exports, and trait heritage", () => {
  const src = `
pub struct Cache<T> { value: T }
struct Private;
pub(self) struct SelfOnly;
pub(crate) enum Mode { Fast }
pub trait Backend<T> {
    fn required(&self);
    fn defaulted(&self) {}
}
pub type Alias = Cache<u8>;
pub union Bits { raw: u32 }

impl<T> Cache<T> {
    pub fn open(&self) {}
    pub(crate) fn crate_visible(&self) {}
    pub(self) fn self_only(&self) {}
    fn private(&self) {}
}

impl<T> Backend<T> for Cache<T> {
    fn required(&self) {}
}

#[macro_export]
macro_rules! exported_macro { () => {} }
macro_rules! local_macro { () => {} }

mod imp { pub fn open() {} }
#[cfg(test)]
mod tests { pub fn hidden() {} }
#[cfg(not(test))]
mod production { pub fn visible() {} }
`;
  const { nodes, rawEdges } = extractFile("defs.rs", src, "rust");
  const byId = (id: string) => nodes.find((node) => node.id === id);

  assert.equal(byId("defs.rs#Cache")?.kind, "struct");
  assert.equal(byId("defs.rs#Private")?.kind, "struct");
  assert.equal(byId("defs.rs#SelfOnly")?.kind, "struct");
  assert.equal(byId("defs.rs#Mode")?.kind, "enum");
  assert.equal(byId("defs.rs#Backend")?.kind, "interface");
  assert.equal(byId("defs.rs#Alias")?.kind, "type");
  assert.equal(byId("defs.rs#Bits")?.kind, "struct");
  assert.equal(byId("defs.rs#exported_macro!")?.kind, "function");
  assert.equal(byId("defs.rs#local_macro!")?.kind, "function");

  assert.equal(byId("defs.rs#Cache.open")?.kind, "method");
  assert.equal(byId("defs.rs#Cache.open")?.owner, "Cache");
  assert.equal(byId("defs.rs#Cache.required")?.kind, "method");
  assert.equal(byId("defs.rs#Cache.required")?.owner, "Cache");
  assert.equal(byId("defs.rs#Backend.required")?.kind, "method");
  assert.equal(byId("defs.rs#Backend.required")?.owner, "Backend");
  assert.equal(byId("defs.rs#Backend.defaulted")?.owner, "Backend");
  assert.equal(byId("defs.rs#imp.open")?.kind, "function");
  assert.equal(byId("defs.rs#tests.hidden")?.exported, false);
  assert.equal(byId("defs.rs#production.visible")?.exported, true);

  assert.equal(byId("defs.rs#Cache")?.exported, true);
  assert.equal(byId("defs.rs#Private")?.exported, false);
  assert.equal(byId("defs.rs#SelfOnly")?.exported, false);
  assert.equal(byId("defs.rs#Mode")?.exported, true);
  assert.equal(byId("defs.rs#Cache.open")?.exported, true);
  assert.equal(byId("defs.rs#Cache.crate_visible")?.exported, true);
  assert.equal(byId("defs.rs#Cache.self_only")?.exported, false);
  assert.equal(byId("defs.rs#Cache.private")?.exported, false);
  assert.equal(byId("defs.rs#Cache.required")?.exported, true);
  assert.equal(byId("defs.rs#Backend.required")?.exported, true);
  assert.equal(byId("defs.rs#exported_macro!")?.exported, true);
  assert.equal(byId("defs.rs#local_macro!")?.exported, false);

  assert.ok(
    rawEdges.some(
      (edge) =>
        edge.relation === "extends" &&
        edge.source === "defs.rs#Cache" &&
        edge.name === "Backend" &&
        edge.lang === "rust",
    ),
  );
});

test("Rust extraction: calls carry receiver types, module specifiers, macro namespaces, and guards", () => {
  const src = `
struct Worker<T> { value: T }
struct Factory;
fn bare<T>() {}
fn compute() {}

impl<T> Worker<T> {
    fn helper(&self) {}
    fn inside(&self) {
        Self::helper(self);
    }
}

fn exercise(param: &mut Worker<u8>, tuple: (fn(),)) {
    bare();
    bare::<u8>();
    let typed: &mut Worker<u8> = param;
    typed.run();
    typed.run::<u8>();
    param.run();
    let made = Factory::with_name();
    made.make();
    Worker::build();
    crate::worker::run();
    some_mod::run();
    super::run();
    tuple.0();
    println!("ignored");
    assert_eq!(compute(), 1);
    log_it!(compute());
    std::println!("ignored");
    crate::macros::local_log!();
}
`;
  const calls = extractFile("calls.rs", src, "rust").rawEdges.filter((edge) => edge.relation === "calls");
  const named = (name: string) => calls.filter((edge) => edge.name === name);

  assert.equal(named("bare").length, 2);
  assert.deepEqual(named("run").map((edge) => edge.recvType), ["Worker", "Worker", "Worker", undefined, undefined, undefined]);
  assert.deepEqual(named("run").slice(3).map((edge) => edge.specifier), ["crate::worker", "some_mod", "super"]);
  assert.ok(named("run").slice(0, 3).every((edge) => edge.viaMember));
  assert.ok(named("run").slice(3).every((edge) => !edge.viaMember));
  assert.equal(named("make")[0]?.recvType, "Factory");
  assert.equal(named("build")[0]?.recvType, "Worker");
  assert.equal(named("helper")[0]?.recvType, "Worker");
  assert.equal(named("log_it!").length, 1);
  assert.equal(named("local_log!").length, 1);
  assert.equal(named("println!").length, 0);
  assert.equal(named("assert_eq!").length, 0);
  assert.equal(named("compute").length, 0, "macro token trees stay opaque");
  assert.equal(named("0").length, 0, "tuple indexes are not method names");
  assert.ok(calls.every((edge) => edge.lang === "rust"));
});

test("Rust extraction: use forms retain full per-leaf paths and bodyless mods import", () => {
  const src = `
use foo;
use crate::models::Thing;
use crate::models::{Widget, helper, Thing as Renamed, self};
use crate::models::*;
use crate::Original as Alias;
mod x;
#[path = "alternate.rs"]
mod redirected;
mod inline {
    mod leaf;
    pub fn nested() {}
}

fn uses() {
    let _a = Thing;
    let _b = Renamed;
    let _c = Alias;
    let _d = helper;
}
`;
  const { nodes, rawEdges } = extractFile("imports.rs", src, "rust");
  const imports = rawEdges.filter((edge) => edge.relation === "imports");
  assert.deepEqual(
    imports.map((edge) => edge.specifier),
    [
      "foo",
      "crate::models::Thing",
      "crate::models::Widget",
      "crate::models::helper",
      "crate::models::Thing",
      "crate::models::self",
      "crate::models::*",
      "crate::Original",
      "self::x",
      "self::inline::leaf",
    ],
  );
  assert.ok(imports.every((edge) => edge.lang === "rust"));
  assert.equal(nodes.find((node) => node.id === "imports.rs#inline.nested")?.kind, "function");

  const references = rawEdges.filter((edge) => edge.relation === "references");
  assert.deepEqual(
    references.map((edge) => ({ name: edge.name, specifier: edge.specifier })),
    [
      { name: "Thing", specifier: "crate::models::Thing" },
      { name: "Thing", specifier: "crate::models::Thing" },
      { name: "Original", specifier: "crate::Original" },
    ],
  );
  assert.ok(!references.some((edge) => edge.name === "helper"));
});

test("Rust extraction: inline-module prefixes are consumed for scoped calls", () => {
  const calls = extractFile(
    "src/foo.rs",
    "mod helper;\nmod tests { fn t() { super::helper::go(); } }\n",
    "rust",
  ).rawEdges.filter((edge) => edge.relation === "calls");

  assert.deepEqual(
    calls.map((edge) => ({ source: edge.source, name: edge.name, specifier: edge.specifier })),
    [{ source: "src/foo.rs#tests.t", name: "go", specifier: undefined }],
  );
});

test("Rust extraction: macro signatures stop before bodies and qualified calls use the leaf name", () => {
  const { nodes, rawEdges } = extractFile(
    "macros.rs",
    "macro_rules! local_log { () => { 42 } }\nfn invoke() { std::println!(\"x\"); crate::macros::local_log!(); }\n",
    "rust",
  );

  assert.equal(nodes.find((node) => node.id === "macros.rs#local_log!")?.signature, "macro_rules! local_log { ()");
  assert.deepEqual(
    rawEdges.filter((edge) => edge.relation === "calls").map((edge) => edge.name),
    ["local_log!"],
  );
});

test("Rust extraction handles CRLF input", () => {
  const result = extractFile("crlf.rs", "pub fn from_crlf() {\r\n  helper();\r\n}\r\n", "rust");
  assert.equal(result.nodes.find((node) => node.name === "from_crlf")?.kind, "function");
});

test("Rust extraction parses definitions beyond the 32 KB chunk boundary", () => {
  const padding = Array.from({ length: 3_000 }, (_, i) => `// padding ${i}`).join("\n");
  const source = `${padding}\npub fn after_boundary() {}\n`;
  assert.ok(source.length > 32_768);
  assert.equal(
    extractFile("large.rs", source, "rust").nodes.find((node) => node.name === "after_boundary")?.kind,
    "function",
  );
});

test("Rust builds tolerate malformed files and keep recoverable definitions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-malformed-"));
  try {
    writeFileSync(join(dir, "broken.rs"), "pub fn before() {}\nfn broken( {\npub fn after() {}\n");
    const result = await buildGraph(dir, {
      contextDir: join(dir, ".graft-test"),
      graphOnly: true,
      reuse: false,
    });
    assert.deepEqual(result.errors, []);
    const graph = readGraph(result.graphPath);
    assert.equal(graph?.nodes.find((node) => node.name === "before")?.kind, "function");
    assert.equal(graph?.nodes.find((node) => node.name === "after")?.kind, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust extraction degrades gracefully on &raw syntax", () => {
  const { nodes } = extractFile(
    "raw.rs",
    "static VALUE: u8 = 1;\nfn pointer() { let _ptr = &raw const VALUE; }\npub fn after_raw() {}\n",
    "rust",
  );
  assert.equal(nodes.find((node) => node.name === "pointer")?.kind, "function");
  assert.equal(nodes.find((node) => node.name === "after_raw")?.kind, "function");
});

test("Rust extraction: inline modules consume same-file self and super prefixes", () => {
  const src = `
struct Item;
mod tests {
    use super::*;
    use super::Item;
    use self::Local;
    use super::super::external::Thing;
    use crate::absolute::CrateItem;

    fn uses() {
        let _item = Item;
        let _local = Local;
        let _thing = Thing;
        let _crate_item = CrateItem;
    }
}
`;
  const { rawEdges } = extractFile("inline.rs", src, "rust");
  const imports = rawEdges.filter((edge) => edge.relation === "imports");
  assert.deepEqual(
    imports.map((edge) => edge.specifier),
    ["super::external::Thing", "crate::absolute::CrateItem"],
  );

  const references = rawEdges.filter((edge) => edge.relation === "references");
  assert.deepEqual(
    references.map((edge) => ({ name: edge.name, specifier: edge.specifier })),
    [
      { name: "Thing", specifier: "super::external::Thing" },
      { name: "CrateItem", specifier: "crate::absolute::CrateItem" },
    ],
  );
});

test("Rust extraction mints module and constant nodes, matching the breadth tier's rust.scm", () => {
  const src = `
pub mod inline { pub fn nested() {} }
mod bodyless;
#[path = "alternate.rs"]
mod redirected;
pub const LIMIT: u8 = 1;
static PRIVATE_FLAG: bool = false;
const fn build() {}
#[cfg(test)]
mod tests { pub const INNER: u8 = 2; }
`;
  const { nodes, rawEdges } = extractFile("mods.rs", src, "rust");
  const byId = (id: string) => nodes.find((node) => node.id === id);

  // `mod` mints a module node — inline and bodyless alike — with the name, not
  // the body, as its signature.
  assert.equal(byId("mods.rs#inline")?.kind, "module");
  assert.equal(byId("mods.rs#inline")?.signature, "pub mod inline");
  assert.equal(byId("mods.rs#inline")?.exported, true);
  assert.equal(byId("mods.rs#bodyless")?.kind, "module");
  assert.equal(byId("mods.rs#bodyless")?.signature, "mod bodyless");
  assert.equal(byId("mods.rs#redirected")?.kind, "module");
  assert.ok(
    rawEdges.some(
      (edge) =>
        edge.relation === "contains" && edge.source === "mods.rs#inline" && edge.targetId === "mods.rs#inline.nested",
    ),
    "an inline module structurally owns its children",
  );
  assert.equal(byId("mods.rs#inline.nested")?.kind, "function");

  // const/static items are constants; the initializer is the body, never the signature.
  assert.equal(byId("mods.rs#LIMIT")?.kind, "constant");
  assert.equal(byId("mods.rs#LIMIT")?.signature, "pub const LIMIT: u8");
  assert.equal(byId("mods.rs#LIMIT")?.exported, true);
  assert.equal(byId("mods.rs#PRIVATE_FLAG")?.kind, "constant");
  assert.equal(byId("mods.rs#PRIVATE_FLAG")?.exported, false);
  assert.equal(byId("mods.rs#build")?.kind, "function", "a const-qualified fn is still a function");

  // cfg(test) suppression reaches through the module node.
  assert.equal(byId("mods.rs#tests")?.exported, false);
  assert.equal(byId("mods.rs#tests.INNER")?.kind, "constant");
  assert.equal(byId("mods.rs#tests.INNER")?.exported, false);

  // The bodyless form still imports its module file; #[path] retargets that out of reach.
  assert.deepEqual(
    rawEdges.filter((edge) => edge.relation === "imports").map((edge) => edge.specifier),
    ["self::bodyless"],
  );
});

test("Rust bindings: typed lets, constructor lets, and typed parameters strip wrappers and generics", () => {
  const parser = new Parser();
  parser.setLanguage(Rust as never);
  const root = parser.parse(`
fn use_workers(param: &mut Worker<u8>) {
    let typed: &Worker<String> = param;
    let made = Factory::with_name();
}
`).rootNode;
  const bindings = collectBindings(root, "rust");

  assert.equal(bindings.lookup(["use_workers"], "param"), "Worker");
  assert.equal(bindings.lookup(["use_workers"], "typed"), "Worker");
  assert.equal(bindings.lookup(["use_workers"], "made"), "Factory");
});
