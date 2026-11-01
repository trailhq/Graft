/**
 * windowsHide option for child_process calls.
 * Spread into execFileSync / spawnSync options to suppress CMD windows on Windows.
 *
 * Usage: execFileSync("git", args, { encoding: "utf8", ...WINHIDE, ... })
 *
 * On Linux/macOS this is an empty object — no effect.
 * On Windows this adds windowsHide: true to every child_process call,
 * preventing the 100+ CMD flashes that appear during `trail init` on a
 * workspace with many repos (each git/gh call was opening a console window).
 */
export const WINHIDE = process.platform === "win32"
  ? { windowsHide: true as const }
  : {} as { windowsHide?: true };
