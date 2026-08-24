/**
 * `graft viz --export`: one self-contained file, which is what makes a per-PR
 * hosted view possible without a server.
 *
 * The three assertions that matter are all about the inlining, because each failure
 * mode ships a page that looks fine locally and is broken where it is published:
 *   - no absolute asset paths survive (`/app.js` resolves to the domain root, so a
 *     Pages subdirectory would 404 and show an empty viewer);
 *   - `$&` and friends in the minified bundle are NOT treated as replacement
 *     patterns — the first version of the exporter put the original `<script src>`
 *     tag back into the page that way;
 *   - `</script>` inside graph data cannot close the data element.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { exportViz } from "../src/viz/export.js";

const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="appbar"><div class="brand"><b>graft</b><span id="repoName"></span></div></header>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

function viewerDir(appJs = "console.log('app');"): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-viewer-"));
  writeFileSync(join(dir, "index.html"), VIEWER_HTML);
  writeFileSync(join(dir, "style.css"), ":root{--k-method:#3AA7C9}");
  writeFileSync(join(dir, "app.js"), appJs);
  return dir;
}

function contextDir(summary = "Alpha coordinates the show."): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ctx-"));
  writeFileSync(
    join(dir, "alpha.md"),
    `---
name: Alpha
slug: alpha
type: system
sources:
  - path: src/a.ts
    hash: abc123
links: []
---
<!-- context:generated:start -->
## Summary
${summary}
<!-- context:generated:end -->
`,
  );
  mkdirSync(join(dir, ".graph"), { recursive: true });
  writeFileSync(
    join(dir, ".graph", "wiring.json"),
    JSON.stringify({
      meta: { version: 1, nodeCount: 1, edgeCount: 0 },
      nodes: [{ id: "src/a.ts#go", name: "go", kind: "function", path: "src/a.ts", span: "L1-L3", signature: null, summary: null, crux: null }],
      edges: [],
    }),
  );
  return dir;
}

function out(): string {
  return mkdtempSync(join(tmpdir(), "graft-out-"));
}

test("viz export: one file, with both graphs and every asset inlined", () => {
  const res = exportViz({ contextDir: contextDir(), viewerDir: viewerDir(), outDir: out(), repoName: "demo", subtitle: "PR #7" });
  const page = readFileSync(res.file, "utf8");

  assert.equal(res.contextNodes, 1);
  assert.equal(res.codeNodes, 1);
  // Nothing may be left for a server to serve.
  assert.ok(!page.includes('href="/style.css"'), "the stylesheet link must be gone");
  assert.ok(!page.includes('src="/app.js"'), "the script src must be gone");
  assert.match(page, /<style>\n:root\{--k-method:#3AA7C9\}\n<\/style>/);
  assert.match(page, /window\.__GRAFT_DATA__ = \{/);
  // The subtitle is how a reader knows WHICH pull request they opened.
  assert.match(page, /"subtitle":"PR #7"/);
  assert.match(page, /"repoName":"demo"/);
});

test("viz export: opens on the tab that has content, not on an empty Context tab", () => {
  // A structural `graft build` writes wiring cards (no frontmatter) plus INDEX.md,
  // and a frontmatter-less file still assembles to one node named after itself — so
  // the Context tab the viewer starts on holds exactly one dot. Exporting from that
  // build used to publish precisely that, with the whole wiring graph hidden behind
  // an unadvertised tab.
  const sparse = exportViz({ contextDir: contextDir(), viewerDir: viewerDir(), outDir: out(), repoName: "demo" });
  assert.equal(sparse.contextNodes, 1);
  assert.equal(sparse.defaultTab, "code", "one node is not a graph — open on the code graph");
  assert.match(readFileSync(sparse.file, "utf8"), /"defaultTab":"code"/);

  // A real concept layer is the better landing place.
  const deep = contextDir();
  writeFileSync(join(deep, "beta.md"), "---\nname: Beta\nslug: beta\ntype: concept\nsources: []\nlinks: []\n---\n");
  const rich = exportViz({ contextDir: deep, viewerDir: viewerDir(), outDir: out(), repoName: "demo" });
  assert.equal(rich.defaultTab, "context");

  // And with no wiring graph there is nothing to switch to.
  const noCode = mkdtempSync(join(tmpdir(), "graft-ctx-"));
  writeFileSync(join(noCode, "alpha.md"), "---\nname: Alpha\nslug: alpha\ntype: system\nsources: []\nlinks: []\n---\n");
  const only = exportViz({ contextDir: noCode, viewerDir: viewerDir(), outDir: out(), repoName: "demo" });
  assert.equal(only.codeNodes, 0);
  assert.equal(only.defaultTab, "context");
});

test("viz export: a bundle containing $& is inlined verbatim, not re-substituted", () => {
  // esbuild output is full of `$&`-shaped sequences; as a replacement STRING they
  // expand to the matched text, which put `<script src="/app.js">` back in the page.
  const res = exportViz({
    contextDir: contextDir(),
    viewerDir: viewerDir('const re = "$&"; const other = "$\'" + "$`";'),
    outDir: out(),
    repoName: "demo",
  });
  const page = readFileSync(res.file, "utf8");

  assert.match(page, /const re = "\$&"/, "the bundle must survive byte for byte");
  assert.ok(!page.includes('src="/app.js"'), "no substitution may resurrect the asset tag");
});

test("viz export: graph data cannot close the script element it lives in", () => {
  const res = exportViz({
    contextDir: contextDir("A summary that ends with </script><img src=x> on purpose."),
    viewerDir: viewerDir(),
    outDir: out(),
    repoName: "demo",
  });
  const page = readFileSync(res.file, "utf8");

  assert.ok(!page.includes("</script><img"), "the closing tag must be escaped inside the data");
  // Escaping `<` alone is enough — `\u003c/script>` cannot be an end tag — and it
  // keeps the payload readable if anyone opens the file.
  assert.match(page, /\\u003c\/script>/, "< is escaped as a JSON unicode sequence");
});

test("viz export: refuses to write a page whose asset tags it did not rewrite", () => {
  const dir = viewerDir();
  writeFileSync(join(dir, "index.html"), '<html><head><link rel="stylesheet" href="/style.css"></head><body><script src="/app.js"></script></body></html>');

  assert.throws(
    () => exportViz({ contextDir: contextDir(), viewerDir: dir, outDir: out(), repoName: "demo" }),
    /no longer matches the asset tags/,
    "a silently un-inlined page 404s wherever it is published — fail loudly instead",
  );
});

test("viz export: asset-path text inside the assets does not fail a correct export", () => {
  // The guard used to inspect the assembled page, so a stylesheet comment or a
  // bundled string mentioning one of the tags failed an export that was fine.
  const dir = viewerDir('const doc = \'<script type="module" src="/app.js"></script>\';');
  writeFileSync(join(dir, "style.css"), '/* replaces <link rel="stylesheet" href="/style.css"> */ x{}');

  const res = exportViz({ contextDir: contextDir(), viewerDir: dir, outDir: out(), repoName: "demo" });
  const page = readFileSync(res.file, "utf8");
  assert.match(page, /replaces <link rel="stylesheet" href="\/style\.css">/, "the comment survives inlining");
  assert.match(page, /window\.__GRAFT_DATA__/, "and the export still happened");
});

test("viz export: tabs can be trimmed, and the payload goes with them", () => {
  const ctx = contextDir();
  const all = exportViz({ contextDir: ctx, viewerDir: viewerDir(), outDir: out(), repoName: "demo" });
  const one = exportViz({ contextDir: ctx, viewerDir: viewerDir(), outDir: out(), repoName: "demo", tabs: ["context"] });

  assert.deepEqual(one.tabs, ["context"]);
  assert.match(readFileSync(one.file, "utf8"), /"tabs":\["context"\]/, "the viewer is told which tabs to show");
  // The dropped tabs are the only readers of the wiring graph, so it must not be
  // embedded at all — that payload is most of a blast page's size.
  assert.equal(one.codeNodes, 0, "no code graph is read");
  assert.match(readFileSync(one.file, "utf8"), /codeGraph: null/);
  assert.ok(all.codeNodes > 0 && readFileSync(all.file, "utf8").length > readFileSync(one.file, "utf8").length);
});

test("viz --tabs: a bad tab name fails loudly rather than exporting a page missing a tab", () => {
  const run = (args: string[]): { status: number; stderr: string } => {
    try {
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", stdio: "pipe" });
      return { status: 0, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      return { status: e.status ?? 1, stderr: e.stderr ?? "" };
    }
  };

  const bad = run(["viz", ".", "--export", out(), "--tabs", "context,graph"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--tabs takes a comma-separated subset of context, code, outline — got "graph"/);
  assert.equal(run(["viz", ".", "--export", out(), "--tabs", ""]).status, 1, "an empty list is a mistake too");
});
