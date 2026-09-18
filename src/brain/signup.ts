/**
 * Getting a brain without leaving the terminal.
 *
 * Until now a brain could only begin in the browser. You signed up on Trail, it
 * created the brain, and handed you a `graft init --brain <id>:<token>` line to
 * paste. That is the right way round when the website is where you already are,
 * and the wrong way round when you are standing in a repository with graft
 * already installed — which is where most people meet graft first.
 *
 * So `graft brain push` on an unlinked repo starts here instead of stopping.
 * Graft opens a listener on loopback, sends the browser to Trail carrying the
 * repository it is standing in and the port to answer on, and waits. Trail does
 * the signing up, makes a brain for that repository, and redirects back to the
 * listener with the brain id and its read token. The push then carries on as if
 * the repo had been linked all along.
 *
 * Two things keep that safe. The listener binds to 127.0.0.1, so nothing off
 * this machine can reach it. And it accepts only a handoff echoing the random
 * state it just generated, so some other page the user happens to have open
 * cannot push a brain of its own choosing into their repository.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { BrainLink } from "./link.js";

/** Default web host. Overridden by GRAFT_BRAIN_URL, for staging and self-hosted.
 *
 * Trail's own front end, not the shared `agents.nanonets.com` one that `link.ts`
 * calls for the API. Both are served by the same backend, so either would mint a
 * working token — but this URL is the one a person looks at, and it has to be
 * the Trail-branded build, with Trail's Auth0 redirect behind the signup. */
const DEFAULT_WEB_BASE_URL = "https://app.trailhq.com";

/** How long the listener waits for the browser before giving up. A signup can
 * involve reading an email, so this is minutes rather than seconds. */
export const HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;

/** The one path the listener answers on. */
export const CALLBACK_PATH = "/graft/callback";

/**
 * What the browser sends back, or why it could not be accepted.
 *
 * `error` is the sentence printed to the user and `reason` is the same fact as a
 * category. They are separate because the sentence names the repo and the link,
 * so it can never be the thing telemetry reports — and matching on its text to
 * recover the category would put a user-facing string in a position where
 * rewording it silently changes what gets counted.
 */
export type HandoffFailure = "timed_out" | "bad_callback";
export type HandoffResult = { link: BrainLink } | { error: string; reason: HandoffFailure };

export interface Handoff {
  /** The loopback port Trail must redirect to. */
  port: number;
  /** The nonce Trail must echo back. */
  state: string;
  /** Resolves once the browser answers, or when `timeoutMs` passes. */
  wait(timeoutMs?: number): Promise<HandoffResult>;
  /** Stop listening. Safe to call more than once. */
  close(): void;
}

/** Constant-time compare of two states, length included. */
function sameState(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The page the user is left looking at. Deliberately plain: it exists to say
 * "go back to your terminal", and it is served from a throwaway port that is
 * about to close, so there is nothing to style around. */
function donePage(ok: boolean): string {
  const msg = ok
    ? "Your brain is connected. Return to your terminal — the push is already running."
    : "That handoff did not match this terminal. Run `graft brain push` again.";
  return `<!doctype html><meta charset="utf-8"><title>graft</title><body style="font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:32rem;color:#1F2129"><p>${msg}</p><p style="color:#676767">You can close this tab.</p>`;
}

/**
 * Start listening for the browser's handoff.
 *
 * Port 0 so the OS picks a free one: a fixed port would collide with whatever
 * else the developer is running, and a second graft in another terminal.
 */
export async function startHandoff(): Promise<Handoff> {
  const state = randomBytes(24).toString("base64url");

  let settle: (r: HandoffResult) => void = () => {};
  const answered = new Promise<HandoffResult>((resolve) => {
    settle = resolve;
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    // Checked before anything is read out of the query, so a mismatched handoff
    // never reaches the link-writing path at all.
    if (!sameState(url.searchParams.get("state") ?? "", state)) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(donePage(false));
      return;
    }

    const brainId = (url.searchParams.get("brain") ?? "").trim();
    const token = (url.searchParams.get("token") ?? "").trim();
    if (!brainId || !token) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(donePage(false));
      settle({ error: "the browser came back without a brain id and token", reason: "bad_callback" });
      return;
    }

    // 303 so the browser issues a plain GET, and Location built from
    // GRAFT_BRAIN_URL rather than anything the query carried — the same reason
    // the Trail side builds its callback rather than being told one.
    res.writeHead(303, { location: brainUrl(brainId), "cache-control": "no-store" });
    res.end();
    // No `baseUrl` stored, matching `connect`: GRAFT_BRAIN_URL is read again on
    // every use, so persisting it here would only freeze a host that the env
    // var is already free to move.
    settle({ link: { brainId, token } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeAllListeners("error");
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
  };

  return {
    port,
    state,
    close,
    async wait(timeoutMs = HANDOFF_TIMEOUT_MS): Promise<HandoffResult> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<HandoffResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ error: "timed out waiting for the browser — run `graft brain push` again, or use the link above", reason: "timed_out" }),
          timeoutMs,
        );
        // The timer must not hold the process open once the browser has answered.
        timer.unref?.();
      });
      try {
        return await Promise.race([answered, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        close();
      }
    },
  };
}

/** The Trail front end this machine is pointed at, without a trailing slash.
 *
 * Read at the moment it is needed rather than captured once, matching the rest
 * of the brain code: GRAFT_BRAIN_URL is free to move between calls. */
export function webBaseUrl(baseUrl?: string): string {
  return (process.env.GRAFT_BRAIN_URL || baseUrl || DEFAULT_WEB_BASE_URL).replace(/\/+$/, "");
}

/** Where the browser is sent once the handoff has been accepted.
 *
 * Back into Trail, at the screen that shows the brain being built. The
 * alternative — leaving the person on a local page that says "go back to your
 * terminal" — ends the flow on a blank throwaway served by a port that is about
 * to close, at exactly the moment there is something to watch.
 *
 * NOT `/brain/<id>`, which is where this pointed first. That route redirects to
 * the brain's graph, and the redirect fires the instant the row exists — which
 * is minutes before it has any rules in it. Every terminal signup therefore
 * landed on an empty visualisation of a brain that was, at that moment, being
 * built perfectly well. The build screen is the same wait the browser-first
 * flow shows, and it leads to the graph once there is a graph. */
export function brainUrl(brainId: string, baseUrl?: string): string {
  return `${webBaseUrl(baseUrl)}/get-started?step=build&brain=${encodeURIComponent(brainId)}`;
}

/** Where to send the browser for a repo's brain. */
export function signupUrl(opts: { repo: string; port: number; state: string; baseUrl?: string }): string {
  const base = webBaseUrl(opts.baseUrl);
  const q = new URLSearchParams({
    step: "repo",
    graft_repo: opts.repo,
    graft_port: String(opts.port),
    graft_state: opts.state,
  });
  return `${base}/get-started?${q.toString()}`;
}

/** Open the user's browser, best effort. A machine with no opener is not an
 * error: the URL is printed too, and that is the fallback everywhere.
 *
 * GRAFT_NO_BROWSER leaves the printed URL as the only route, which is what a
 * test wants, and what someone on a machine whose `open` does something
 * surprising wants too. */
export function openBrowser(url: string): void {
  if (process.env.GRAFT_NO_BROWSER) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}
