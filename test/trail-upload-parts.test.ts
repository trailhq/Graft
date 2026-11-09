/** A big set of learnings (skills bring their folders) goes up in parts, each under the request limit. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND_ENV } from "../src/brand.js";
import { uploadLearnings, UPLOAD_PART_BYTES, type Cloud, type UploadedLearning } from "../src/cloud/workspace.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";

const cloud = { url: "http://trail.test", token: "t", repos: [] } as unknown as Cloud;
const item = (n: number, size: number): UploadedLearning => ({ path: `.claude/skills/s${n}/SKILL.md`, kind: "skill", ref: "", title: `S${n}`, author: "", date: "", touches: [], body: "x".repeat(size), hash: `h${n}` });

test("an upload past one part's size goes up in parts, adding up what each added", async () => {
  const sizes: number[] = [];
  const f = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { learnings: unknown[] };
    sizes.push(String(init!.body).length);
    return new Response(JSON.stringify({ repo: "r", learnings: 9, added: body.learnings.length }), { status: 200 });
  }) as typeof fetch;
  const big = Math.floor(UPLOAD_PART_BYTES * 0.6);
  const res = await uploadLearnings(cloud, { repo: { key: "github.com/a/b", name: "a/b" }, learnings: [item(1, big), item(2, big), item(3, 10)] }, f);
  assert.equal(sizes.length, 2);
  assert.ok(sizes.every((s) => s < UPLOAD_PART_BYTES * 1.3));
  assert.deepEqual(res, { repo: "r", learnings: 9, added: 3 });
});

test("a small upload is one request", async () => {
  let calls = 0;
  const f = (async () => (calls++, new Response(JSON.stringify({ repo: "r", learnings: 1, added: 1 }), { status: 200 }))) as typeof fetch;
  await uploadLearnings(cloud, { repo: { key: "github.com/a/b", name: "a/b" }, learnings: [item(1, 10)] }, f);
  assert.equal(calls, 1);
});
