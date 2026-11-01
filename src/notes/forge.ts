/**
 * Git forge abstraction for @detacoop/trail-code fork.
 *
 * Detects the git provider (GitHub, GitLab, Bitbucket, unknown) from the
 * remote URL and exposes a uniform interface for PR/MR operations used by
 * trail init look-back and branch tracking.
 *
 * Adapters normalize their provider's response to the same shape GitHub uses,
 * so the rest of the codebase (reviewedPRs, closedPrHeads) works unchanged.
 */
import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { execFileSync } from "node:child_process";
import { WINHIDE } from "../util/child-process.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForgeKind = "github" | "gitlab" | "bitbucket" | "unknown";

/**
 * Uniform interface over git forges. Each adapter implements the three
 * operations trail needs: check authentication, fetch MR/PR data for the
 * look-back, and list branches for closed-head tracking.
 */
export interface ForgeAdapter {
  readonly kind: ForgeKind;
  /** Returns true when the forge CLI is installed and authenticated. */
  isReady(repo: string): boolean;
  /**
   * Fetches merged and closed MRs/PRs for the repo. Returns data normalised
   * to GitHub's GraphQL shape so `reviewedPRs()` in pr-reviews.ts works
   * without modification. Returns null on any failure.
   */
  fetchReviews(repo: string, timeoutMs: number): Promise<unknown>;
  /**
   * Lists all MRs/PRs (open + merged + closed) normalised to GitHub's
   * `gh pr list --json headRefName,headRefOid,state` shape so
   * `closedPrHeads()` in branches.ts works without modification.
   * Returns the raw string output (JSON array) or throws on failure.
   */
  listBranches(repo: string): string;
}

/** Normalised PR entry matching gh pr list --json output. */
export interface NormalisedPR {
  headRefName?: string;
  headRefOid?: string;
  /** "OPEN" | "MERGED" | "CLOSED" */
  state?: string;
}

// ---------------------------------------------------------------------------
// Forge detection
// ---------------------------------------------------------------------------

/**
 * Detects the git forge from `origin`'s remote URL.
 * Works with both HTTPS and SSH remote formats.
 */
export function detectForge(repo: string): ForgeKind {
  const r = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], {
    ...WINHIDE,
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0) return "unknown";
  const url = (r.stdout ?? "").trim();
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\./i.test(url)) return "gitlab";
  if (/bitbucket\.org/i.test(url)) return "bitbucket";
  return "unknown";
}

/** Extracts `owner/repo` from a remote URL (HTTPS or SSH). */
export function repoFullPath(url: string): string {
  // SSH: git@gitlab.com:owner/repo.git  → owner/repo
  // HTTPS: https://gitlab.com/owner/repo.git → owner/repo
  const m =
    url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/) ??
    url.match(/[:/]([^/]+\/[^/]+)$/);
  return (m?.[1] ?? "").replace(/\.git$/, "");
}

// ---------------------------------------------------------------------------
// GitHub adapter
// ---------------------------------------------------------------------------

/**
 * GitHub adapter: wraps the existing `gh` CLI behaviour extracted from
 * pr-reviews.ts and branches.ts. Behaviour is identical to the pre-refactor
 * code; only the call site changes.
 */
export class GitHubAdapter implements ForgeAdapter {
  readonly kind: ForgeKind = "github";

  isReady(repo: string): boolean {
    const remotes = spawnSync("git", ["-C", repo, "remote", "-v"], {
      ...WINHIDE,
      encoding: "utf8",
      timeout: 5000,
    });
    if (remotes.status !== 0 || !/github/i.test(remotes.stdout)) return false;
    const auth = spawnSync("gh", ["auth", "token"], {
      ...WINHIDE,
      cwd: repo,
      stdio: "ignore",
      timeout: 10_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    return auth.status === 0;
  }

  fetchReviews(repo: string, timeoutMs: number): Promise<unknown> {
    // Inline the GraphQL query — same as the original fetchMergedPRs.
    const MERGED_PRS = 50;
    const CLOSED_PRS = 20;
    const PR_FIELDS = `number title body mergedAt closedAt authorAssociation
      author { login __typename }
      comments(last: 50) { nodes { body author { login __typename } } }
      reviews(last: 20) { nodes { body author { login __typename } } }
      reviewThreads(first: 20) { nodes { isResolved isOutdated path
        comments(first: 10) { nodes { body diffHunk author { login __typename } } } } }`;
    const QUERY = `
      query($owner: String!, $name: String!, $merged: Int!, $closed: Int!) {
        repository(owner: $owner, name: $name) {
          merged: pullRequests(states: MERGED, first: $merged, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }
          closed: pullRequests(states: CLOSED, first: $closed, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }
        }
      }`;
    return new Promise((done) => {
      const args = [
        "api", "graphql",
        "-F", "owner={owner}", "-F", "name={repo}",
        "-F", `merged=${MERGED_PRS}`, "-F", `closed=${CLOSED_PRS}`,
        "-f", `query=${QUERY}`,
      ];
      let child;
      try {
        child = spawn("gh", args, {
          cwd: repo,
          env: { ...process.env, GH_PROMPT_DISABLED: "1" },
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        done(null);
        return;
      }
      let out = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.on("error", () => { clearTimeout(timer); done(null); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return done(null);
        try { done(JSON.parse(out)); } catch { done(null); }
      });
    });
  }

  listBranches(repo: string): string {
    return execFileSync(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName,headRefOid,state"],
      {
        ...WINHIDE,
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// GitLab adapter
// ---------------------------------------------------------------------------

/**
 * GitLab adapter: uses `glab` CLI for authentication check and GraphQL
 * queries. Normalises GitLab's response to GitHub's shape so the existing
 * `reviewedPRs()` and `closedPrHeads()` functions work without modification.
 */
export class GitLabAdapter implements ForgeAdapter {
  readonly kind: ForgeKind = "gitlab";

  isReady(repo: string): boolean {
    const auth = spawnSync("glab", ["auth", "status"], {
      ...WINHIDE,
      cwd: repo,
      stdio: "ignore",
      timeout: 10_000,
    });
    return auth.status === 0;
  }

  fetchReviews(repo: string, timeoutMs: number): Promise<unknown> {
    const MERGED_MRS = 50;
    const CLOSED_MRS = 20;
    const MR_FIELDS = `title description createdAt mergedAt closedAt
      state author { username }
      notes { nodes { body author { username } } }`;
    const QUERY = `
      query($fullPath: ID!, $merged: Int!, $closed: Int!) {
        project(fullPath: $fullPath) {
          merged: mergeRequests(state: merged, first: $merged, sort: UPDATED_DESC) {
            nodes { ${MR_FIELDS} }
          }
          closed: mergeRequests(state: closed, first: $closed, sort: UPDATED_DESC) {
            nodes { ${MR_FIELDS} }
          }
        }
      }`;

    return new Promise((resolve, reject) => {
      // Get remote URL to extract fullPath
      const remoteR = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], {
        ...WINHIDE,
        encoding: "utf8",
        timeout: 5000,
      });
      if (remoteR.status !== 0) { resolve(null); return; }
      const fullPath = repoFullPath((remoteR.stdout ?? "").trim());
      if (!fullPath) { resolve(null); return; }

      const args = [
        "api", "graphql",
        "-f", `query=${QUERY}`,
        "-f", `fullPath=${fullPath}`,
        "-f", `merged=${MERGED_MRS}`,
        "-f", `closed=${CLOSED_MRS}`,
      ];
      let child;
      try {
        child = spawn("glab", args, {
          cwd: repo,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        resolve(null);
        return;
      }
      let out = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) { resolve(null); return; }
        try {
          const raw = JSON.parse(out);
          resolve(this._normalise(raw));
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * Normalises GitLab's GraphQL response to GitHub's `repository.merged/closed`
   * shape so `reviewedPRs()` can process it without modification.
   */
  private _normalise(raw: unknown): unknown {
    const project = (raw as { data?: { project?: Record<string, { nodes?: unknown[] }> } } | null)
      ?.data?.project ?? {};
    const toGhNode = (mr: unknown) => {
      const m = mr as {
        title?: string; description?: string; mergedAt?: string; closedAt?: string;
        state?: string; author?: { username?: string };
        notes?: { nodes?: Array<{ body?: string; author?: { username?: string } }> };
      };
      return {
        number: 0,
        title: m.title,
        body: m.description,
        mergedAt: m.mergedAt,
        closedAt: m.closedAt,
        authorAssociation: "MEMBER",
        author: m.author?.username ? { login: m.author.username, __typename: "User" } : null,
        comments: {
          nodes: (m.notes?.nodes ?? []).map((n) => ({
            body: n.body,
            author: n.author?.username ? { login: n.author.username, __typename: "User" } : null,
          })),
        },
        reviews: { nodes: [] },
        reviewThreads: { nodes: [] },
      };
    };
    const merged = { nodes: (project["merged"]?.nodes ?? []).map(toGhNode) };
    const closed = { nodes: (project["closed"]?.nodes ?? []).map(toGhNode) };
    return { data: { repository: { merged, closed } } };
  }

  listBranches(repo: string): string {
    // glab mr list --json returns an array with different field names.
    // Normalise to GitHub's { headRefName, headRefOid, state } shape.
    let raw: string;
    try {
      raw = execFileSync(
        "glab",
        ["mr", "list", "--state", "all", "--output", "json"],
        {
          ...WINHIDE,
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10_000,
        },
      );
    } catch {
      return "[]";
    }
    try {
      const mrs = JSON.parse(raw) as Array<{
        source_branch?: string;
        sha?: string;
        state?: string;
      }>;
      const normalised: NormalisedPR[] = mrs.map((mr) => ({
        headRefName: mr.source_branch,
        headRefOid: mr.sha,
        // GitLab states: "opened" | "merged" | "closed" → normalise to GitHub: "OPEN" | "MERGED" | "CLOSED"
        state:
          mr.state === "opened" ? "OPEN"
          : mr.state === "merged" ? "MERGED"
          : mr.state === "closed" ? "CLOSED"
          : mr.state?.toUpperCase(),
      }));
      return JSON.stringify(normalised);
    } catch {
      return "[]";
    }
  }
}

// ---------------------------------------------------------------------------
// Unknown / Bitbucket adapter
// ---------------------------------------------------------------------------

/** Adapter for unsupported forges. All operations degrade silently. */
export class UnknownAdapter implements ForgeAdapter {
  constructor(readonly kind: ForgeKind = "unknown") {}
  isReady(_repo: string): boolean { return false; }
  fetchReviews(_repo: string, _timeoutMs: number): Promise<unknown> { return Promise.resolve(null); }
  listBranches(_repo: string): string { return "[]"; }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns the ForgeAdapter for the repo's `origin` remote.
 * Detection is automatic — no configuration required.
 */
export function makeAdapter(repo: string): ForgeAdapter {
  const forge = detectForge(repo);
  switch (forge) {
    case "github":    return new GitHubAdapter();
    case "gitlab":    return new GitLabAdapter();
    case "bitbucket": return new UnknownAdapter("bitbucket");
    default:          return new UnknownAdapter();
  }
}
