import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { readGraph } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function write(root: string, rel: string, source: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source);
}

async function buildFixture(root: string): Promise<GraphV1> {
  const result = await buildGraph(root, {
    contextDir: join(root, ".graft-test"),
    graphOnly: true,
    reuse: false,
  });
  const graph = readGraph(result.graphPath);
  assert.ok(graph);
  return graph;
}

function hasEdge(graph: GraphV1, source: string, target: string, relation: string): boolean {
  return graph.edges.some((edge) => edge.source === source && edge.target === target && edge.relation === relation);
}

function node(
  id: string,
  kind: NodeV1["kind"],
  name = id.includes("#") ? id.split("#")[1].split(".").at(-1)! : id,
  owner?: string,
): NodeV1 {
  return {
    id,
    name,
    kind,
    ...(owner ? { owner } : {}),
    path: id.split("#")[0],
    span: "L1-L1",
    signature: null,
    exported: true,
    origin: "ast",
    body_hash: "h",
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

test("Rust module paths resolve file modules, items, scoped leaves, and scoped calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-resolve-"));
  try {
    write(dir, "Cargo.toml", "[package]\nname = 'root-crate'\n");
    write(
      dir,
      "src/lib.rs",
      [
        "mod alpha;",
        "mod nested;",
        "mod parser;",
        "use crate::a::B;",
        "use crate::config::env;",
        "use crate::bundle::{one::One, two::Two};",
        "use serde::Serialize;",
        "fn run() {}",
        "fn invoke() { crate::worker::run(); crate::missing::run(); }",
        "fn use_imports() { let _ = B; let _ = One; let _ = Two; }",
        "",
      ].join("\n"),
    );
    write(dir, "src/main.rs", "mod command;\n");
    write(dir, "src/alpha.rs", "pub fn alpha() {}\n");
    write(dir, "src/nested/mod.rs", "mod leaf;\nuse super::shared;\n");
    write(dir, "src/nested/leaf.rs", "pub fn leaf() {}\n");
    write(dir, "src/shared.rs", "pub fn shared() {}\n");
    write(dir, "src/command.rs", "pub fn command() {}\n");
    write(dir, "src/parser.rs", "mod lexer;\n");
    write(dir, "src/parser/lexer.rs", "pub fn lex() {}\n");
    write(dir, "src/lexer.rs", "pub fn wrong_lexer() {}\n");
    write(dir, "src/a.rs", "pub struct B;\n");
    write(dir, "src/config/env.rs", "pub fn load() {}\n");
    write(dir, "src/bundle/one.rs", "pub struct One;\n");
    write(dir, "src/bundle/two.rs", "pub struct Two;\n");
    write(dir, "src/worker.rs", "pub fn run() {}\n");
    write(dir, "src/feature/mod.rs", "use self::local;\n");
    write(dir, "src/feature/local.rs", "pub fn local() {}\n");
    write(dir, "src/feature/thing.rs", "use super::util::helper;\n");
    write(dir, "src/feature/util.rs", "pub fn helper() {}\n");

    const graph = await buildFixture(dir);

    assert.ok(hasEdge(graph, "src/lib.rs", "src/alpha.rs", "imports"), "mod x resolves x.rs");
    assert.ok(hasEdge(graph, "src/lib.rs", "src/nested/mod.rs", "imports"), "mod x resolves x/mod.rs");
    assert.ok(hasEdge(graph, "src/parser.rs", "src/parser/lexer.rs", "imports"));
    assert.ok(!hasEdge(graph, "src/parser.rs", "src/lexer.rs", "imports"), "non-root modules use their stem dir");
    assert.ok(hasEdge(graph, "src/main.rs", "src/command.rs", "imports"));
    assert.ok(hasEdge(graph, "src/nested/mod.rs", "src/nested/leaf.rs", "imports"));
    assert.ok(hasEdge(graph, "src/nested/mod.rs", "src/shared.rs", "imports"));
    assert.ok(hasEdge(graph, "src/feature/mod.rs", "src/feature/local.rs", "imports"));
    assert.ok(hasEdge(graph, "src/feature/thing.rs", "src/feature/util.rs", "imports"));

    assert.ok(hasEdge(graph, "src/lib.rs", "src/a.rs", "imports"), "item suffix retries to its module");
    assert.ok(hasEdge(graph, "src/lib.rs", "src/config/env.rs", "imports"), "module leaf is not stripped early");
    assert.ok(hasEdge(graph, "src/lib.rs", "src/bundle/one.rs", "imports"));
    assert.ok(hasEdge(graph, "src/lib.rs", "src/bundle/two.rs", "imports"));
    assert.ok(hasEdge(graph, "src/lib.rs", "serde::Serialize", "imports"), "external crates remain raw");
    assert.ok(hasEdge(graph, "src/lib.rs#use_imports", "src/a.rs#B", "references"));
    assert.ok(hasEdge(graph, "src/lib.rs#use_imports", "src/bundle/one.rs#One", "references"));
    assert.ok(hasEdge(graph, "src/lib.rs#use_imports", "src/bundle/two.rs#Two", "references"));

    assert.ok(hasEdge(graph, "src/lib.rs#invoke", "src/worker.rs#run", "calls"));
    assert.ok(!hasEdge(graph, "src/lib.rs#invoke", "src/lib.rs#run", "calls"), "scoped calls never use bare fallback");
    assert.equal(
      graph.edges.filter((edge) => edge.source === "src/lib.rs#invoke" && edge.relation === "calls").length,
      1,
      "an unresolvable scoped call is dropped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust crate paths distinguish source tests, direct auxiliary roots, and deeper support modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-integration-root-"));
  try {
    write(dir, "Cargo.toml", "[package]\nname = 'root-crate'\n");
    write(dir, "src/lib.rs", "mod shared;\n");
    write(dir, "src/shared.rs", "pub fn helper() {}\n");
    write(dir, "src/tests/foo.rs", "use crate::shared::helper;\n");
    write(dir, "src/tests/shared.rs", "pub fn wrong() {}\n");
    write(
      dir,
      "tests/foo.rs",
      "mod common;\nuse crate::common::helper;\nfn exercise() { helper(); }\n",
    );
    write(dir, "tests/common/mod.rs", "use crate::shared::helper;\n");

    const graph = await buildFixture(dir);

    assert.ok(
      hasEdge(graph, "tests/foo.rs", "tests/common/mod.rs", "imports"),
      "a direct integration-test crate root resolves mod and crate paths from its own directory",
    );
    assert.ok(
      hasEdge(graph, "src/tests/foo.rs", "src/shared.rs", "imports"),
      "a src/tests child is an ordinary source module anchored to the package crate",
    );
    assert.ok(!hasEdge(graph, "src/tests/foo.rs", "src/tests/shared.rs", "imports"));
    assert.ok(
      hasEdge(graph, "tests/common/mod.rs", "crate::shared::helper", "imports"),
      "crate paths in deeper auxiliary support modules stay raw because their declaring root is ambiguous",
    );
    assert.ok(!hasEdge(graph, "tests/common/mod.rs", "src/shared.rs", "imports"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust inline-module super calls resolve from the declaring file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-inline-call-"));
  try {
    write(dir, "Cargo.toml", "[package]\nname = 'root-crate'\n");
    write(dir, "src/lib.rs", "mod foo;\n");
    write(dir, "src/foo.rs", "mod helper;\nmod tests { fn t() { super::helper::go(); } }\n");
    write(dir, "src/foo/helper.rs", "pub fn go() {}\n");

    const graph = await buildFixture(dir);
    assert.ok(hasEdge(graph, "src/foo.rs#tests.t", "src/foo/helper.rs#go", "calls"));
    assert.ok(!hasEdge(graph, "src/foo.rs#tests.t", "src/helper.rs#go", "calls"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust mod declarations stay crate-local and resolve nested inline-module paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-mod-marker-"));
  try {
    write(dir, "crates/main/Cargo.toml", "[package]\nname = 'main'\n");
    write(dir, "crates/main/src/lib.rs", "mod parser;\nmod inline { mod leaf; }\n");
    write(dir, "crates/main/src/parser.rs", "pub fn local() {}\n");
    write(dir, "crates/main/src/inline/leaf.rs", "pub fn nested() {}\n");
    write(dir, "crates/parser/Cargo.toml", "[package]\nname = 'parser'\n");
    write(dir, "crates/parser/src/lib.rs", "pub fn external() {}\n");

    const graph = await buildFixture(dir);
    assert.ok(hasEdge(graph, "crates/main/src/lib.rs", "crates/main/src/parser.rs", "imports"));
    assert.ok(!hasEdge(graph, "crates/main/src/lib.rs", "crates/parser/src/lib.rs", "imports"));
    assert.ok(hasEdge(graph, "crates/main/src/lib.rs", "crates/main/src/inline/leaf.rs", "imports"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust workspace aliases resolve declared packages and duplicate package names stay raw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-crate-map-"));
  try {
    write(
      dir,
      "crates/app/Cargo.toml",
      "[package]\nname = 'app'\n\n[dependencies]\nrenamed = { package = 'real-package', path = '../real' }\n",
    );
    write(dir, "crates/app/src/lib.rs", "use renamed::thing;\nuse duplicate::module;\n");
    write(dir, "crates/real/Cargo.toml", "[package]\nname = 'real-package'\n");
    write(dir, "crates/real/src/lib.rs", "pub mod thing;\n");
    write(dir, "crates/real/src/thing.rs", "pub fn work() {}\n");
    write(dir, "crates/dup-a/Cargo.toml", "[package]\nname = 'duplicate'\n");
    write(dir, "crates/dup-a/src/lib.rs", "pub mod module;\n");
    write(dir, "crates/dup-a/src/module.rs", "pub fn first() {}\n");
    write(dir, "crates/dup-b/Cargo.toml", "[package]\nname = 'duplicate'\n");
    write(dir, "crates/dup-b/src/lib.rs", "pub mod module;\n");
    write(dir, "crates/dup-b/src/module.rs", "pub fn second() {}\n");

    const graph = await buildFixture(dir);
    assert.ok(hasEdge(graph, "crates/app/src/lib.rs", "crates/real/src/thing.rs", "imports"));
    assert.ok(hasEdge(graph, "crates/app/src/lib.rs", "duplicate::module", "imports"));
    assert.ok(!hasEdge(graph, "crates/app/src/lib.rs", "crates/dup-a/src/module.rs", "imports"));
    assert.ok(!hasEdge(graph, "crates/app/src/lib.rs", "crates/dup-b/src/module.rs", "imports"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust owner indexes cannot satisfy a Python typed-member call", () => {
  const nodes = [
    node("worker.rs", "file"),
    node("worker.rs#Worker.run", "method", "run", "Worker"),
    node("caller.py", "file"),
    node("caller.py#invoke", "function"),
  ];
  const edges = resolveEdges(nodes, [
    {
      source: "caller.py#invoke",
      relation: "calls",
      name: "run",
      file: "caller.py",
      viaMember: true,
      recvType: "Worker",
    },
  ]);
  assert.equal(edges.filter((edge) => edge.relation === "calls").length, 0);
});

test("Rust inline mods resolve bodyless mods and consumed super calls end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-inline-e2e-"));
  try {
    write(dir, "Cargo.toml", "[package]\nname = 'root-crate'\n");
    write(dir, "src/lib.rs", "mod outer;\n");
    write(dir, "src/outer.rs", "mod x;\nmod y;\nmod tests { mod x; fn t() { super::y::z(); } }\n");
    write(dir, "src/outer/x.rs", "pub fn root_x() {}\n");
    write(dir, "src/outer/y.rs", "pub fn z() {}\n");
    write(dir, "src/outer/tests/x.rs", "pub fn nested_x() {}\n");

    const graph = await buildFixture(dir);
    assert.ok(hasEdge(graph, "src/outer.rs", "src/outer/tests/x.rs", "imports"));
    assert.ok(hasEdge(graph, "src/outer.rs#tests.t", "src/outer/y.rs#z", "calls"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust crate paths resolve from path-inferred roots when no Cargo.toml exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-no-cargo-"));
  try {
    write(dir, "src/lib.rs", "mod worker;\nuse crate::worker::run;\nfn invoke() { crate::worker::run(); }\n");
    write(dir, "src/worker.rs", "pub fn run() {}\n");
    write(dir, "src/net/mod.rs", "use crate::shared::helper;\n");
    write(dir, "src/shared.rs", "pub fn helper() {}\n");
    write(dir, "crates/lib-a/src/lib.rs", "use crate::util::helper;\n");
    write(dir, "crates/lib-a/src/util.rs", "pub fn helper() {}\n");
    write(dir, "crates/lib-b/src/main.rs", "use crate::worker::run;\nmod local;\n");
    write(dir, "crates/lib-b/src/local.rs", "pub fn l() {}\n");
    write(dir, "tests/it.rs", "use crate::worker::run;\nfn t() {}\n");

    const graph = await buildFixture(dir);

    assert.ok(
      hasEdge(graph, "src/lib.rs", "src/worker.rs", "imports"),
      "a lib.rs-implied root resolves crate:: for its own subtree",
    );
    assert.ok(hasEdge(graph, "src/net/mod.rs", "src/shared.rs", "imports"), "nested modules keep the owning root");
    assert.ok(hasEdge(graph, "src/lib.rs#invoke", "src/worker.rs#run", "calls"));
    assert.ok(
      hasEdge(graph, "crates/lib-a/src/lib.rs", "crates/lib-a/src/util.rs", "imports"),
      "the longest inferred root wins",
    );
    assert.ok(hasEdge(graph, "crates/lib-b/src/main.rs", "crates/lib-b/src/local.rs", "imports"), "mod imports need no Cargo");
    assert.ok(
      hasEdge(graph, "crates/lib-b/src/main.rs", "crate::worker::run", "imports"),
      "an in-crate path with no matching file stays raw instead of borrowing another crate's worker.rs",
    );
    assert.ok(!hasEdge(graph, "crates/lib-b/src/main.rs", "src/worker.rs", "imports"));
    assert.ok(
      hasEdge(graph, "tests/it.rs", "crate::worker::run", "imports"),
      "a file outside every inferred root keeps its own test-binary crate::",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust module and constant nodes are never call targets", () => {
  const { nodes, rawEdges } = extractFile(
    "mods.rs",
    "mod helper;\nconst value: u8 = 1;\nfn invoke() { helper(); value(); }\n",
    "rust",
  );
  const edges = resolveEdges(nodes, rawEdges);
  assert.equal(edges.filter((edge) => edge.relation === "calls").length, 0);
});

test("Rust graph builds are byte-deterministic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-deterministic-"));
  try {
    write(dir, "Cargo.toml", "[package]\nname = 'root-crate'\n");
    write(dir, "src/lib.rs", "mod worker;\nfn invoke() { crate::worker::run(); }\n");
    write(dir, "src/worker.rs", "pub fn run() {}\n");

    const first = await buildGraph(dir, {
      contextDir: join(dir, ".graft-test"),
      graphOnly: true,
      reuse: false,
    });
    const before = readFileSync(first.graphPath);
    const second = await buildGraph(dir, {
      contextDir: join(dir, ".graft-test"),
      graphOnly: true,
      reuse: false,
    });
    assert.deepEqual(readFileSync(second.graphPath), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust workspace crate names resolve across crates and ignore non-package Cargo names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-workspace-"));
  try {
    write(dir, "crates/foo-bar/Cargo.toml", "[package]\nname = 'foo-bar'\n");
    write(dir, "crates/foo-bar/src/lib.rs", "use baz::local;\npub mod thing;\n");
    write(dir, "crates/foo-bar/src/thing.rs", "pub fn work() {}\n");
    write(
      dir,
      "crates/baz/Cargo.toml",
      "[[bin]]\nname = \"foo_bar\"\npath = \"src/main.rs\"\n\n[package]\nname = \"baz\"\n",
    );
    write(dir, "crates/baz/src/main.rs", "use foo_bar::thing;\nmod local;\nfn main() {}\n");
    write(dir, "crates/baz/src/local.rs", "pub fn local() {}\n");

    const graph = await buildFixture(dir);

    assert.ok(
      hasEdge(graph, "crates/baz/src/main.rs", "crates/foo-bar/src/thing.rs", "imports"),
      "hyphenated package name matches its underscored Rust path",
    );
    assert.ok(
      hasEdge(graph, "crates/foo-bar/src/lib.rs", "crates/baz/src/local.rs", "imports"),
      "the [[bin]] name does not shadow the [package] name",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rust typed members drop duplicate same-file trait implementations but keep a single candidate", () => {
  const singleExtract = extractFile(
    "single.rs",
    "struct Frame;\nimpl Frame { fn from() {} }\nfn use_frame() { Frame::from(); }\n",
    "rust",
  );
  const single = resolveEdges(singleExtract.nodes, singleExtract.rawEdges);
  assert.equal(single.find((edge) => edge.relation === "calls")?.target, "single.rs#Frame.from");

  const ambiguousExtract = extractFile(
    "frame.rs",
    [
      "trait First { fn from(); }",
      "trait Second { fn from(); }",
      "struct Frame;",
      "impl First for Frame { fn from() {} }",
      "impl Second for Frame { fn from() {} }",
      "fn use_frame() { Frame::from(); }",
      "",
    ].join("\n"),
    "rust",
  );
  assert.equal(
    ambiguousExtract.nodes.filter((candidate) => candidate.owner === "Frame" && candidate.name === "from").length,
    2,
  );
  const ambiguous = resolveEdges(ambiguousExtract.nodes, ambiguousExtract.rawEdges);
  assert.equal(ambiguous.filter((edge) => edge.relation === "calls").length, 0);
});

test("Rust trait default methods resolve through same-file impl heritage", () => {
  const { nodes, rawEdges } = extractFile(
    "frame.rs",
    "pub trait Paint { fn render(&self) {} }\npub struct Frame;\nimpl Paint for Frame {}\nfn use_frame() { Frame::render(); }\n",
    "rust",
  );
  const edges = resolveEdges(nodes, rawEdges);
  assert.ok(
    edges.some(
      (edge) =>
        edge.source === "frame.rs#use_frame" &&
        edge.target === "frame.rs#Paint.render" &&
        edge.relation === "calls",
    ),
  );

  const twoDefaults = extractFile(
    "ambiguous-default.rs",
    [
      "trait First { fn render(&self) {} }",
      "trait Second { fn render(&self) {} }",
      "struct Frame;",
      "impl First for Frame {}",
      "impl Second for Frame {}",
      "fn use_frame() { Frame::render(); }",
      "",
    ].join("\n"),
    "rust",
  );
  const ambiguous = resolveEdges(twoDefaults.nodes, twoDefaults.rawEdges);
  assert.equal(
    ambiguous.filter((edge) => edge.source === "ambiguous-default.rs#use_frame" && edge.relation === "calls").length,
    0,
    "two default methods at the same ancestor level are ambiguous",
  );
});

test("Rust and non-Rust bare-name resolution stay in separate global domains", () => {
  const nodes = [
    node("rust_def.rs", "file"),
    node("rust_def.rs#shared", "function"),
    node("python_def.py", "file"),
    node("python_def.py#shared", "function"),
    node("rust_call.rs", "file"),
    node("rust_call.rs#invoke", "function"),
    node("python_call.py", "file"),
    node("python_call.py#invoke", "function"),
  ];
  const edges = resolveEdges(nodes, [
    { source: "rust_call.rs#invoke", relation: "calls", name: "shared", file: "rust_call.rs", lang: "rust" },
    { source: "python_call.py#invoke", relation: "calls", name: "shared", file: "python_call.py" },
  ]);

  assert.ok(edges.some((edge) => edge.source === "rust_call.rs#invoke" && edge.target === "rust_def.rs#shared"));
  assert.ok(edges.some((edge) => edge.source === "python_call.py#invoke" && edge.target === "python_def.py#shared"));
  assert.ok(!edges.some((edge) => edge.source === "rust_call.rs#invoke" && edge.target.endsWith(".py#shared")));
  assert.ok(!edges.some((edge) => edge.source === "python_call.py#invoke" && edge.target.endsWith(".rs#shared")));
});

test("Rust macro calls use the bang namespace while ordinary format functions still resolve", () => {
  const { nodes, rawEdges } = extractFile(
    "macros.rs",
    "macro_rules! log_it { () => {} }\nfn format() {}\nfn invoke() { log_it!(); format(); }\n",
    "rust",
  );
  const edges = resolveEdges(nodes, rawEdges);
  assert.ok(edges.some((edge) => edge.source === "macros.rs#invoke" && edge.target === "macros.rs#log_it!"));
  assert.ok(edges.some((edge) => edge.source === "macros.rs#invoke" && edge.target === "macros.rs#format"));
});
