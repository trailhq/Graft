/**
 * Running a repository read somewhere it cannot stop the App answering.
 *
 * The same problem the reviewer had, and the same fix — see review-process.ts
 * for the full reasoning and the production measurements behind it. In short:
 * every expensive step of a read is synchronous (git through `spawnSync`, the
 * parse a loop of native tree-sitter calls, the graph written with a blocking
 * stringify), so in-process one read holds the event loop for its whole
 * duration.
 *
 * Onboarding made that visible in a way reviews did not. Measured on
 * NanoNets/assign: 0.7s to check access, 7s to clone, 81s to build the symbol
 * graph, 21s to walk the pull requests. During those 81 seconds the App
 * answered nothing at all — including the one-second question "can we see this
 * other repository", asked by the next person to paste a URL, who then waited
 * out someone else's clone before being told their repo is private. At a
 * hundred signups there is nearly always a read in flight, so that is not an
 * edge case, it is the normal case.
 *
 * The split is where the credential is: the parent resolves access and mints
 * the token (network, never blocking), and the child does the work with it.
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveRepoRead, type BrainBuildDeps, type BrainBuildJob, type BrainBuildResult } from "./brain-build.js";
import type { FromChild, StartMessage } from "./brain-build-worker.js";

/**
 * How long one read may take before the process running it is killed.
 *
 * Well above the worst honest read seen (110s on a large monorepo) plus the
 * clone budget checkout.ts allows itself, because the cost of being wrong is a
 * read that never happens. It bounds a lost slot, not responsiveness — the
 * server stopped caring how long a read takes the moment it left this process.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export interface ChildBuilderOptions {
  /** The module the child runs. Only tests pass this. */
  entry?: string;
  timeoutMs?: number;
}

/**
 * The module a read runs in. `dist/app/brain-build-worker.js` when installed or
 * containerised; the TypeScript source next door when run from a checkout,
 * since `fork` inherits `process.execArgv` and a parent started through tsx
 * hands the child the same loader.
 */
export function brainBuildWorkerEntry(): string {
  const js = fileURLToPath(new URL("./brain-build-worker.js", import.meta.url));
  if (existsSync(js)) return js;
  const ts = js.replace(/\.js$/, ".ts");
  return existsSync(ts) ? ts : js;
}

/** Reads in flight, so a shutdown does not leave a clone made with a token. */
const live = new Set<ChildProcess>();
let hooked = false;

function track(child: ChildProcess): void {
  live.add(child);
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const c of live) c.kill("SIGKILL");
  });
}

/**
 * A builder with buildRepoIntoBrain's signature that runs the heavy half in a
 * child process. Same shape on purpose: server.ts swaps one for the other in a
 * single line, and a test injecting its own builder keeps running in-process.
 */
export function childBuilder(opts: ChildBuilderOptions = {}): (job: BrainBuildJob, deps: BrainBuildDeps) => Promise<BrainBuildResult> {
  const entry = opts.entry ?? brainBuildWorkerEntry();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (job, deps) => {
    // In the parent, deliberately: it is pure network, it is what decides
    // whether there is anything to fork for, and a RepoNotAccessibleError has
    // to reach the caller as itself rather than as a dead child process.
    const auth = await resolveRepoRead(job, deps);
    return runInChild(job, deps, auth, entry, timeoutMs);
  };
}

async function runInChild(
  job: BrainBuildJob,
  deps: BrainBuildDeps,
  auth: Awaited<ReturnType<typeof resolveRepoRead>>,
  entry: string,
  timeoutMs: number,
): Promise<BrainBuildResult> {
  const log = deps.log ?? ((): void => {});
  const tag = `${job.owner}/${job.repo}`;
  // The repository as argv makes `ps` in a container say which read each
  // process is; the token stays out of it.
  const child = fork(entry, [tag], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  track(child);

  try {
    return await new Promise<BrainBuildResult>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`read of ${tag} exceeded ${timeoutMs}ms and was killed`)));
      }, timeoutMs);
      timer.unref();

      child.on("message", (raw) => {
        const msg = raw as FromChild;
        if (msg.t === "log") {
          log(msg.msg);
          return;
        }
        if (msg.t === "done") {
          settle(() => resolve(msg.result));
          return;
        }
        settle(() => reject(new Error(msg.message)));
      });

      child.on("error", (err) => settle(() => reject(err)));

      // The case that used to be an outage: a child that dies without
      // reporting. An OOM kill on a large repository, a grammar segfault on a
      // stranger's source. Now it costs one read, named, with the signal.
      child.on("exit", (code, signal) =>
        settle(() =>
          reject(new Error(`read of ${tag} exited ${signal ? `on ${signal}` : `with code ${code}`} before reporting a result`)),
        ),
      );

      const start: StartMessage = { t: "start", job, auth, api: deps.api, githubHost: deps.githubHost };
      if (child.connected) child.send(start);
    });
  } finally {
    live.delete(child);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

/** The App's default builder. */
export const buildRepoInChildProcess = childBuilder();
