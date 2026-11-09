/**
 * b5 review: the look-back's bounds (design 4.2, R36) on inputs the build
 * left out: thousands of preference-shaped lines, one session with 100,000
 * typed lines, and the time cap. Synthetic lines and sessions only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { minePreferences } from "../src/init/prefs.js";
import { replaySession } from "../src/init/replay-runs.js";
import { day, done, SHOP, Tx, world } from "./init-mine-fixtures.js";
import { timeBar } from "./machine-speed.js";

process.env.TZ = "UTC";

test("20,000 different preference-shaped lines cluster in bounded time, the newest kept", () => {
  const N = 20_000;
  const words = (i: number) => i.toString(36).split("").map((c) => `w${c}${i % 7}`).join(" ");
  const typed = Array.from({ length: N }, (_, i) => ({
    ref: { t: "/home/dev/.claude/projects/-home-dev-shop/s.jsonl", o: i * 100, s: "a".repeat(64) },
    day: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`,
    at: new Date(Date.UTC(2026, 8, 1 + (i % 28), 10, 0, i % 60)).toISOString(),
    text: `always use tool${i} with ${words(i)}`,
  }));
  // The newest line, said again on 2 days, is still found.
  typed.push({ ...typed[0]!, o: 1, day: "2026-09-29", at: "2026-09-29T10:00:00.000Z", text: "never squash the release commits" } as never);
  typed.push({ ...typed[0]!, o: 2, day: "2026-09-30", at: "2026-09-30T10:00:00.000Z", text: "never squash release commits" } as never);
  const t = Date.now();
  const found = minePreferences(typed);
  const ms = Date.now() - t;
  // 5 s where the bar was set, scaled to this machine, never under 15 s.
  assert.ok(ms < timeBar(5000, 15_000), `took ${ms} ms`);
  assert.ok(found.some((c) => c.shortest === "never squash release commits"));
});

test("one session with 100,000 typed lines stops at its time cap and says so", () => {
  const w = world("100k");
  try {
    const tx = new Tx(w.repo);
    for (let i = 0; i < 100_000; i++) tx.typed(day(1 + (i % 25), 10, i), i % 2 ? `keep the tool${i} wrapper small` : "ok go on");
    const path = tx.write(w.home, "s-100k");
    const t = Date.now();
    const r = replaySession(path, { from: 0, to: statSync(path).size }, SHOP, new Date(day(28)), { env: w.env, maxMs: 1500 });
    const ms = Date.now() - t;
    assert.equal(r.stopped, "time");
    // The 1.5 s cap, and what a slow machine adds around it.
    assert.ok(ms < 1500 + timeBar(4500, 13_500), `took ${ms} ms`);
  } finally {
    done(w);
  }
});

test("walls.json's read marks only a session read whole: an ancestor stretch or a replay cut short leaves the rest for later", async () => {
  const { mineWalls } = await import("../src/init/miners.js");
  const w = world("read-marks");
  try {
    const tx = new Tx(w.repo);
    for (let d = 1; d <= 4; d++) tx.typed(day(d), `publish 1.0.${d}`).bash(day(d, 10, 5), "npm run build", "built");
    const path = tx.write(w.home, "s-marks");
    const size = statSync(path).size;
    const whole = replaySession(path, { from: 0, to: size }, SHOP, new Date(day(9)), { env: w.env });
    assert.deepEqual(Object.keys(mineWalls([whole]).read ?? {}), [whole.sh], "read whole: marked");
    const cut = replaySession(path, { from: 0, to: size }, SHOP, new Date(day(9)), { env: w.env, maxRuns: 2 });
    assert.equal(cut.stopped, "runs");
    assert.deepEqual(mineWalls([cut]).read, {}, "stopped at the run cap: not marked");
    const part = replaySession(path, { from: 0, to: Math.floor(size / 2) }, SHOP, new Date(day(9)), { env: w.env });
    assert.deepEqual(mineWalls([part]).read, {}, "one repo's stretch of it: not marked, another repo's stretch is still to count");
  } finally {
    done(w);
  }
});
