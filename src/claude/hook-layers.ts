/**
 * Which copy of the hooks answers an event when both are registered.
 *
 * `init` wires Claude Code twice: in the repo (`.claude/settings.json`, committed
 * for teammates) and in `~/.claude` (the floor for worktrees and ignored files,
 * see hosts/claude-global.ts). Claude Code runs both, so every prompt got its
 * learnings twice and the ask to save one came twice in a session. The
 * `~/.claude` copy runs in every folder, trusted or not, so when it covers an
 * event the repo's copy stands down for it.
 *
 * Only a `~/.claude` shim that can find trail counts: one an older graft wrote
 * looks for `@nanonets/graft` alone, and standing down for it would leave a
 * trail-only machine with no hooks at all. The next session start rewrites it.
 *
 * Who sent the payload decides first. Claude Code runs both copies, and so
 * does Cursor (it loads ~/.claude/settings.json beside the repo's). Copilot
 * CLI reads only the repo's settings, so under it, and under any payload no
 * host claims, the repo copy answers: twice is better than never.
 *
 * Reads two small files and imports nothing heavier than node:fs, since every
 * hook loads it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PACKAGE_FOR } from "../brand.js";
import { detectHost, type Host } from "../trace/host.js";

/** Hosts that run the ~/.claude copy as well as the repo's. */
const RUNS_GLOBAL_COPY: ReadonlySet<Host> = new Set<Host>(["claude", "cursor"]);

/** `node "<shim>" <event>`, the form hosts/claude-global.ts writes, with the
 * `|| exit 0` PreToolUse carries (settings-merge.ts failOpen). */
const COMMAND = /^node\s+"([^"]+)"\s+(\S+)(?:\s+\|\|\s+exit\s+0)?$/;

/**
 * True when this hook process runs from the repo's shim and the `~/.claude`
 * copy also answers `event`, so this one should do nothing.
 *
 * `shim` is the path the hook was started from (`process.argv[1]`). `payload`
 * is the hook's stdin, when the caller has it: a host that doesn't run the
 * ~/.claude copy never stands down.
 */
export function globalCopyCovers(event: string, shim: string | undefined, home: string = homedir(), env: NodeJS.ProcessEnv = process.env, payload?: unknown): boolean {
  if (!shim) return false;
  if (payload !== undefined && !RUNS_GLOBAL_COPY.has(detectHost(payload).host)) return false;
  // Claude Code reads its user settings from CLAUDE_CONFIG_DIR when that is
  // set, and then never runs the ~/.claude copy: this one has to answer.
  if (env.CLAUDE_CONFIG_DIR && resolve(env.CLAUDE_CONFIG_DIR) !== resolve(home, ".claude")) return false;
  const at = resolve(dirname(shim));
  // Only Claude Code's repo copy, in `.claude/helpers/` or trail's `.trail/`:
  // Cursor's and Codex's shims call the same entry, and Claude's ~/.claude
  // hooks never run for them.
  const repoCopy = basename(at) === ".trail" || (basename(at) === "helpers" && basename(dirname(at)) === ".claude");
  if (!repoCopy) return false;
  const helpers = resolve(home, ".claude", "helpers");
  if (at === helpers) return false; // this is the ~/.claude copy
  let settings: { hooks?: Record<string, unknown> };
  try {
    settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  } catch {
    return false;
  }
  for (const groups of Object.values(settings?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of (group as { hooks?: Array<{ command?: unknown }> })?.hooks ?? []) {
        const m = typeof hook?.command === "string" ? COMMAND.exec(hook.command.trim()) : null;
        if (!m || m[2] !== event || resolve(dirname(m[1]!)) !== helpers) continue;
        if (findsTrail(m[1]!)) return true;
      }
    }
  }
  return false;
}

/** The shim exists and is one that looks for the trail package. */
function findsTrail(shim: string): boolean {
  try {
    return existsSync(shim) && readFileSync(shim, "utf8").includes(PACKAGE_FOR.trail);
  } catch {
    return false;
  }
}
