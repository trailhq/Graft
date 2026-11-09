/**
 * Init's miners (design 4.3): what the replayed sessions hold, counted.
 *
 * Jobs: the session-days each moment-2 job came back on (the pool's own
 * rule: a run of an offer job with a step call, one per local date and
 * session), the costly ones, and the newest checked runs as sheets with
 * where they came from, so a skill can be compiled again at keep (R24).
 * The miner takes one replay at a time and holds at most 4 sheets per job
 * (3 to compile and the prior of the 3rd), so reading many sessions stays
 * bounded (R36).
 *
 * Walls: every call with a wall (seen) and every repair (fixed, delta kinds
 * and names only), for the sessions walls.json hasn't read yet, shaped for
 * `noteWalls`. Classes, programs, repo keys, local dates and session hashes:
 * never a command or its output.
 */
import { localDate } from '../skills/settings.js';
import { OFFER_FAMILIES } from '../trace/jobs.js';
import { costly } from '../trace/runs.js';
import { programOf } from '../trace/shell.js';
import { simpleCommands } from '../trace/shell-words.js';
import type { JobClass, RunSheet, WallClass } from '../trace/types.js';
import { WALLS } from '../trace/walls.js';
import { programKey, type noteWalls } from '../trace/wall-state.js';
import type { Replay, ReplaySheet } from './replay-runs.js';
import type { SkillSource } from './types.js';

/** Sheets to compile from, per job (4.5: the newest, then up to 2 more). */
const GOOD = 3;

export interface JobGood {
  sheet: RunSheet;
  /** Where to compile it again. `skillSha` is '' until the candidate is compiled. */
  src: SkillSource;
  /** The checkout the run's repo was in, for relativizing paths. */
  root: string;
  /** The checked run of the same job before it, for params (compile's `prior`). */
  prior: ReplaySheet | null;
}

/**
 * `days`: session-days as `YYYY-MM-DD|<session hash>`, sorted; `costly`: how many of them cost 5+ tool calls or
 * had a failure (`costlyDays`: which); `good`: newest first, at most 3; `words`: the job's vocabulary words seen.
 */
export interface JobFind { job: JobClass; days: string[]; costly: number; good: JobGood[]; costlyDays?: string[]; words?: string[] }

type Held = ReplaySheet & { t: string; size: number; mtimeMs: number };

/** Mines one replay at a time; `result()` when every session is read. */
export class JobMiner {
  private days = new Map<JobClass, Map<string, boolean>>();
  private sheets = new Map<JobClass, Held[]>();
  private words = new Map<JobClass, Set<string>>();

  add(r: Replay): this {
    if (r.headless) return this;
    for (const run of r.runs) {
      // The pool's rule (3.5 step 8): an offer job with a step call, in this repo.
      if (!run.job || !OFFER_FAMILIES[run.job] || run.stepCalls <= 0 || !run.repoKey || run.repoKey !== r.repoKey) continue;
      const days = this.days.get(run.job) ?? new Map<string, boolean>();
      const key = `${localDate(run.startedAt)}|${r.sh}`;
      days.set(key, (days.get(key) ?? false) || costly(run));
      this.days.set(run.job, days);
      const words = this.words.get(run.job) ?? new Set<string>();
      for (const w of run.jobWords) if (words.size < 12) words.add(w);
      this.words.set(run.job, words);
    }
    for (const s of r.sheets) {
      const job = s.sheet.job;
      if (!job || s.sheet.repoKey !== r.repoKey) continue;
      const list = this.sheets.get(job) ?? [];
      list.push({ ...s, t: r.path, size: r.size, mtimeMs: r.mtimeMs });
      list.sort((a, b) => Date.parse(b.sheet.startedAt) - Date.parse(a.sheet.startedAt));
      list.length = Math.min(list.length, GOOD + 1);
      this.sheets.set(job, list);
    }
    return this;
  }

  /** Sheets held now, all jobs. */
  held(): number {
    let n = 0;
    for (const l of this.sheets.values()) n += l.length;
    return n;
  }

  result(): JobFind[] {
    const out: JobFind[] = [];
    for (const [job, days] of this.days) {
      const held = this.sheets.get(job) ?? [];
      const good: JobGood[] = held.slice(0, GOOD).map((h, i) => {
        const prior = held[i + 1] ?? null;
        return {
          sheet: h.sheet, root: h.root,
          prior: prior ? { sheet: prior.sheet, src: prior.src, root: prior.root } : null,
          src: { t: h.t, size: h.size, mtimeMs: h.mtimeMs, run: { ...h.src }, prior: prior ? { t: prior.t, ...prior.src } : null, skillSha: '' },
        };
      });
      const costlyDays = [...days].filter(([, c]) => c).map(([d]) => d).sort();
      out.push({ job, days: [...days.keys()].sort(), costly: costlyDays.length, good, costlyDays, words: [...(this.words.get(job) ?? [])] });
    }
    return out;
  }
}

export function mineJobs(replays: Replay[]): JobFind[] {
  const m = new JobMiner();
  for (const r of replays) m.add(r);
  return m.result();
}

/** wall-state's one rule for a program name (D98), 'shell' when nothing is left of it. */
const firstWord = (s: string) => programKey(String(s ?? '').replace(/^\S*\//, '')) || 'shell';

/** The program a wall hit is put down to: the catalog's program the command runs (`timeout`, `git`), else its own. */
export function wallProgram(cls: WallClass, cmd: string | null): string {
  if (!cmd) return 'shell';
  const listed = WALLS.find((w) => w.cls === cls)?.programs ?? null;
  if (listed) {
    const words = new Set(simpleCommands(cmd).flatMap((s) => s.split(/\s+/)).map((w) => w.replace(/^.*\//, '')));
    const p = listed.find((x) => words.has(x));
    if (p) return p;
  }
  // programOf gives two words for a runner (`git push`, `npm run`): the program is the first (D98's programKey).
  const own = programOf(cmd);
  return own ? firstWord(own) : 'shell';
}

type WallsAdd = Parameters<typeof noteWalls>[0];


/**
 * Wall hits and repairs, shaped for wall-state's noteWalls (no command text), for the sessions not yet in
 * `read` (walls.json's), and those sessions' `read` marks.
 */
export function mineWalls(replays: Replay[], read: Record<string, string> = {}): WallsAdd {
  const seen: NonNullable<WallsAdd['seen']> = [];
  const fixed: NonNullable<WallsAdd['fixed']> = [];
  const marks: Record<string, string> = {};
  for (const r of replays) {
    if (r.headless || read[r.sh] !== undefined) continue;
    for (const run of r.runs) {
      for (const c of run.calls) {
        if (!c.wall) continue;
        seen.push({ cls: c.wall, d: localDate(c.at), sh: r.sh, epoch: run.epoch, repo: run.repoKey, program: wallProgram(c.wall, c.cmd) });
      }
      for (const rep of run.repairs ?? []) {
        // walls.json holds one word per program and delta name (`go`, not `go test`; `colima`, not `colima ssh --`).
        fixed.push({
          cls: rep.cls, d: localDate(rep.at), sh: r.sh, epoch: rep.epoch, repo: run.repoKey, program: firstWord(rep.program),
          delta: rep.delta.map((x) => ({ kind: x.kind, name: x.kind === 'env' || x.kind === 'flag' ? x.name : firstWord(x.name) })),
        });
      }
    }
    // Marked read only when read whole: a replay cut short, or one repo's stretch of a session another repo also
    // worked in, leaves the rest to count later (noteWalls is idempotent per session, epoch and program, b5 review).
    const whole = !r.stopped && (!r.stretch || (r.stretch.from <= 0 && r.stretch.to >= r.size));
    if (whole) marks[r.sh] = `${r.size}:${Math.trunc(r.mtimeMs)}`;
  }
  return { seen, fixed, read: marks };
}
