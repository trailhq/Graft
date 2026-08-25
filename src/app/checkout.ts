/**
 * Getting a pull request's code onto disk without running any of it.
 *
 * On a fork PR every byte here was written by a stranger, and this service holds
 * an installation token for the base repository. So the rules are absolute:
 *
 *  - **Nothing is executed.** No `npm install`, no build, no hooks. The graph is
 *    produced by tree-sitter reading source text, which runs none of it.
 *  - **Git is told not to run things either.** A repository can carry hooks, and
 *    `core.hooksPath` is a per-repo config a clone would otherwise honour; both
 *    are disabled explicitly rather than assumed absent.
 *  - **The token never lands in the repo.** It is passed per-invocation through
 *    an http header config, not baked into a remote URL that `git remote -v`,
 *    the reflog and any submodule would carry.
 *  - **Bounded.** A hostile or merely enormous repository must not hold a worker
 *    forever: every git call has a timeout, and the fetch is shallow.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Enough history for a merge base against the pull request's base branch. */
const FETCH_DEPTH = 50;
const GIT_TIMEOUT_MS = 120_000;

export interface CheckoutRequest {
  owner: string;
  repo: string;
  number: number;
  baseRef: string;
  token: string;
  api?: string;
}

export interface Checkout {
  /** Working tree at the pull request's merge commit. */
  dir: string;
  /** What `blast --base` should diff against. */
  base: string;
  /** Removes the tree. Always call it — the token's clone is not something to
   * leave in /tmp. */
  cleanup: () => void;
}

/** A git invocation with the dangerous parts of the environment removed. */
function git(dir: string, args: string[], token?: string): { ok: boolean; err: string } {
  const auth = token
    ? [
        "-c",
        // Basic auth with the token as the password, per GitHub's own guidance for
        // installation tokens. Passed as an argument to THIS call so it is never
        // written into .git/config.
        `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      ]
    : [];
  const res = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.version=2", ...auth, ...args],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // No credential prompts, no system config, no repo-supplied helpers.
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ASKPASS: "",
        HOME: dir,
      },
    },
  );
  return { ok: res.status === 0, err: `${res.stderr ?? ""}${res.error ? ` ${res.error.message}` : ""}`.trim() };
}

/**
 * Fetch the PR's merge ref and its base, shallow.
 *
 * `refs/pull/N/merge` is GitHub's own merge of the PR into its base — the same
 * thing the checks see, and the right thing to review: it is what will land, not
 * what the contributor's branch says in isolation.
 */
export function checkoutPullRequest(req: CheckoutRequest): Checkout {
  const host = (req.api ?? "https://github.com").replace(/\/$/, "");
  const dir = mkdtempSync(join(tmpdir(), `graft-app-${req.owner}-${req.repo}-`));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });

  const steps: Array<[string, string[]]> = [
    ["init", ["init", "--quiet", "-b", "__graft_base"]],
    ["remote", ["remote", "add", "origin", `${host}/${req.owner}/${req.repo}.git`]],
    // Both refs in one fetch: the merge ref to review, the base to diff against.
    [
      "fetch",
      [
        "fetch",
        "--quiet",
        `--depth=${FETCH_DEPTH}`,
        "--no-recurse-submodules",
        "origin",
        `+refs/pull/${req.number}/merge:refs/graft/merge`,
        `+refs/heads/${req.baseRef}:refs/graft/base`,
      ],
    ],
    ["checkout", ["checkout", "--quiet", "--detach", "refs/graft/merge"]],
  ];

  for (const [name, args] of steps) {
    const { ok, err } = git(dir, args, name === "fetch" ? req.token : undefined);
    if (!ok) {
      cleanup();
      // A merge ref is absent while GitHub is still computing mergeability, and
      // present-but-stale right after a push — worth saying which step failed so
      // that case is distinguishable from a permissions problem.
      throw new Error(`checkout ${req.owner}/${req.repo}#${req.number} failed at ${name}: ${redact(err, req.token)}`);
    }
  }

  return { dir, base: "refs/graft/base", cleanup };
}

/** Never let a token reach a log line, even inside git's own error text. */
export function redact(text: string, token: string): string {
  if (!token) return text;
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("[token]").split(encoded).join("[token]");
}
