import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFileBm25Index,
  rankFileBm25,
  tokenizeFileBm25,
} from "../src/ask/file-bm25.js";

test("file BM25 tokenizer keeps complete identifiers and camel/snake parts", () => {
  assert.deepEqual(
    tokenizeFileBm25("validateRecord HTTPServer auth_token x"),
    ["validaterecord", "validate", "record", "httpserver", "http", "server", "auth_token", "auth", "token"],
  );
});

test("file BM25 ranks raw path plus source with binary query terms", () => {
  const index = buildFileBm25Index(new Map([
    ["src/records.ts", "export function validateRecord() { return true; }"],
    ["src/network.ts", "export function connectSocket() { return true; }"],
  ]));
  const once = rankFileBm25(index, "record validation validate");
  const repeated = rankFileBm25(index, "record record record validation validate");

  assert.equal(once[0]?.path, "src/records.ts");
  assert.deepEqual(
    repeated.map(({ path, score }) => ({ path, score })),
    once.map(({ path, score }) => ({ path, score })),
    "pasted repetition must not amplify a query term",
  );
  assert.equal(once[0]?.normalized, 1);
});

test("file BM25 recomputes corpus statistics after a prefix filter", () => {
  const index = buildFileBm25Index(new Map([
    ["api/auth.ts", "gateway authentication token"],
    ["api/router.ts", "gateway route"],
    ["ui/panel.ts", "gateway gateway gateway panel"],
  ]));
  const ranked = rankFileBm25(index, "authentication gateway", "api");

  assert.deepEqual(ranked.map((item) => item.path), ["api/auth.ts", "api/router.ts"]);
  assert.ok(ranked.every((item) => item.path.startsWith("api/")));
});
