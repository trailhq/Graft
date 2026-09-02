/**
 * The wired-up version of `./upkeep.ts` — one call every entry point makes.
 *
 * Split from `upkeep.ts` so that module stays pure and unit-testable (no init
 * writes, no spawning): this file is the only place that knows how to actually
 * re-run the wiring, and it is deliberately thin.
 */
import { runInit } from './claude/init.js';
import { runHostsInit } from './hosts/init.js';
import { graftCliPath } from './claude/paths.js';
import {
  formatUpdateNudge,
  formatWiringRefresh,
  maybeRefreshInBackground,
  readUpdateCache,
  reconcileWiring,
  type WiringOpts,
} from './upkeep.js';

export interface UpkeepResult {
  /** Lines worth showing the agent/user, already formatted. Usually empty. */
  lines: string[];
}

/**
 * Re-write the wiring for exactly the hosts a previous `init` chose here, with
 * exactly the flags it was given.
 *
 * `build: false` matters: this runs at session start and at MCP boot, and a graph
 * build there would stall the agent's first turn.
 *
 * The out-of-repo writes (`~/.codex/hooks.json`, `~/.codex/config.toml`) ARE
 * included, because nothing else would ever refresh them: no skill, rule file, or
 * MCP instruction tells an agent to run `graft init`, so leaving them out means a
 * Codex user upgrades the binary and keeps the old hook config forever. They're
 * safe to replay — `installCodexHooks` no-ops when `~/.codex` is absent, rewrites
 * only its own entry (matched on `graft-hooks.cjs`), and reports `unchanged` when
 * the bytes match. A user who declined them at init time is honoured via
 * `opts.global`/`opts.hooks`, replayed from the stamp.
 */
function rewriteWiring(repo: string, hosts: string[], opts: WiringOpts): void {
  // `opts.global` reaches the claude layer for the same reason `opts.statusline` does:
  // its `~/.claude` writes (hosts/claude-global.ts) are out-of-repo, and a user who
  // declined those at init time must keep declining them on every replay.
  if (hosts.includes('claude'))
    runInit(repo, { build: false, cliPath: graftCliPath(), mcp: opts.mcp, hooks: opts.hooks, statusline: opts.statusline, global: opts.global });
  const others = hosts.filter((h) => h !== 'claude');
  if (others.length)
    runHostsInit(repo, { agents: others, global: opts.global, mcp: opts.mcp, hooks: opts.hooks });
}

/**
 * @param repo    the project dir
 * @param current the running graft's version
 * @param opts.background  false in hook contexts: read the update cache, never
 *   spawn a fetch. Hooks run under a hard timeout and must stay off the network.
 */
export function runUpkeep(
  repo: string,
  current: string,
  opts: { background?: boolean; home?: string } = {},
): UpkeepResult {
  const lines: string[] = [];
  try {
    const refreshed = reconcileWiring(repo, current, { rewrite: rewriteWiring });
    const refreshLine = formatWiringRefresh(refreshed);
    if (refreshLine) lines.push(refreshLine);
  } catch { /* fail-soft: wiring refresh is never worth breaking a session for */ }
  try {
    if (opts.background !== false) maybeRefreshInBackground(opts.home);
    const nudge = formatUpdateNudge(current, readUpdateCache(opts.home)?.latest);
    if (nudge) lines.push(nudge);
  } catch { /* same */ }
  return { lines };
}
