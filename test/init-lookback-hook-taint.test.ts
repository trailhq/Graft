/**
 * D135 (1): in init's look-back only, a Trail hook script run by hand taints just its own turn (up to the next typed
 * line), not the rest of the session. A write to Trail's files still taints the rest, and the live path keeps 1a's
 * session-wide mark. The 1b lab's release job lost all 16 days to two sessions that once ran a hook by hand.
 * Synthetic transcripts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileInitSkill, recompileInitSkill, replaySession } from "../src/init/replay-runs.js";
import { ask, bash, session } from "./trace-run-fixtures.js";
import { day, done, releaseJob, SHOP, Tx, world } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";
const whole = (path: string) => ({ from: 0, to: statSync(path).size });
const HOOK = (trail: string) => `echo '{}' | node ${trail}/bin/trail-hooks.cjs stop`;
const versions = (r: ReturnType<typeof replaySession>) => r.sheets.map((x) => x.sheet.promptParams.version);

test("look-back: a hook run by hand taints its own turn's run only; later runs keep their sheets and compile at keep", () => {
  const w = world("hook-turn");
  try {
    const tx = new Tx(w.repo);
    releaseJob(tx, 1, "1.0.1");
    tx.typed(day(2), "see what the stop hook says").bash(day(2, 10, 5), HOOK(w.trail), "{}");
    releaseJob(tx, 3, "1.0.3");
    // Day 4: the hook by hand in the same turn as the release, before its steps.
    tx.typed(day(4), "publish 1.0.4").bash(day(4, 10, 5), HOOK(w.trail), "{}");
    tx.bash(day(4, 10, 10), "npm run build", "built in 2.1s");
    tx.bash(day(4, 10, 20), "npm publish acme-cli-1.0.4.tgz --access public", "+ acme-cli@1.0.4");
    tx.bash(day(4, 10, 30), "npm view acme-cli version", "1.0.4");
    tx.said(day(4, 10, 40), "Published 1.0.4.");
    releaseJob(tx, 5, "1.0.5");
    const path = tx.write(w.home, "s-hook");
    const now = new Date(day(9));
    const r = replaySession(path, whole(path), SHOP, now, { env: w.env });
    assert.deepEqual(versions(r), ["1.0.1", "1.0.3", "1.0.5"], "day 4's run shared the hook's turn; day 3 and day 5 did not");
    // At keep, the run after the hook turns compiles again from its stored range.
    const [, p3, n5] = r.sheets;
    const c = compileInitSkill(n5!, p3!, SHOP, w.env, now);
    if (!c.ok) assert.fail(`day 5 compiles: ${c.why}`);
    const st = statSync(path);
    const src = { t: path, size: st.size, mtimeMs: st.mtimeMs, run: n5!.src, prior: { t: path, ...p3!.src }, skillSha: c.skillSha };
    assert.equal(recompileInitSkill(src, SHOP, w.env, now).ok, true, "a hook run in an earlier turn doesn't refuse it at keep");
  } finally {
    done(w);
  }
});

test("look-back: a write to Trail's files still taints the rest of the session, hook turn or not", () => {
  const w = world("hook-write");
  try {
    const tx = new Tx(w.repo);
    releaseJob(tx, 1, "1.0.1");
    tx.typed(day(2), "see what the stop hook says").bash(day(2, 10, 5), HOOK(w.trail), "{}");
    releaseJob(tx, 3, "1.0.3");
    tx.typed(day(4), "tweak the settings").tool(day(4, 10, 1), "Edit", { file_path: join(w.trail, "settings.json"), old_string: "a", new_string: "b" });
    releaseJob(tx, 5, "1.0.5");
    const path = tx.write(w.home, "s-write");
    assert.deepEqual(versions(replaySession(path, whole(path), SHOP, new Date(day(9)), { env: w.env })), ["1.0.1", "1.0.3"]);
  } finally {
    done(w);
  }
});

test("look-back: a write in the same turn after a hook run still taints the rest of the session", () => {
  const w = world("hook-then-write");
  try {
    const tx = new Tx(w.repo);
    releaseJob(tx, 1, "1.0.1");
    tx.typed(day(2), "see what the stop hook says").bash(day(2, 10, 5), HOOK(w.trail), "{}")
      .tool(day(2, 10, 9), "Edit", { file_path: join(w.trail, "settings.json"), old_string: "a", new_string: "b" });
    releaseJob(tx, 3, "1.0.3");
    const path = tx.write(w.home, "s-hook-write");
    assert.deepEqual(versions(replaySession(path, whole(path), SHOP, new Date(day(9)), { env: w.env })), ["1.0.1"]);
  } finally {
    done(w);
  }
});

test("live path unchanged: a hook run by hand marks the whole session, through later typed turns and runs", () => {
  const s = session("hook-live");
  try {
    s.fold([ask("see what the stop hook says", 0), ...bash("echo '{}' | node /home/dev/.trail/bin/trail-hooks.cjs stop", "{}", { sec: 5, cwd: "/home/dev/shop" })]);
    assert.equal(s.st.tampered, "Bash trail-hooks.cjs");
    s.fold([
      ask("run the test suite", 60),
      ...bash("npm test", "Tests: 12 passed, 12 total", { sec: 70, cwd: "/home/dev/shop" }),
      ask("now publish it", 120),
      ...bash("npm publish acme-cli-1.0.6.tgz --access public", "+ acme-cli@1.0.6", { sec: 130, cwd: "/home/dev/shop" }),
    ]);
    assert.equal(s.st.tampered, "Bash trail-hooks.cjs", "still marked two typed turns later");
  } finally {
    rmSync(dirname(s.path), { recursive: true, force: true });
  }
});
