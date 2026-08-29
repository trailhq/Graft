/**
 * Tests for `covers:` — the backlink written onto concept nodes from the wiring
 * graph. After a wiring build, each concept node's frontmatter should list the
 * symbols (with `path:span`) in the files it cites, and re-runs stay stable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import matter from "gray-matter";
import { buildContext } from "../src/context/build.js";
import { buildGraph } from "../src/graph/build.js";
import { fakeProviders } from "./helpers.js";

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-covers-"));
  writeFileSync(
    join(dir, "auth.ts"),
    `// [[Auth Service]] ==depends_on==> [[Token Store]]\n` +
      `export function login(user: string): boolean {\n  return user.length > 0;\n}\n`,
  );
  return dir;
}

test("wiring build backfills covers: onto concept nodes", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, { model: "fake", ...fakeProviders() });
    await buildGraph(dir); // $0, no LLM — still writes cards + covers

    const fm = matter(readFileSync(join(dir, "graft", "auth-service.md"), "utf8")).data;
    assert.ok(Array.isArray(fm.covers), "covers should be an array");
    const login = fm.covers.find((c: { symbol: string }) => c.symbol === "login");
    assert.ok(login, "covers should include the login function");
    assert.equal(login.kind, "function");
    assert.match(login.at, /^auth\.ts:L\d+-L\d+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patching covers preserves the node's body and other frontmatter", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, { model: "fake", ...fakeProviders() });
    const path = join(dir, "graft", "auth-service.md");
    const before = matter(readFileSync(path, "utf8"));
    await buildGraph(dir);
    const after = matter(readFileSync(path, "utf8"));

    // Body (Summary + Related + human notes) is untouched.
    assert.equal(after.content, before.content);
    // Existing frontmatter survives; only covers is added.
    assert.equal(after.data.slug, before.data.slug);
    assert.deepEqual(after.data.sources, before.data.sources);
    assert.deepEqual(after.data.links, before.data.links);
    assert.ok("covers" in after.data && !("covers" in before.data));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeCovers does not stamp covers onto a root-level file card (#261)", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, { model: "fake", ...fakeProviders() });
    await buildGraph(dir);
    const card = matter(readFileSync(join(dir, "graft", "auth.md"), "utf8"));
    assert.equal(card.data.slug, undefined, "file card has no concept slug");
    assert.ok(!("covers" in card.data), "file cards must not grow concept covers: []");
    assert.match(card.content.trimStart(), /^# auth\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-running the wiring build leaves covers byte-stable", async () => {
  const dir = makeFixture();
  try {
    await buildContext(dir, { model: "fake", ...fakeProviders() });
    await buildGraph(dir);
    const first = readFileSync(join(dir, "graft", "auth-service.md"), "utf8");
    await buildGraph(dir);
    const second = readFileSync(join(dir, "graft", "auth-service.md"), "utf8");
    assert.equal(second, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
