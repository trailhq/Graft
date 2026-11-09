/**
 * How much slower this machine is than the one the timing bars were set on,
 * for tests that hold a parse or a hook to a few milliseconds. A shared CI
 * runner can be two or three times slower than a laptop; a regex that
 * backtracks is a thousand times slower. So a bar scaled by this factor still
 * catches the second and no longer fails on the first.
 *
 * The factor is a fixed CPU workload (regex scans and JSON over a few hundred
 * KB, the shape of work the timed code does) timed in this process, best of
 * several runs, against what it took where the bars were set. It is never
 * below 1, capped at 10, and exactly 1 under TRAIL_PERF=1 (the strict run).
 * Not a test file itself.
 *
 * Timed with `performance.now()`, the clock the tests use, not
 * `process.cpuUsage()`: on Windows CPU time moves in steps of about 15.6 ms,
 * so a 5 ms run reads as 0, the best of seven is 0, and a runner five times
 * slower than the laptop got a factor of 1.
 */

/** The workload's ms where the bars were set: an Apple M-series laptop on Node 25 (Node 20 there takes about 7). */
const REFERENCE_MS = 5;

let cached: number | null = null;

function workload(): number {
  const text = "token=abc def-ghi /var/x?key=1 ".repeat(8 * 1024);
  let n = 0;
  for (let i = 0; i < 4; i++) {
    n += (text.match(/[a-z]+=[\w-]+/g) ?? []).length;
    n += JSON.parse(JSON.stringify({ text, n })).text.length;
  }
  return n;
}

/** The workload's best ms here, after a warm-up run. */
export function workloadMs(): number {
  workload();
  let best = Infinity;
  for (let k = 0; k < 7; k++) {
    const t = performance.now();
    workload();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/** This machine's slowness against the bars' machine: 1 to 10. */
export function slowness(): number {
  if (process.env.TRAIL_PERF === "1") return 1;
  cached ??= Math.min(10, Math.max(1, workloadMs() / REFERENCE_MS));
  return cached;
}

/**
 * A timing bar for this machine: `ms` where it was set, times slowness(), and never under `floor`. The timing
 * tests catch the catastrophic (a backtracking regex, a lost index, O(n^2): ten times over or more), not a few
 * ms over on a busy shared runner, so a floor of 3 to 5 times the bar costs them nothing. Exactly `ms` under
 * TRAIL_PERF=1, the strict run.
 */
export function timeBar(ms: number, floor: number): number {
  if (process.env.TRAIL_PERF === "1") return ms;
  return Math.max(ms * slowness(), floor);
}
