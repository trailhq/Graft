/**
 * A pool of forked parser children for large cold builds. Opt-in only:
 * `buildGraph` never forks unless the `graft build` command asked for it
 * (`--workers`, or `GRAFT_PARSE_WORKERS`), so the pre-query refresh, the MCP
 * server and the App's review worker parse in-thread whatever the edit size.
 *
 * Failure modes degrade, never hang and never reject: a dead child's job is
 * retried once, then parked. A parked job's fate is decided only once the pool
 * settles, by whether the pool ever completed a job in a child at all:
 *   - if some job succeeded, a file that killed two children is a poisoned file,
 *     and its parked job becomes an `error` result — never retried in the parent,
 *     where the same crash would take down the whole build;
 *   - if no job ever succeeded, the crashes are environmental (fork, loader,
 *     permissions), so the parked jobs are parsed in-thread with the rest.
 * A pool that cannot keep children alive hands the remaining queue back to the
 * parent, which has warmed grammars.
 */
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { fileURLToPath } from "node:url";
import { extractOne, type ExtractOneResult, type PriorParse } from "./extract-one.js";
import type { GrammarSet } from "./tier.js";
import type { SourceStat } from "./source-files.js";
import type { FromChild, ToChild } from "./parse-worker.js";

/** Under this many files, forking, warming grammars (~300 ms per child) and IPC
 * cost more than they save. */
export const PARSE_POOL_MIN_FILES = 200;
const FILES_PER_CHILD = 200;
/** Working set of one child with nine native grammars, WASM and a parse in flight. */
const BYTES_PER_CHILD = 300 * 1024 * 1024;
const MAX_ATTEMPTS = 2;

export interface PoolOptions {
  workers: number;
  entry?: string;
  onResult?: (index: number, file: string) => void;
  jobTimeoutMs?: number;
  warmTimeoutMs?: number;
}

/** `dist/graph/parse-worker.js`, or the `.ts` next to it when run from a checkout
 * under tsx (fork inherits `--import tsx` through execArgv). */
export function parseWorkerEntry(): string {
  const js = fileURLToPath(new URL("./parse-worker.js", import.meta.url));
  if (existsSync(js)) return js;
  const ts = js.replace(/\.js$/, ".ts");
  return existsSync(ts) ? ts : js;
}

/** Children to fork for `files` files. 0 means in-thread, and 0 is the answer
 * unless `GRAFT_PARSE_WORKERS` says otherwise: `N` forces N, `auto` picks
 * `min(cores - 1, freemem / 300 MB, files / 200)`, anything else is in-thread. */
export function poolSize(
  files: number,
  env: NodeJS.ProcessEnv = process.env,
  cores = availableParallelism(),
  freeBytes = freemem(),
): number {
  const v = (env.GRAFT_PARSE_WORKERS ?? "").trim();
  if (v === "") return 0;
  if (v !== "auto") {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 && String(n) === v ? n : 0;
  }
  if (files < PARSE_POOL_MIN_FILES) return 0;
  const byCores = cores - 1;
  const byMemory = Math.floor(freeBytes / BYTES_PER_CHILD);
  const byWork = Math.ceil(files / FILES_PER_CHILD);
  const n = Math.min(byCores, byMemory, byWork);
  return n >= 2 ? n : 0;
}

interface Job { index: number; attempts: number; exit?: string }

export function runParsePool(
  files: SourceStat[],
  priorOf: (rel: string) => PriorParse | null,
  grammars: GrammarSet,
  opts: PoolOptions,
): Promise<ExtractOneResult[]> {
  const entry = opts.entry ?? parseWorkerEntry();
  const jobTimeoutMs = opts.jobTimeoutMs ?? 120_000;
  const warmTimeoutMs = opts.warmTimeoutMs ?? 60_000;
  const results: ExtractOneResult[] = new Array(files.length);
  const queue: Job[] = files.map((_, index) => ({ index, attempts: 0 }));
  const init: ToChild = { type: "init", grammars };
  let outstanding = files.length;
  let succeeded = 0;
  let inFlight = 0;
  let respawns = 0;
  const maxRespawns = opts.workers * 2;
  const children = new Set<ChildProcess>();
  // Jobs that killed MAX_ATTEMPTS children: held here until the pool settles, when
  // `succeeded` decides error (poisoned file) vs in-thread parse (environmental).
  const parked: Job[] = [];
  let settled = false;

  return new Promise<ExtractOneResult[]>((resolvePool) => {
    const killAll = (): void => {
      for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
      children.clear();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      killAll();
      resolvePool(results);
    };
    /** Drain the parked jobs. `inThread` (i.e. `succeeded === 0`) means the crashes
     * were environmental, so parse them like the rest of the queue; otherwise they
     * are the brief's twice-crashed `error` result. */
    const settleParked = (inThread: boolean): void => {
      if (settled) return;
      for (const job of parked.splice(0)) {
        const f = files[job.index];
        if (inThread) {
          results[job.index] = extractOne(f, priorOf(f.rel));
        } else {
          const message = `${f.rel}: parse failed — parser process exited (${job.exit ?? "unknown"}) on this file twice`;
          results[job.index] = { kind: "error", message, entry: { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: message } };
        }
        opts.onResult?.(job.index, f.rel);
        outstanding--;
      }
      if (outstanding === 0) finish();
    };
    /** The pool cannot keep children alive: parse what is left here, in order,
     * then settle the parked jobs (in-thread, since none ever succeeded). */
    const fallbackInThread = (): void => {
      if (settled) return;
      killAll();
      for (const job of queue.splice(0)) {
        results[job.index] = extractOne(files[job.index], priorOf(files[job.index].rel));
        opts.onResult?.(job.index, files[job.index].rel);
        outstanding--;
      }
      settleParked(succeeded === 0);
      if (outstanding === 0) finish();
    };
    /** No queued work and no child holds a job: the pool has drained. Settle any
     * parked jobs (poisoned files if the pool ever worked, environmental if not),
     * or finish if there is nothing left. */
    const drainIfIdle = (): void => {
      if (queue.length !== 0 || inFlight !== 0) return;
      if (parked.length > 0) settleParked(succeeded === 0);
      else if (outstanding === 0) finish();
    };
    const post = (child: ChildProcess, msg: ToChild): boolean => {
      if (!child.connected) return false;
      try { child.send(msg); return true; } catch { return false; }
    };

    const spawn = (): void => {
      // `windowsHide` is a real, effective fork option (forwarded to spawn) but
      // @types/node 26 lists it on CommonOptions, which ForkOptions does not
      // extend — hence the intersection rather than dropping the flag or `any`.
      const forkOpts: ForkOptions & { windowsHide?: boolean } = {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "advanced",
        windowsHide: true,
      };
      const child = fork(entry, [], forkOpts);
      children.add(child);
      let current: Job | null = null;
      let ready = false;
      let timer: NodeJS.Timeout | null = setTimeout(() => child.kill(), warmTimeoutMs);
      timer.unref();
      const clearTimer = (): void => { if (timer) { clearTimeout(timer); timer = null; } };

      const next = (): void => {
        const job = queue.shift();
        if (!job) {
          current = null;
          post(child, { type: "stop" });
          drainIfIdle();
          return;
        }
        job.attempts++;
        current = job;
        inFlight++;
        timer = setTimeout(() => child.kill(), jobTimeoutMs);
        timer.unref();
        if (!post(child, { type: "job", seq: job.index, f: files[job.index], prior: priorOf(files[job.index].rel) })) {
          // Dead channel: the exit handler re-queues `current` and decrements inFlight.
          clearTimer();
        }
      };

      child.on("message", (m: FromChild) => {
        if (settled) return;
        if (m.type === "ready") { ready = true; clearTimer(); next(); return; }
        if (m.type !== "done" || current === null || m.seq !== current.index) return;
        clearTimer();
        succeeded++;
        results[m.seq] = m.result;
        opts.onResult?.(m.seq, files[m.seq].rel);
        current = null;
        inFlight--;
        if (--outstanding === 0) finish();
        else next();
      });

      const onGone = (code: number | null, signal: NodeJS.Signals | null): void => {
        clearTimer();
        children.delete(child);
        if (settled) return;
        if (current !== null) {
          const job = current;
          current = null;
          inFlight--;
          if (job.attempts < MAX_ATTEMPTS) {
            queue.unshift(job);
          } else {
            // Twice-crashed: park it. Whether it is an error or parsed in-thread is
            // decided at settle time by `succeeded`, not here.
            job.exit = signal ?? `code ${code}`;
            parked.push(job);
          }
        }
        if (queue.length === 0) { drainIfIdle(); return; }
        // Work remains. Replace the child within reason; past that, the pool is
        // not working on this machine and the parent finishes the job itself.
        if (respawns++ < maxRespawns) spawn();
        else if (children.size === 0) fallbackInThread();
        void ready;
      };
      child.once("exit", onGone);
      child.once("error", () => onGone(null, null)); // spawn failure: no exit follows
      if (!post(child, init)) onGone(null, null);
    };

    for (let i = 0; i < Math.max(1, opts.workers); i++) spawn();
  });
}
