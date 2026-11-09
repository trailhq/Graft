/**
 * Discovery and the look-back off the main thread: `trail init` keeps wiring
 * and building the graph (and its spinner keeps turning) while a worker
 * reads the transcripts. The worker is this same module, started on its own
 * file; anything that goes wrong with the thread falls back to reading on
 * the main thread.
 */
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { lookBack, type LookBackOpts, type LookBackResult } from "./look-back-mine.js";
import { discoverSessions, type Discovery } from "./sessions.js";
import type { LookBack } from "./types.js";

const TAG = "trailDiscover";
const LOOK = "trailLookBack";
/** Past the cap, how long the main thread waits for the worker's answer before it gives up on it. */
const GRACE_MS = 30_000;

/** `discoverSessions(repo, home, now, env)` in a worker thread, under the Trail home `env` names. Never rejects. */
export function discoverOffThread(repo: string, home: string, env: NodeJS.ProcessEnv = process.env): Promise<Discovery> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (d: Discovery) => {
      if (settled) return;
      settled = true;
      resolve(d);
    };
    const here = () => {
      if (!settled) done(discoverSessions(repo, home, new Date(), env));
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { [TAG]: { repo, home, env: { ...env } } } });
    } catch {
      setImmediate(here);
      return;
    }
    worker.once("message", (d: Discovery) => done(d));
    worker.once("error", here);
    worker.once("exit", here);
  });
}

type Progress = NonNullable<LookBackOpts["onProgress"]>;

/**
 * The no-model look-back (design 4.1 to 4.5) in a worker: discovery, replay, miners, how-tos and candidates, with
 * progress every 2 s. Never rejects: a worker that can't start (or can't load this module) runs it here; one that dies or overruns its cap by
 * 30 s gives an empty look-back that says so.
 */
export function lookBackOffThread(dir: string, opts: { env: NodeJS.ProcessEnv; capMs: number; skills: boolean;
  onProgress?: Progress }): Promise<LookBackResult> {
  const { onProgress, ...plain } = opts;
  const empty = (why: string): LookBack => ({
    sessions: [], skipped: [], days: 0, from: null, to: null, parent: 0, candidates: [], alreadyKept: { here: 0, elsewhere: [] }, howtos: [], ms: 0,
    errors: [`couldn't read your past sessions this time (${why})`],
  });
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (lb: LookBackResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(lb);
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { [LOOK]: { dir, opts: { ...plain, env: { ...plain.env } } } } });
    } catch {
      setImmediate(() => done(lookBack(dir, opts)));
      return;
    }
    timer = setTimeout(() => {
      done(empty("out of time"));
      void worker.terminate();
    }, Math.max(0, opts.capMs) + GRACE_MS);
    timer.unref?.();
    worker.on("message", (m: { progress?: Parameters<Progress>[0]; done?: LookBackResult }) => {
      if (m?.progress && onProgress) {
        try {
          onProgress(m.progress);
        } catch { /* a progress line never stops the look-back */ }
      }
      if (m?.done) done(m.done);
    });
    worker.once("error", (e) => {
      // A worker that can't load this module (Node 20 runs a .ts source only on the main thread) never started: run it here.
      if ((e as NodeJS.ErrnoException | null)?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
        if (!settled) done(lookBack(dir, opts));
        return;
      }
      done(empty(e instanceof Error ? e.message.slice(0, 80) : "the reader stopped"));
    });
    worker.once("exit", () => done(empty("the reader stopped")));
  });
}

if (!isMainThread && workerData && typeof workerData === "object") {
  const data = workerData as Record<string, unknown>;
  if (TAG in data) {
    const { repo, home, env } = data[TAG] as { repo: string; home: string; env?: NodeJS.ProcessEnv };
    parentPort?.postMessage(discoverSessions(repo, home, new Date(), env ?? process.env));
  } else if (LOOK in data) {
    const { dir, opts } = data[LOOK] as { dir: string; opts: Omit<LookBackOpts, "onProgress"> };
    const lb = lookBack(dir, { ...opts, onProgress: (p) => parentPort?.postMessage({ progress: p }) });
    parentPort?.postMessage({ done: lb });
  }
}
