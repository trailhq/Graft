/**
 * Days are the person's own: a day is a date where they live, not in UTC, and
 * one sitting is one occasion even when it crosses midnight. Counting UTC dates
 * made a restart at 4:55 pm and 5:05 pm in California two days, so a one-off
 * task restarted once passed the "typed on two different days" rule and
 * started ticked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayOf } from "../src/init/transcript.js";
import { discoverSessions } from "../src/init/sessions.js";
import { verify, type PastSession } from "../src/init/look-back.js";
import { tmpRepo } from "./helpers.js";

/** Run `fn` with the process in time zone `tz`, then put it back. */
function inZone<T>(tz: string, fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

test("a day is the local date: 4 pm and 8 pm in California are one day, though UTC has rolled over", () => {
  inZone("America/Los_Angeles", () => {
    assert.equal(dayOf("2026-09-05T23:00:00.000Z"), "2026-09-05");
    assert.equal(dayOf("2026-09-06T03:00:00.000Z"), "2026-09-05");
  });
  inZone("Asia/Kolkata", () => assert.equal(dayOf("2026-09-05T20:00:00.000Z"), "2026-09-06"));
  assert.equal(dayOf(undefined), "");
  assert.equal(dayOf("not a time"), "");
});

test("discovery counts local days: one California afternoon across UTC midnight is one session-day", () => {
  inZone("America/Los_Angeles", () => {
    const root = tmpRepo("days-discover");
    const home = join(root, "home");
    const repo = join(root, "api");
    mkdirSync(repo, { recursive: true });
    const dir = join(home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const typed = (at: string, content: string) => JSON.stringify({ type: "user", cwd: repo, timestamp: at, message: { role: "user", content } });
    writeFileSync(join(dir, "s1.jsonl"), [typed("2026-09-05T23:00:00.000Z", "start the migration"), typed("2026-09-06T03:00:00.000Z", "finish the migration")].join("\n") + "\n");
    const d = discoverSessions(repo, home);
    assert.equal(d.sessions.length, 1);
    assert.equal(d.sessionDays, 1);
    assert.equal(d.days, 1);
    assert.equal(d.from, "2026-09-05");
    assert.equal(d.to, "2026-09-05");
  });
});

const ask = "rename the config loader to load settings";
const one = (id: string, at: string, text = ask): PastSession => ({ id, at, prompts: [{ text, at }] });
const finding = (a: string, b: string) => [{ title: "Name it load settings", for: "you", body: "## Decided\n- x", evidence: [{ session: a, quote: ask }, { session: b, quote: ask }] }];

test("a restart across UTC midnight is one occasion where the person lives", () => {
  inZone("America/Los_Angeles", () => {
    const s = [one("aaaaaaaa-1", "2026-09-20T23:55:00.000Z"), one("bbbbbbbb-2", "2026-09-21T00:05:00.000Z")];
    assert.deepEqual(verify(finding("aaaaaaaa", "bbbbbbbb"), s), []);
  });
});

test("a restart across local midnight is one sitting, not two days; the next afternoon is a second day", () => {
  inZone("America/Los_Angeles", () => {
    // 11:55 pm and 12:05 am in California.
    const restart = [one("aaaaaaaa-1", "2026-09-20T06:55:00.000Z"), one("bbbbbbbb-2", "2026-09-20T07:05:00.000Z")];
    assert.deepEqual(verify(finding("aaaaaaaa", "bbbbbbbb"), restart), [], "ten minutes apart is one sitting");
    // 11:55 pm, then 2 pm the next day.
    const later = [one("aaaaaaaa-1", "2026-09-20T06:55:00.000Z"), one("cccccccc-3", "2026-09-20T21:00:00.000Z")];
    const kept = verify(finding("aaaaaaaa", "cccccccc"), later);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.days, 2);
    assert.equal(kept[0]!.last, "2026-09-20");
  });
});
