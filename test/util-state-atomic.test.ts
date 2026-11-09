/**
 * writeJsonAtomic's temp file (D85): its name is not one anyone can guess
 * (pid plus a random suffix), and it is opened new-only and never through a
 * link, so a link planted where the temp file would go is never written
 * through, and never renamed into the real file's place. Made-up folders
 * under the system temp dir only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/util/state.js";

function box(t: { after(fn: () => void): void }): { dir: string; outside: string } {
  const dir = mkdtempSync(join(tmpdir(), "atomic-json-"));
  const outside = mkdtempSync(join(tmpdir(), "atomic-json-outside-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  return { dir, outside };
}

test("a link planted at any plausible temp name is never written through, and the real file is a plain file", (t) => {
  if (process.platform === "win32") return t.skip("links need privileges on Windows");
  const { dir, outside } = box(t);
  const p = join(dir, "stats.json");
  const victim = join(outside, "victim.txt");
  writeFileSync(victim, "untouched\n");
  const names = [`${p}.${process.pid}.tmp`, `${p}.tmp`, `${p}.${process.pid}`, `${p}.${process.pid + 1}.tmp`, `${p}~`, `${p}.0.tmp`];
  for (const n of names) symlinkSync(victim, n);
  writeJsonAtomic(p, { n: 1 });
  writeJsonAtomic(p, { n: 2 }, true, 0o600);
  assert.equal(readFileSync(victim, "utf8"), "untouched\n", "the link's target is not written");
  assert.ok(!lstatSync(p).isSymbolicLink(), "the real file is not a planted link renamed into place");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { n: 2 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  for (const n of names) assert.ok(lstatSync(n).isSymbolicLink(), `the planted link is left as it was: ${n}`);
});

test("each write uses its own temp name and leaves none behind", (t) => {
  const { dir } = box(t);
  const p = join(dir, "build.json");
  for (let i = 0; i < 20; i++) writeJsonAtomic(p, { i });
  assert.deepEqual(readdirSync(dir), ["build.json"]);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { i: 19 });
});

test("the temp name is not the predictable `<file>.<pid>.tmp`", (t) => {
  const { dir } = box(t);
  const p = join(dir, "lock.json");
  // A folder at the old name: the old code wrote into it and failed; the new one never touches that name.
  mkdirSync(`${p}.${process.pid}.tmp`);
  writeJsonAtomic(p, { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { ok: true });
});
