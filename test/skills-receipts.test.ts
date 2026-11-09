/**
 * Receipts (design 2.7, 4.9): the PreToolUse save gate writes one per session,
 * and the CLI acts on it once. A receipt is found only for its run and name,
 * while fresh, and never after it was used. `lineAt` is the one positioned read
 * the gate makes of the transcript: the line that starts at a byte offset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReceipt, lineAt, lineSha, linesBefore, markReceiptUsed, receiptPath, typedLineStillThere, writeReceipt } from "../src/skills/receipts.js";
import type { Receipt } from "../src/skills/types.js";

const POSIX = process.platform !== "win32";
const NOW = new Date("2026-10-27T10:45:18.000Z");

function home(tag: string): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), `skills-receipts-${tag}-`));
  return { HOME: dir, TRAIL_HOME: join(dir, "trail-home") };
}

function receipt(extra: Partial<Receipt> = {}): Receipt {
  return {
    v: 1, session: "e76b4ca7-5b1d-4c7e-9f0a-2d1e3c4b5a69", transcriptPath: "/home/dev/.claude/projects/-home-dev-shop/e76b4ca7.jsonl",
    toolUseId: "toolu_01XyZ", runId: "r-1027-3f9a", name: "ship-beta-then-prod", at: NOW.toISOString(), host: "claude", tier: "A",
    consent: "offer-yes", offerId: "o-81c2aa", typed: { offset: 1200, lineSha: "4d2f" }, typedYes: true, typedSave: false, asked: null,
    stepsTotal: 5, stepsVerified: 5, verdict: "live", usedAt: null, ...extra,
  };
}

const later = (ms: number) => new Date(NOW.getTime() + ms);

test("one receipt per session, 0600 in a 0700 folder, replaced by the next one", { skip: !POSIX && "posix modes" }, () => {
  const env = home("write");
  writeReceipt(receipt(), env);
  const path = receiptPath(receipt().session, env);
  assert.equal(path, join(env.TRAIL_HOME!, "receipts", `${receipt().session}.json`));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(env.TRAIL_HOME!, "receipts")).mode & 0o777, 0o700);
  writeReceipt(receipt({ toolUseId: "toolu_02", name: "release-npm" }), env);
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as Receipt;
  assert.equal(onDisk.toolUseId, "toolu_02");
  assert.equal(findReceipt("r-1027-3f9a", "ship-beta-then-prod", NOW, env), null, "the older receipt is gone");
  assert.equal(findReceipt("r-1027-3f9a", "release-npm", NOW, env)?.toolUseId, "toolu_02");
});

test("a session id that is not a plain file name never points outside the folder", () => {
  const env = home("id");
  const path = receiptPath("../../etc/passwd", env);
  assert.equal(join(path, ".."), join(env.TRAIL_HOME!, "receipts"));
  assert.match(path, /[\\/]h-[0-9a-f]{16}\.json$/);
});

test("found only for its run and name, unused, at most 10 minutes old and not more than 5 s ahead", () => {
  const env = home("find");
  writeReceipt(receipt(), env);
  const find = (runId: string, name: string, now: Date) => findReceipt(runId, name, now, env);
  assert.equal(find("r-1027-3f9a", "ship-beta-then-prod", NOW)?.toolUseId, "toolu_01XyZ");
  assert.equal(find("r-1027-0000", "ship-beta-then-prod", NOW), null, "another run");
  assert.equal(find("r-1027-3f9a", "ship-it", NOW), null, "another name");
  assert.ok(find("r-1027-3f9a", "ship-beta-then-prod", later(10 * 60_000)), "10 minutes old is fresh");
  assert.equal(find("r-1027-3f9a", "ship-beta-then-prod", later(10 * 60_000 + 1)), null, "stale");
  assert.ok(find("r-1027-3f9a", "ship-beta-then-prod", later(-5000)), "5 s ahead is clock skew");
  assert.equal(find("r-1027-3f9a", "ship-beta-then-prod", later(-5001)), null, "from the future");
});

test("a used receipt never counts again; marking it leaves a newer receipt alone", () => {
  const env = home("used");
  const r = receipt();
  writeReceipt(r, env);
  markReceiptUsed(r, later(1000), env);
  assert.equal(findReceipt(r.runId, r.name, later(2000), env), null);
  const onDisk = JSON.parse(readFileSync(receiptPath(r.session, env), "utf8")) as Receipt;
  assert.equal(onDisk.usedAt, later(1000).toISOString());
  // A newer add in the same session replaced it: marking the old one must not spend the new one.
  const fresh = receipt({ toolUseId: "toolu_09", at: later(3000).toISOString() });
  writeReceipt(fresh, env);
  markReceiptUsed(r, later(4000), env);
  assert.equal(findReceipt(fresh.runId, fresh.name, later(5000), env)?.toolUseId, "toolu_09");
});

test("only regular receipt files Trail wrote are read: links, bad JSON and wrong shapes are skipped", { skip: !POSIX && "posix links" }, () => {
  const env = home("shape");
  const dir = join(env.TRAIL_HOME!, "receipts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bad.json"), "{not json");
  writeFileSync(join(dir, "shape.json"), JSON.stringify({ ...receipt(), usedAt: undefined, verdict: "maybe" }));
  const outside = join(env.HOME!, "planted.json");
  writeFileSync(outside, JSON.stringify(receipt()));
  symlinkSync(outside, join(dir, "linked.json"));
  assert.equal(findReceipt("r-1027-3f9a", "ship-beta-then-prod", NOW, env), null);
  assert.equal(findReceipt("r-1027-3f9a", "ship-beta-then-prod", NOW, home("none")), null, "no folder at all");
});

function transcript(lines: string[], tail = "\n"): { path: string; offsets: number[] } {
  const dir = mkdtempSync(join(tmpdir(), "skills-receipts-tx-"));
  const path = join(dir, "s.jsonl");
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += Buffer.byteLength(l) + 1;
  }
  writeFileSync(path, lines.join("\n") + tail);
  return { path, offsets };
}

test("lineAt reads the line that starts at the offset, and nothing else", () => {
  const lines = ['{"a":1}', '{"b":"café → ok"}', '{"c":3}'];
  const { path, offsets } = transcript(lines);
  assert.deepEqual(offsets.map((o) => lineAt(path, o)), lines);
  assert.equal(lineAt(path, offsets[1]! + 1), null, "an offset inside a line is not a line start");
  assert.equal(lineAt(path, offsets[2]! + Buffer.byteLength(lines[2]!) + 1), null, "past the end");
  assert.equal(lineAt(path, -1), null);
  assert.equal(lineAt(path, 1.5), null);
  assert.equal(lineAt(join(path, "..", "missing.jsonl"), 0), null, "unreadable");
  const open = transcript(['{"a":1}', '{"half":'], "");
  assert.equal(lineAt(open.path, open.offsets[1]!), null, "a line still being written has no newline");
  assert.equal(lineAt(path, offsets[1]!, 8), null, "longer than maxBytes");
  assert.equal(lineAt(path, offsets[0]!, 8), lines[0], "a line of exactly maxBytes with its newline fits");
});

test("linesBefore reads the whole lines that end right before a line start, oldest first", () => {
  const lines = ['{"a":1}', '{"b":"café → ok"}', '{"c":3}'];
  const { path, offsets } = transcript(lines);
  assert.deepEqual(linesBefore(path, offsets[2]!), lines.slice(0, 2));
  assert.deepEqual(linesBefore(path, offsets[1]!), lines.slice(0, 1));
  assert.deepEqual(linesBefore(path, 0), [], "nothing before the first line");
  assert.deepEqual(linesBefore(path, offsets[2]! + 1), [], "an offset inside a line is not a line start");
  assert.deepEqual(linesBefore(path, offsets[2]!, Buffer.byteLength(lines[1]!) + 3), [lines[1]], "a line the window cuts is left out");
  assert.deepEqual(linesBefore(join(path, "..", "missing.jsonl"), 8), [], "unreadable");
  assert.deepEqual(linesBefore(path, 10_000), [], "past the end");
});

test("lineSha hashes the whole line; typedLineStillThere needs the same bytes at the same offset", () => {
  const lines = ['{"type":"user","message":{"content":"yes"}}', '{"type":"assistant"}'];
  const { path, offsets } = transcript(lines);
  assert.match(lineSha(lines[0]!), /^[0-9a-f]{64}$/);
  assert.notEqual(lineSha(lines[0]!), lineSha(lines[0]! + " "));
  assert.equal(typedLineStillThere(path, { offset: offsets[0]!, lineSha: lineSha(lines[0]!) }), true);
  assert.equal(typedLineStillThere(path, { offset: offsets[1]!, lineSha: lineSha(lines[0]!) }), false);
  writeFileSync(path, lines.map((l) => l.replace("yes", "yep")).join("\n") + "\n");
  assert.equal(typedLineStillThere(path, { offset: offsets[0]!, lineSha: lineSha(lines[0]!) }), false, "rewritten in place");
});
