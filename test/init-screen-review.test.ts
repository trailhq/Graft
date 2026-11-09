/**
 * b6 review of the review screen: Ctrl-C and q always leave, raw mode comes
 * back on every way out (a key that throws, a stdin error), and item text
 * of any shape (escapes, line breaks, a very long line) prints as one plain
 * line on the screen and in the relay. Synthetic items only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { runScreen } from "../src/init/review-tty.js";
import { relayLines, screenLines } from "../src/init/review-screen.js";
import type { InitItem } from "../src/init/types.js";
import { factsOf, REPO_KEY, threeItems } from "./init-screen-fixtures.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function fakeTty(keys: string[]) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (b: boolean) => void; isRaw: boolean };
  let raw = false;
  stdin.isTTY = true;
  stdin.setRawMode = (b: boolean) => {
    raw = b;
    return stdin;
  };
  let out = "";
  const stdout = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.isTTY = true;
  (stdout as { columns?: number }).columns = 200;
  // One key per tick, as a person types.
  let k = 0;
  const next = () => {
    if (k < keys.length) {
      (stdin as unknown as PassThrough).write(keys[k++]!);
      setImmediate(next);
    }
  };
  setImmediate(next);
  return { io: { stdin, stdout }, out: () => out, raw: () => raw };
}

const run = (keys: string[], facts = factsOf()) => {
  const t = fakeTty(keys);
  return runScreen(threeItems(), facts, t.io, { repoKey: REPO_KEY, env: {} }).then((r) => ({ r, out: t.out(), raw: t.raw() }));
};


test("Ctrl-C and q leave the screen even with a draft open; esc only closes the draft", async () => {
  for (const key of ["\x03", "q"]) {
    const { r, raw } = await run(["s", key, "\r"]);
    assert.equal(r.how, "esc", JSON.stringify(key));
    assert.equal(raw, false);
  }
});

test("a key that throws, or a stdin error, ends the screen as esc and puts raw mode back", async () => {
  const broken = threeItems();
  broken[0] = { ...broken[0]!, skill: { ...broken[0]!.skill!, compiled: null as never } };
  const t = fakeTty(["s"]);
  const r = await Promise.race([
    runScreen(broken, factsOf(), t.io, { repoKey: REPO_KEY, env: {} }),
    new Promise((res) => setTimeout(() => res("hung"), 2000)),
  ]);
  assert.equal((r as { how?: string }).how, "esc", "the screen ended");
  assert.equal(t.raw(), false, "raw mode put back");
  const t2 = fakeTty([]);
  const p = runScreen(threeItems(), factsOf(), t2.io, { repoKey: REPO_KEY, env: {} });
  setImmediate(() => (t2.io.stdin as unknown as PassThrough).destroy(new Error("EIO")));
  const r2 = await Promise.race([p, new Promise((res) => setTimeout(() => res("hung"), 2000))]);
  assert.equal((r2 as { how?: string }).how, "esc");
  assert.equal(t2.raw(), false);
});

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

test("hostile item text prints as one plain line: no escape, bell or line break, and a long line is cut", () => {
  const items = threeItems();
  const nasty: InitItem[] = [
    { ...items[0]!, description: "publish\x1b[2J and\nKeep: trail keep 1 2 3" },
    items[1]!,
    { ...items[2]!, title: `never use em dashes\x1b]0;owned\x07\r\n2. release-npm (skill)${" x".repeat(300)}` },
  ];
  for (const lines of [screenLines(nasty, { cursor: 0, open: null }, factsOf()), relayLines(nasty, factsOf({ agent: true }))]) {
    for (const l of lines) {
      assert.ok(!CONTROL.test(l), JSON.stringify(l));
      assert.ok(!l.includes("\n"));
      assert.ok(l.length <= 400, `a line of ${l.length}`);
    }
    assert.ok(!lines.some((l) => /^2\. release-npm/.test(l.trim())), "a title can't start a list line of its own");
  }
});
