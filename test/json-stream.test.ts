import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachLine, openAtomic } from "../src/util/json-stream.js";

test("openAtomic: nothing is visible at the target until commit, and the temp file is gone after", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-atomic-"));
  const p = join(d, "sub", "out.json");
  const w = openAtomic(p);
  w.write("{\"a\":");
  assert.ok(!existsSync(p), "target absent before commit");
  w.write("1}\n");
  w.commit();
  assert.equal(readFileSync(p, "utf8"), "{\"a\":1}\n");
  assert.deepEqual(readdirSync(join(d, "sub")), ["out.json"], "no temp file left behind");
});

test("openAtomic: abort leaves no file", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-atomic-"));
  const p = join(d, "out.json");
  const w = openAtomic(p);
  w.write("partial");
  w.abort();
  assert.deepEqual(readdirSync(d), []);
});

test("openAtomic: a multi-megabyte chunk is written whole (short-write loop)", () => {
  const d = mkdtempSync(join(tmpdir(), "graft-atomic-"));
  const p = join(d, "big.txt");
  const chunk = "x".repeat(8 * 1024 * 1024) + "é\n"; // multibyte tail catches byte/char confusion
  const w = openAtomic(p);
  w.write(chunk);
  w.commit();
  assert.equal(readFileSync(p, "utf8"), chunk);
});

test("forEachLine: splits on newline, handles a missing trailing newline, and decodes UTF-8 per line", () => {
  const seen: [string, number][] = [];
  forEachLine(Buffer.from("a\n{\"k\":\"é\"}\n\nlast"), (l, i) => seen.push([l, i]));
  assert.deepEqual(seen, [["a", 0], ["{\"k\":\"é\"}", 1], ["", 2], ["last", 3]]);
});

test("forEachLine: an empty buffer yields nothing", () => {
  let n = 0;
  forEachLine(Buffer.alloc(0), () => n++);
  assert.equal(n, 0);
});
