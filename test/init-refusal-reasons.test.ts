/**
 * fix-lab5 item 11: a job that qualified but whose runs all failed to compile says every run's reason, newest
 * first, not just the newest's. The 1b lab's ship job read "one-step" while its other run was refused for a
 * multi-line step, which hid the refusal that mattered. Synthetic transcripts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { buildCandidates } from "../src/init/candidates.js";
import { mineJobs, type JobFind } from "../src/init/miners.js";
import { replaySession } from "../src/init/replay-runs.js";
import type { WallsFile } from "../src/trace/wall-state.js";
import { day, done, releaseJob, SHOP, Tx, world, type World } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";
const NOW = new Date(day(20));
const EMPTY_WALLS: WallsFile = { v: 1, read: {}, classes: {} };

function jobsOf(w: World, tx: Tx): JobFind[] {
  const p = tx.write(w.home, "sess-0");
  return mineJobs([replaySession(p, { from: 0, to: statSync(p).size }, SHOP, NOW, { env: w.env })]);
}

test("no run compiles: the refusal names each run's reason, newest first, once each", () => {
  const w = world("reasons");
  try {
    const tx = new Tx(w.repo);
    releaseJob(tx, 1, "1.0.1", { failedFirst: true });
    // Day 3: the publish ran from a shell heredoc, a step over several lines.
    tx.typed(day(3, 10, 0), "publish 1.0.3");
    tx.bash(day(3, 10, 10), "npm run build", "built in 2.1s");
    tx.bash(day(3, 10, 15), "npm publish acme-cli-1.0.3.tgz", "Exit code 1\nnpm error code E403\nnpm error 403 Forbidden", { isError: true });
    tx.bash(day(3, 10, 20), "sh <<'EOF'\nnpm publish acme-cli-1.0.3.tgz --access public\nEOF", "+ acme-cli@1.0.3");
    tx.bash(day(3, 10, 30), "npm view acme-cli version", "1.0.3");
    tx.said(day(3, 10, 40), "Published 1.0.3.");
    // Day 5, the newest: the publish alone, then its check.
    tx.typed(day(5, 10, 0), "publish 1.0.5");
    tx.bash(day(5, 10, 20), "npm publish acme-cli-1.0.5.tgz --access public", "+ acme-cli@1.0.5");
    tx.bash(day(5, 10, 30), "npm view acme-cli version", "1.0.5");
    tx.said(day(5, 10, 40), "Published 1.0.5.");
    const rel = jobsOf(w, tx).find((j) => j.job === "release")!;
    const secret = (g: JobFind["good"][number]) => {
      const c = structuredClone(g);
      c.sheet.calls = c.sheet.calls.map((x) => (x.cmd?.startsWith("npm publish") ? { ...x, cmd: null, secret: "refused" as const } : x));
      return c;
    };
    assert.equal(rel.good.length, 3, "day 5, day 3, day 1: newest first");
    // Day 1's publish held a secret it couldn't name.
    const good = rel.good.map((g, n) => (n === 2 ? secret(g) : g));
    const skipped: Array<{ job: string; why: string; days?: number }> = [];
    const c = buildCandidates({
      jobs: [{ ...rel, good }], walls: EMPTY_WALLS, prefs: [], howtos: [], reviews: [], repoKey: SHOP,
      repoWords: new Set(), skills: true, closed: new Set(), closedV1: new Set(), kept: new Set(), deferred: new Set(), env: w.env, checkout: w.repo, skipped,
    }, NOW);
    assert.equal(c.some((x) => x.kind === "skill"), false);
    assert.deepEqual(skipped, [{ job: "release", why: "one-step, multi-line, secret", days: 3 }]);
  } finally {
    done(w);
  }
});
