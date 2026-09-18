/**
 * Watching a brain being built, from the terminal.
 *
 * `graft brain push` used to end at "it is being mined into rules now — a few
 * minutes. Watch it finish in your browser." and hand the prompt straight back.
 * That sentence is the last thing this process ever says about the work, and it
 * is said BEFORE the part that actually fails: of the repo brains attempted in
 * production, roughly a third die inside the miner, after the push succeeded.
 * The terminal has already returned by then, so on this side the failure does
 * not exist at all — and on a CI runner or over SSH, where nobody is going to
 * open a browser, it exists nowhere.
 *
 * So the push now holds the line and reports the same four stages the browser
 * shows, off the same row. Ctrl-C detaches without cancelling anything, because
 * the work is server-side and killing a watcher must never look like killing
 * the build.
 */
import type { BrainLink } from "./link.js";
import { baseUrlFor } from "./link.js";

/** The stages, in the order they happen. The wording matches Trail's build
 *  screen deliberately: two products describing one process differently is how
 *  a person ends up unsure whether they are looking at the same thing. */
export const STAGES = [
  { id: "reach", label: "reaching the repository" },
  { id: "read", label: "reading its history" },
  { id: "mine", label: "mining the rules" },
  { id: "file", label: "filing them into the brain" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];
export type StageState = "waiting" | "doing" | "done" | "failed";

export interface Stage {
  id: StageId;
  label: string;
  state: StageState;
  /** A count worth printing beside a stage that has produced one. */
  detail?: string;
}

/** The repo row, as the public endpoint returns it. Only the fields the stages
 *  read, so a field added server-side cannot quietly change what is printed. */
export interface RepoState {
  status: string;
  errorMessage?: string;
  ruleCount: number;
  commitCount: number;
  threadCount: number;
}

export interface BuildView {
  stages: Stage[];
  done: boolean;
  /** The server's own words, when it failed. */
  error: string | null;
}

const num = (v: unknown): number => (typeof v === "number" && v > 0 ? v : 0);

/**
 * Which stage the work is in.
 *
 * The rule that matters is where a failure lands. A row that never left
 * `pending` failed at the access check; one that read 412 commits and then died
 * failed in the miner. Reporting both as "could not reach it" would send someone
 * to fix repository access for a problem that has nothing to do with it.
 */
export function stagesFrom(repo: RepoState | null): BuildView {
  const commits = num(repo?.commitCount);
  const threads = num(repo?.threadCount);
  const rules = num(repo?.ruleCount);

  const reached = !!repo && repo.status !== "pending";
  const readIt = commits > 0 || threads > 0;
  const filed = rules > 0;
  const failed = repo?.status === "failed";

  const failedAt: StageId | null = !failed ? null : !reached || !readIt ? "reach" : !filed ? "mine" : "file";

  const order = STAGES.map((s) => s.id);
  const state = (id: StageId): StageState => {
    if (failedAt === id) return "failed";
    if (failedAt && order.indexOf(id) > order.indexOf(failedAt)) return "waiting";
    switch (id) {
      case "reach":
        return reached ? "done" : "doing";
      case "read":
        return readIt ? "done" : reached ? "doing" : "waiting";
      case "mine":
        return filed ? "done" : readIt ? "doing" : "waiting";
      case "file":
        return filed ? "done" : readIt ? "doing" : "waiting";
    }
  };

  const detail = (id: StageId): string | undefined => {
    if (id === "read" && (commits || threads)) {
      return [commits ? `${commits} commits` : null, threads ? `${threads} discussions` : null].filter(Boolean).join(", ");
    }
    if (id === "file" && rules) return `${rules} rules`;
    return undefined;
  };

  return {
    stages: STAGES.map((s) => ({ id: s.id, label: s.label, state: state(s.id), detail: detail(s.id) })),
    done: repo?.status === "completed" && filed,
    error: failed ? (repo?.errorMessage?.trim() || "the read stopped before it finished") : null,
  };
}

/**
 * Read the repo row this brain is building.
 *
 * The same endpoint `fetchExpectedRepo` uses, read for its counts rather than
 * its slug. Null on any failure, so a watcher that cannot reach the API prints
 * nothing new rather than inventing a failure the build did not have.
 */
export async function fetchRepoState(link: BrainLink, fetchImpl: typeof fetch = fetch): Promise<RepoState | null> {
  try {
    const res = await fetchImpl(`${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/repo`, {
      headers: { authorization: `Bearer ${link.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      repo?: { status?: string; error_message?: string; rule_count?: number; commit_count?: number; thread_count?: number } | null;
    };
    if (!body.repo) return null;
    return {
      status: String(body.repo.status ?? ""),
      errorMessage: body.repo.error_message,
      ruleCount: num(body.repo.rule_count),
      commitCount: num(body.repo.commit_count),
      threadCount: num(body.repo.thread_count),
    };
  } catch {
    return null;
  }
}

/** One printable line per stage that has moved since it was last printed. */
export function linesFor(view: BuildView, already: Set<string>): string[] {
  const out: string[] = [];
  for (const s of view.stages) {
    // Only settled states are printed. A line per poll for a stage that is
    // merely still running would bury the four that matter under a hundred
    // that do not — this is a log, not a redrawn frame.
    if (s.state !== "done" && s.state !== "failed") continue;
    const key = `${s.id}:${s.state}`;
    if (already.has(key)) continue;
    already.add(key);
    const mark = s.state === "done" ? "✓" : "✗";
    out.push(`  ${mark} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
  }
  return out;
}

export interface WatchOptions {
  /** How long to hold before giving up on a build that is still running. */
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  /** Where the lines go. Injected so the tests do not need a console. */
  write?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type WatchOutcome = "completed" | "failed" | "timed_out" | "unreachable";

/**
 * Hold until the brain is built, printing each stage as it settles.
 *
 * Fifteen minutes by default: a large repository's mining is minutes of work,
 * and a watcher that gives up before the build does would report a healthy
 * build as a timeout — the exact confusion this is meant to remove. Giving up
 * says so and says the work continues, because it does.
 */
export async function watchBuild(link: BrainLink, opts: WatchOptions = {}): Promise<WatchOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const pollMs = opts.pollMs ?? 4000;
  const write = opts.write ?? ((l: string) => console.error(l));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));

  const printed = new Set<string>();
  const startedAt = Date.now();
  // A row we could never read at all, as opposed to one that answered once and
  // then stopped answering: the first is a broken link or a host that is down
  // and is worth saying, the second is a blip the next poll usually covers.
  let everRead = false;

  for (;;) {
    const repo = await fetchRepoState(link, opts.fetchImpl);
    if (repo) {
      everRead = true;
      const view = stagesFrom(repo);
      for (const line of linesFor(view, printed)) write(line);
      if (view.error) {
        write(`✗ ${view.error}`);
        return "failed";
      }
      if (view.done) return "completed";
    }
    if (Date.now() - startedAt >= timeoutMs) return everRead ? "timed_out" : "unreachable";
    await sleep(pollMs);
  }
}
