/**
 * What a note says about where it came from: who wrote it, on which branch,
 * and which files the session changed. All from git, all best-effort: a
 * missing answer leaves the field out rather than guessing.
 */
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

/** git's stdout, trimmed unless `raw` (porcelain status starts lines with a meaningful space). */
function git(repo: string, args: string[], raw = false): string | null {
  try {
    const out = execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return raw ? out : out.trim();
  } catch {
    return null;
  }
}

/** First name from `git config user.name`, capitalised; the OS user as a last resort. */
export function noteAuthor(repo: string): string {
  const name = git(repo, ["config", "user.name"]) || safeUser();
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first ? first[0]!.toUpperCase() + first.slice(1) : "";
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

export function currentBranch(repo: string): string | undefined {
  const b = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return b && b !== "HEAD" ? b : undefined;
}

/** Paths that are the code map, agent wiring or the learnings themselves, never what a learning is about. */
export function ownPath(p: string): boolean {
  // .gitignore and .ignore too: `trail init` and the code map add their lines
  // to them, which is never what a session's note is about.
  return /^(graft|\.graft|\.claude|\.cursor|\.codex|\.trail)(\/|$)/.test(p) || p === ".mcp.json" || p === ".gitignore" || p === ".ignore";
}

/**
 * Files this session changed: uncommitted changes, plus files in commits made
 * since `since` (epoch ms). At most `limit`, in the order git lists them.
 */
export function changedFiles(repo: string, since?: number, limit = 10): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    const f = p.trim();
    if (f && !ownPath(f) && !out.includes(f)) out.push(f);
  };
  const status = git(repo, ["status", "--porcelain", "--untracked-files=all"], true);
  for (const line of (status ?? "").split("\n")) {
    if (!line.trim()) continue;
    // `XY path` or `XY old -> new`: the path now.
    const path = line.slice(3).split(" -> ").pop() ?? "";
    add(path.replace(/^"|"$/g, ""));
  }
  if (since !== undefined) {
    const log = git(repo, ["log", `--since=@${Math.floor(since / 1000)}`, "--name-only", "--pretty=format:"]);
    for (const p of (log ?? "").split("\n")) add(p);
  }
  return out.slice(0, limit);
}
