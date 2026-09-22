/**
 * A stand-in for `src/app/review-worker.ts`, forked by `app-review-process.test.ts`.
 *
 * Speaks the same IPC protocol, and instead of cloning a repository it does the one
 * thing the real review does that matters to the test: it blocks. `job.baseRef`
 * carries the mode, because a fixture may as well use a field it has no other use
 * for than invent a channel for it:
 *
 *   block:<ms>  hold this process's event loop, using no CPU at all — the
 *               `spawnSync` git fetch, which is what most of a review's wall clock
 *               actually is (load average 0.96 on eight vCPUs, in production).
 *   burn:<ms>   hold it with a busy loop, one core pegged — the tree-sitter parse.
 *   fail:<msg>  report a failed review.
 *   crash       exit without reporting: an OOM kill, or a grammar segfault.
 *   hang        never report, and stay alive.
 *   ok          publish and report immediately.
 *
 * Every reporting mode publishes a page through the parent BEFORE it blocks, which
 * exercises the round trip that puts a page in the server's store and gives the
 * test a sync point: once the parent has answered the publish, this process is
 * about to go unresponsive, and the parent had better not be.
 */
import type { FromChild, ToChild } from "../src/app/review-process.js";

const awaiting = new Map<number, (url: string | null) => void>();
let seq = 0;

const send = (msg: FromChild): void => {
  process.send?.(msg);
};

function finish(msg: FromChild): void {
  process.send?.(msg, () => process.disconnect?.());
}

/** Block without spending CPU, the way a synchronous `git fetch` does. */
function block(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function burn(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* peg one core, the way the parse loop does */
  }
}

const publish = (html: string): Promise<string | null> =>
  new Promise((resolve) => {
    const id = (seq += 1);
    awaiting.set(id, resolve);
    send({ t: "publish", seq: id, html });
  });

async function run(mode: string): Promise<void> {
  const [kind, arg] = mode.split(":");

  if (kind === "crash") process.exit(3);
  if (kind === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (kind === "fail") {
    finish({ t: "failed", message: arg ?? "probe failure" });
    return;
  }

  send({ t: "log", msg: `probe: ${mode}` });
  const url = await publish(`<h1>${mode}</h1>`);

  if (kind === "block") block(Number(arg));
  if (kind === "burn") burn(Number(arg));

  finish({ t: "done", result: { commentUrl: null, areas: 1, affected: 2, viewerUrl: url } });
}

process.on("message", (raw) => {
  const msg = raw as ToChild;
  if (msg.t === "start") {
    void run(msg.job.baseRef);
    return;
  }
  awaiting.get(msg.seq)?.(msg.url);
  awaiting.delete(msg.seq);
});
