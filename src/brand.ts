/**
 * Which name this process was started under: `trail`, or `graft`, the name it
 * had before.
 *
 * Both names run the same code. `trail` gets the new command layout and says
 * `[trail]`; `graft` keeps every old command, meaning and output byte for byte,
 * because agents, hooks, CI scripts and statusline parsers already read it.
 * Nothing about graft is ever removed — see `graftNotice` for the one line a
 * person typing it sees.
 *
 * The name travels in an environment variable rather than a module variable so
 * that every child this process spawns (the detached update check, a hook's
 * background build) speaks the same name as its parent. Unset means graft: the
 * only things that load `dist/cli.js` without going through `dist/bin/*` are
 * shims and configs an older graft wrote.
 *
 * This file imports nothing heavier than node:fs, because the hooks load it.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type Brand = "trail" | "graft";

/** Set by `dist/bin/trail.js` and `dist/bin/graft.js` before the CLI loads. */
export const BRAND_ENV = "TRAIL_INVOKED_AS";

/** The npm package each name is published as. Same code, two names. */
export const PACKAGE_FOR: Record<Brand, string> = {
  trail: "@trailhq/trail",
  graft: "@nanonets/graft",
};

export function brand(env: NodeJS.ProcessEnv = process.env): Brand {
  return env[BRAND_ENV] === "trail" ? "trail" : "graft";
}

export function setBrand(b: Brand, env: NodeJS.ProcessEnv = process.env): void {
  env[BRAND_ENV] = b;
}

/** `[trail]` or `[graft]`: the prefix agents and the statusline look for. */
export function tag(env: NodeJS.ProcessEnv = process.env): string {
  return `[${brand(env)}]`;
}

/**
 * The commands whose trail spelling is not just `graft` → `trail`, longest
 * prefix first. `graft check` gave its name to the team check, `graft stats`
 * and `graft trail status` became one `trail status`, and the `graft trail …`
 * group moved to the top level.
 */
const RENAMED: ReadonlyArray<readonly [string, string]> = [
  ["graft trail disconnect", "trail logout"],
  ["graft trail connect", "trail login"],
  ["graft trail status", "trail status"],
  ["graft trail", "trail"],
  ["graft check", "trail build --check"],
  ["graft stats", "trail status"],
  ["graft", "trail"],
];

/**
 * A command as the running name spells it. Takes the graft spelling, so call
 * sites read the way they always have and graft's output does not change:
 * `cmd("graft trail push")` is `graft trail push` under graft and `trail push`
 * under trail.
 */
export function cmd(graftSpelling: string, b: Brand = brand()): string {
  if (b === "graft") return graftSpelling;
  for (const [from, to] of RENAMED) {
    if (graftSpelling === from) return to;
    if (graftSpelling.startsWith(`${from} `)) return `${to}${graftSpelling.slice(from.length)}`;
  }
  return graftSpelling;
}

/**
 * Agent-facing prose and tool names in trail's spelling: `graft_find_code` →
 * `trail_find_code`, and the word graft → trail. A `graft` followed by `/` is
 * the code map's folder and stays, as do `graft-…` names. Under graft, the
 * text comes back unchanged.
 */
export function inBrand(text: string, b: Brand = brand()): string {
  if (b === "graft") return text;
  return text.replace(/\bgraft_(?=[a-z])/g, "trail_").replace(/\bgraft\b(?![/\w-])/g, "trail");
}

/* -------------------------------------------------------------------------- */
/* hooks and the statusline                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `trail init` wired this repo under trail's names: its committed hooks shim,
 * skill or settings say trail. Read from the repo, not the machine, so every
 * teammate's agent speaks the same name whichever command they installed.
 */
export function repoWiredForTrail(dir: string): boolean {
  if (existsSync(join(dir, ".claude", "helpers", "trail-hooks.cjs")) || existsSync(join(dir, ".claude", "skills", "trail", "SKILL.md"))) return true;
  try {
    return readFileSync(join(dir, ".claude", "settings.json"), "utf8").includes("trail-hooks.cjs");
  } catch {
    return false;
  }
}

/**
 * The name hooks and the statusline speak in `repo`. They run under whatever
 * shim set the repo up, often one an older graft committed, so no `dist/bin`
 * entry has set a name. They say trail in a repo wired for it, but only when
 * the `trail` command is installed on this machine: a hook that tells the
 * agent to run a command the machine doesn't have costs a failed tool call.
 * A name already set (by the CLI that spawned this) is kept.
 */
export function adoptRepoBrand(repo: string, env: NodeJS.ProcessEnv = process.env): Brand {
  if (env[BRAND_ENV] !== "trail" && env[BRAND_ENV] !== "graft") {
    setBrand(repoWiredForTrail(repo) && trailOnPath(env) ? "trail" : "graft", env);
  }
  return brand(env);
}

/* -------------------------------------------------------------------------- */
/* the once-a-day line for people still typing graft                          */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

export function noticeStampPath(home: string = homedir()): string {
  return join(home, ".graft", "rename-notice.json");
}

/** Whether a `trail` executable is on PATH. Only checked when the notice is due. */
export function trailOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const names = process.platform === "win32" ? ["trail.cmd", "trail.exe", "trail"] : ["trail"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      try {
        if (statSync(join(dir, n)).isFile()) return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

export interface NoticeInput {
  /** The graft spelling of what just ran, e.g. `graft ask` or `graft trail status`. */
  ran: string;
  /** stderr is a terminal: a person is watching. */
  tty: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: number;
}

/**
 * The line a person typing `graft` sees, at most once a day, or null.
 *
 * Never shown to an agent (no terminal, or Claude Code's `CLAUDECODE` is set),
 * in CI, or under trail itself: agents and scripts get graft's output exactly
 * as it was. Writing the stamp is best-effort; a home we cannot write to just
 * means the line may show again tomorrow.
 */
export function graftNotice(input: NoticeInput): string | null {
  const env = input.env ?? process.env;
  if (brand(env) !== "graft" || !input.tty) return null;
  if (env.CLAUDECODE !== undefined || env.CI || env.GRAFT_NO_RENAME_NOTICE) return null;
  const now = input.now ?? Date.now();
  const path = noticeStampPath(input.home);
  try {
    const last = (JSON.parse(readFileSync(path, "utf8")) as { shownAt?: number }).shownAt ?? 0;
    if (now - last < DAY_MS) return null;
  } catch {
    /* never shown */
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ shownAt: now }) + "\n");
  } catch {
    /* shown again next time */
  }
  const lines = [`· graft is now trail. this ran ${cmd(input.ran, "trail")}, and graft keeps working (shown once a day)`];
  if (!trailOnPath(env)) lines.push("· run graft upgrade to get the trail command too");
  return lines.join("\n");
}
