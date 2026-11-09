/**
 * Child of the bounded-memory test (init-replay.test.ts): replays one big
 * synthetic transcript under a 300 MB heap cap and prints what it held.
 * Not a test file itself.
 */
import { statSync } from "node:fs";
import { JobMiner } from "../src/init/miners.js";
import { replaySession } from "../src/init/replay-runs.js";

const [path, repoKey, trail] = process.argv.slice(2) as [string, string, string];
const t0 = Date.now();
const r = replaySession(path, { from: 0, to: statSync(path).size }, repoKey, new Date("2026-12-01T00:00:00Z"), { env: { HOME: "/nonexistent", TRAIL_HOME: trail } });
const miner = new JobMiner().add(r);
const perJob: Record<string, number> = {};
for (const s of r.sheets) perJob[s.sheet.job ?? "none"] = (perJob[s.sheet.job ?? "none"] ?? 0) + 1;
process.stdout.write(JSON.stringify({
  ms: Date.now() - t0, runs: r.runs.length, stopped: r.stopped, perJob, held: miner.held(), typed: r.typed.length,
  heapMb: Math.round(process.memoryUsage().heapUsed / 1e6), rssMaxMb: Math.round(process.resourceUsage().maxRSS / 1024),
  days: miner.result().find((j) => j.job === "release")?.days.length ?? 0,
}));
