/**
 * D136 (2): `trail init`'s look-back reads sdk (`claude -p`) transcripts only where the hooks do (D99): a lab home
 * (`$HOME/.trail-lab`) with TRAIL_LAB_INTERACTIVE=1, never on the person's own Trail home. Either half alone, or
 * neither, still skips them as headless. Synthetic sessions only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSessions } from "../src/init/sessions.js";
import { replaySession, typedAt } from "../src/init/replay-runs.js";
import { scanTranscript } from "../src/init/transcript.js";
import { day, done, releaseJob, SHOP, Tx, world, type World } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";
const whole = (path: string) => ({ from: 0, to: statSync(path).size });

function sdkSession(w: World): string {
  const tx = new Tx(w.repo);
  for (const d of [1, 3, 5]) releaseJob(tx, d, `1.0.${d}`, { failedFirst: d < 5 });
  return tx.write(w.home, "sdk-lab", undefined, { entrypoint: "sdk-cli" });
}

const reads = (w: World, path: string, env: NodeJS.ProcessEnv) => {
  const d = discoverSessions(w.repo, w.home, new Date(day(9)), env);
  const r = replaySession(path, whole(path), SHOP, new Date(day(9)), { env });
  return {
    found: d.sessions.map((s) => s.id), skipped: (d.skipped ?? []).map((s) => s.why),
    headless: r.headless, sheets: r.sheets.length, typed: r.typed.length, scan: scanTranscript(path, undefined, env).headless,
  };
};

test("a lab home with the switch reads an sdk session: discovery keeps it, the replay gives its runs and typed lines", () => {
  const w = world("lab-sdk");
  try {
    const path = sdkSession(w);
    writeFileSync(join(w.home, ".trail-lab"), "");
    const got = reads(w, path, { ...w.env, TRAIL_LAB_INTERACTIVE: "1" });
    assert.deepEqual([got.found, got.skipped, got.headless, got.scan], [["sdk-lab"], [], false, false]);
    assert.equal(got.sheets, 3);
    assert.equal(got.typed, 3);
    // At keep, a typed line's pointer reads its words again under the same switch, and not without it.
    const lab = { ...w.env, TRAIL_LAB_INTERACTIVE: "1" };
    const ref = replaySession(path, whole(path), SHOP, new Date(day(9)), { env: lab }).typed[0]!.ref;
    assert.equal(typedAt(ref, lab), "publish 1.0.1");
    assert.equal(typedAt(ref, w.env), null);
  } finally {
    done(w);
  }
});

test("pinned: the switch without the lab marker, the marker without the switch, and neither all skip it as headless", () => {
  for (const [tag, marker, sw] of [["switch-only", false, true], ["marker-only", true, false], ["neither", false, false]] as const) {
    const w = world(`lab-sdk-${tag}`);
    try {
      const path = sdkSession(w);
      if (marker) writeFileSync(join(w.home, ".trail-lab"), "");
      const got = reads(w, path, sw ? { ...w.env, TRAIL_LAB_INTERACTIVE: "1" } : w.env);
      assert.deepEqual([got.found, got.skipped, got.headless, got.scan, got.sheets, got.typed], [[], ["headless"], true, true, 0, 0], tag);
    } finally {
      done(w);
    }
  }
});
