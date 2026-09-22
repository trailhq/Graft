/**
 * One review, in its own process. Forked by `./review-process.ts`, never imported.
 *
 * The whole file is glue: it waits for a `start`, calls the same
 * `reviewPullRequest` the server used to call directly, and reports back. Nothing
 * about a review changes by running here — that is the point. The two dependencies
 * it cannot satisfy locally are wired to the parent instead:
 *
 *  - `token` is handed over in the start message. This process never holds the
 *    App's private key, so a hostile repository that somehow got code running here
 *    finds one repository's short-lived token and not the App's identity.
 *  - `publish` is a round trip. The page store and the webhook secret its signed
 *    URLs are keyed on live with the HTTP server, and a page is only useful to the
 *    process that will serve it.
 *
 * Deliberately no `graft` state of its own: no lock, no cache directory, no
 * telemetry. A review works on a throwaway clone in /tmp and takes its findings
 * with it when it exits.
 */
import { reviewPullRequest } from "./review.js";
import type { Fetch } from "./identity.js";
import type { FromChild, StartMessage, ToChild } from "./review-process.js";

/** Publish requests waiting on the parent, by sequence number. */
const awaiting = new Map<number, (url: string | null) => void>();
let seq = 0;

/** Fire and forget. `process.send` throws on a closed channel, and a log line is
 * not worth crashing a review over — the `disconnect` handler below has already
 * decided what a closed channel means. */
const send = (msg: FromChild): void => {
  if (!process.connected) return;
  try {
    process.send?.(msg);
  } catch {
    /* parent went away mid-review */
  }
};

/** Close the channel, or leave if it is already gone. Either way this is the end of
 * the process — see the `disconnect` handler below. */
function bye(): void {
  try {
    if (process.connected) process.disconnect?.();
    else process.exit(0);
  } catch {
    process.exit(0);
  }
}

/**
 * The last word, then close the channel.
 *
 * Sent with a callback because that callback is the flush: `done` has to be on the
 * wire before the channel closes, or the parent sees a process that exited without
 * reporting and turns a finished review into a failure.
 */
function finish(msg: FromChild): void {
  if (!process.connected) return bye();
  try {
    process.send?.(msg, () => bye());
  } catch {
    bye();
  }
}

async function run(start: StartMessage): Promise<void> {
  try {
    const result = await reviewPullRequest(start.job, {
      token: async () => start.token,
      fetch: globalThis.fetch as unknown as Fetch,
      api: start.api,
      publish: (_job, html) =>
        new Promise<string | null>((resolve) => {
          const id = (seq += 1);
          awaiting.set(id, resolve);
          send({ t: "publish", seq: id, html });
        }),
      log: (msg) => send({ t: "log", msg }),
    });
    finish({ t: "done", result });
  } catch (err) {
    // `reviewPullRequest` has already run the token through `redact`, so this
    // message is safe to put in the parent's log — which is where it is going.
    finish({ t: "failed", message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * No parent, no point.
 *
 * A review whose channel has closed has nowhere to publish a page and nobody to
 * report to. If the server process died, nothing will SIGKILL this one either, and
 * without this it would sit in a clone for the rest of the parent's 15-minute
 * ceiling. Going now leaves the same throwaway tree behind that a SIGKILL would —
 * what it does not do is spend a quarter of an hour producing a review no one can
 * receive.
 */
process.on("disconnect", () => process.exit(0));

process.on("message", (raw) => {
  const msg = raw as ToChild;
  if (msg.t === "start") {
    void run(msg);
    return;
  }
  awaiting.get(msg.seq)?.(msg.url);
  awaiting.delete(msg.seq);
});
