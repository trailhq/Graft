/**
 * What arrived, and whether it is worth work.
 *
 * A busy installation delivers a lot of noise — labels, assignments, reviews —
 * and every accepted delivery costs a clone and a parse. Narrowing happens here,
 * once, so the queue only ever holds jobs that will produce a comment.
 */

/** The subset of a `pull_request` delivery this App reads. */
export interface ReviewJob {
  installationId: number;
  owner: string;
  repo: string;
  /** Base repository's full name, which is where the comment goes — a fork PR
   * carries a different head repo, and posting there would be posting on the
   * contributor's copy. */
  number: number;
  baseRef: string;
  headSha: string;
  /** True when the head branch lives in a fork: the PR's code is not ours. */
  fromFork: boolean;
}

interface RawPullRequest {
  action?: string;
  number?: number;
  installation?: { id?: number };
  repository?: { name?: string; owner?: { login?: string }; full_name?: string };
  pull_request?: {
    number?: number;
    draft?: boolean;
    state?: string;
    base?: { ref?: string; repo?: { full_name?: string } };
    head?: { sha?: string; repo?: { full_name?: string } };
  };
}

/** Actions that change the diff. `edited` (a retitled PR) and `labeled` do not. */
const ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/**
 * A delivery to act on, or null with the reason it was skipped.
 *
 * Draft pull requests are skipped deliberately: a draft is a work in progress and
 * a bot commenting on every push to one is the fastest way to be uninstalled.
 * `ready_for_review` is in the accepted set so the comment appears the moment the
 * author asks for eyes.
 *
 * A CLOSED pull request is not skipped. The graph is most useful to whoever reads
 * the PR later, and a merged PR is exactly what gets read — so the comment has to
 * keep working after the merge. This costs nothing on live traffic: none of the
 * four accepted actions fire on an already-merged PR, so in practice this only
 * admits a `synchronize` that raced a merge, and a deliberate re-delivery. The
 * accepted-action set, not the PR state, is what bounds the work.
 */
export function reviewJobFor(event: string, payload: unknown): { job: ReviewJob } | { skip: string } {
  if (event === "ping") return { skip: "ping" };
  if (event !== "pull_request") return { skip: `event ${event}` };

  const p = payload as RawPullRequest;
  const action = p.action ?? "";
  if (!ACTIONS.has(action)) return { skip: `action ${action}` };

  const pr = p.pull_request;
  const installationId = p.installation?.id;
  const owner = p.repository?.owner?.login;
  const repo = p.repository?.name;
  const number = pr?.number ?? p.number;
  const baseRef = pr?.base?.ref;
  const headSha = pr?.head?.sha;

  if (!installationId || !owner || !repo || !number || !baseRef || !headSha) {
    return { skip: "payload missing installation, repository or pull request fields" };
  }
  if (pr?.draft === true && action !== "ready_for_review") return { skip: "draft" };

  const base = pr?.base?.repo?.full_name;
  const head = pr?.head?.repo?.full_name;
  return {
    job: {
      installationId,
      owner,
      repo,
      number,
      baseRef,
      headSha,
      // A missing head repo means a deleted fork — treat it as one, since it is
      // certainly not ours.
      fromFork: head !== base,
    },
  };
}

/** Collapse queued work per pull request: only the newest push is worth reviewing. */
export const jobKey = (j: ReviewJob): string => `${j.owner}/${j.repo}#${j.number}`;
