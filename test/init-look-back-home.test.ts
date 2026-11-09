/**
 * The look-back's mark (`past-sessions.json`) lives in the Trail home it was
 * given, never the one in process.env: `trail keep` and `trail init` pass
 * theirs, so a test home never reaches the person's (b7, found by the b6
 * review). Made-up folders only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lookBackDue, markLookedBack } from "../src/init/look-back.js";
import { tmpRepo } from "./helpers.js";

test("markLookedBack and lookBackDue read and write the mark under the env's TRAIL_HOME", () => {
  const root = tmpRepo("b7-lookback-home");
  const outside = join(root, "process-home");
  const was = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = outside;
  try {
    const env = { HOME: join(root, "home"), TRAIL_HOME: join(root, "trail-home"), PATH: process.env.PATH };
    mkdirSync(env.TRAIL_HOME, { recursive: true });
    const dir = join(root, "work", "shop");
    mkdirSync(dir, { recursive: true });
    assert.equal(lookBackDue(dir, env), true);
    markLookedBack(dir, new Date("2026-10-17T10:00:00Z"), env);
    assert.equal(lookBackDue(dir, env), false);
    assert.equal(existsSync(outside), false, "nothing under process.env's Trail home");
  } finally {
    if (was === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = was;
    rmSync(root, { recursive: true, force: true });
  }
});
