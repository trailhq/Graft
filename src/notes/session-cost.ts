/**
 * What the current agent session spent working something out, for a note's
 * cost line: active minutes, and tokens.
 *
 * Read from Claude Code's own transcript, which it keeps as JSONL under
 * `~/.claude/projects/<the repo path, every other character as "-">/`, one
 * file per session. The one being written right now is the newest. Other
 * agents keep no transcript we can read, so their notes carry no cost unless
 * the agent passes `--minutes` / `--tokens`.
 *
 * Counted from the session's last finished `trail note` (or its start), so two
 * notes from one long session don't both claim the same work. Tokens are the
 * ones the model actually processed fresh: input, cache writes and output.
 * Cache reads are left out, since they re-read the same context every turn and
 * would make an hour's work look like millions. Minutes are active minutes: a
 * gap of more than ten minutes between two entries counts as nothing, so a
 * session left open over lunch doesn't claim the lunch.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SessionCost {
  minutes: number;
  tokens: number;
  /** When the counted stretch began, epoch ms. */
  startedAt: number;
  /** Files the agent edited or wrote in that stretch, absolute, in order. */
  edited: string[];
}

const IDLE_MS = 10 * 60 * 1000;
/** A transcript untouched this long belongs to some earlier session. */
const ACTIVE_MS = 30 * 60 * 1000;

export function claudeProjectDir(repo: string, home: string = homedir()): string {
  return join(home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
}

/**
 * The project folder of the session that `dir` is part of: `dir`'s own, or
 * the nearest ancestor's. A note saved from a subfolder, or from one repo of
 * a session started in the folder above several, still finds its session.
 */
function sessionProjectDir(dir: string, home?: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const p = claudeProjectDir(d, home);
    if (existsSync(p)) return p;
    if (dirname(d) === d) return null;
  }
}

/** The transcript of the session running in `repo` now, or null. */
export function currentTranscript(repo: string, home?: string, now = Date.now()): string | null {
  const dir = sessionProjectDir(repo, home);
  if (!dir) return null;
  let best: { path: string; mtime: number } | null = null;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const mtime = statSync(join(dir, f)).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: join(dir, f), mtime };
    } catch {
      /* gone */
    }
  }
  return best && now - best.mtime <= ACTIVE_MS ? best.path : null;
}

interface Entry {
  type?: string;
  timestamp?: string;
  message?: {
    id?: string;
    usage?: { input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    content?: unknown;
  };
}

function blocks(e: Entry): Array<Record<string, unknown>> {
  const c = e.message?.content;
  return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : [];
}

/** Claude Code's tools that change a file, each naming it in `file_path` (`notebook_path` for notebooks). */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export const NOTE_CALL = /(^|[|&;]\s*|\s)(npx\s+(-y\s+)?(@trailhq\/|@nanonets\/)?)?(trail|graft)\s+note\b/;

/**
 * The cost of one transcript since its last finished note. Pure, for tests:
 * `text` is the JSONL, `now` closes the last stretch when the transcript ends
 * mid-turn (it always does: the note call itself is in flight).
 */
export function costFromTranscript(text: string, now = Date.now()): SessionCost | null {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      /* a half-written last line */
    }
  }
  // A note call is finished once its tool_result is in the transcript; the
  // call that is running right now has none yet, so it never counts as the
  // boundary.
  const noteCalls = new Set<string>();
  let boundary = -1;
  entries.forEach((e, i) => {
    for (const b of blocks(e)) {
      if (b.type === "tool_use" && typeof b.id === "string") {
        const cmd = (b.input as { command?: unknown } | undefined)?.command;
        if (typeof cmd === "string" && NOTE_CALL.test(cmd)) noteCalls.add(b.id);
      }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string" && noteCalls.has(b.tool_use_id)) boundary = i;
    }
  });

  const after = entries.slice(boundary + 1);
  const counted = after.filter((e) => e.timestamp);
  if (counted.length === 0) return null;
  const times = counted.map((e) => Date.parse(e.timestamp!)).filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  times.push(now);
  let activeMs = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (gap > 0 && gap <= IDLE_MS) activeMs += gap;
  }

  // Claude Code writes one line per content block, each repeating its
  // message's usage, so a message is counted once by its id.
  const seen = new Set<string>();
  let tokens = 0;
  for (const e of counted) {
    if (e.type !== "assistant" || !e.message?.usage) continue;
    const id = e.message.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const u = e.message.usage;
    tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  const edited: string[] = [];
  for (const e of after) {
    for (const b of blocks(e)) {
      if (b.type !== "tool_use" || !EDIT_TOOLS.has(String(b.name))) continue;
      const input = (b.input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
      const file = typeof input.file_path === "string" ? input.file_path : input.notebook_path;
      if (typeof file === "string" && file && !edited.includes(file)) edited.push(file);
    }
  }
  return { minutes: Math.max(1, Math.round(activeMs / 60_000)), tokens, startedAt: times[0]!, edited };
}

/** The running session's cost in `repo`, or null when there is no transcript to read. */
export function currentSessionCost(repo: string, home?: string, now = Date.now()): SessionCost | null {
  const path = currentTranscript(repo, home, now);
  if (!path) return null;
  try {
    return costFromTranscript(readFileSync(path, "utf8"), now);
  } catch {
    return null;
  }
}
