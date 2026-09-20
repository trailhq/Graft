/**
 * Building a brain from the repository already on this machine.
 *
 * The server path needs graft's GitHub App installed on the repo, which is an
 * admin action on someone else's org and the first thing asked of a person who
 * has not seen a single rule yet. For a private repository it is often simply
 * unavailable.
 *
 * This is the way round that: the clone is already here, and the user is
 * already authenticated to GitHub for their own work. So read it locally and
 * send up the same digest the server would have built.
 *
 * What leaves the machine is what people wrote — commit messages, pull-request
 * comments, the docs and config already in the tree — plus symbol ids and
 * hashes. No file contents, no diffs, no source.
 */
import { spawnSync } from "node:child_process";
import {
  buildDigest,
  readCommits,
  readSymbols,
  readThreads,
  type RepoDigest,
} from "../app/history.js";
import {
  budgetSources,
  readAgentInstructions,
  readBranchProtection,
  readCodeowners,
  readCodifiedRules,
  readDecisionDocs,
  readDeclinedIssues,
  readReverts,
  readTestNames,
} from "../app/sources.js";
import type { GraphV1 } from "../graph/types.js";
import { baseUrlFor, type BrainLink } from "./link.js";

/** What a local ingest read, for the caller to print. */
export interface PushResult {
  jobId: string;
  repo: string;
  commits: number;
  threads: number;
  symbols: number;
  sources: number;
  /** Set when discussion could not be read; the ingest still went ahead. */
  warning?: string;
}

function git(root: string, args: string[]): string | null {
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout.trim();
}

/**
 * owner/name for this checkout, from its origin remote.
 *
 * Only GitHub, because the discussion reader and the forge links are
 * GitHub-shaped; another forge would need its own reader, not a looser regex
 * here that produces links to nowhere.
 */
export function repoSlugFromGit(root: string): { owner: string; name: string } | null {
  const url = git(root, ["remote", "get-url", "origin"]);
  if (!url) return null;
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

/** The branch to attribute the ingest to. */
function currentBranch(root: string): string {
  const head = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return head && head !== "HEAD" ? head : "";
}

/**
 * A GitHub token from wherever the user already keeps one.
 *
 * `gh auth token` first, because anyone who works with private repositories on
 * the command line has it and it needs no setup at all. The env vars are the
 * CI path. Absent, the ingest still runs on commits alone — pull-request
 * discussion is the richest source, not a required one.
 */
export function githubToken(): string | null {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  const res = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const out = typeof res.stdout === "string" ? res.stdout.trim() : "";
  return res.status === 0 && out ? out : null;
}

/** Whether the repository is private, so the digest records it honestly. */
async function isPrivate(owner: string, name: string, token: string | null, fetchImpl: typeof fetch): Promise<boolean> {
  if (!token) return true; // unknown counts as private
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${name}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) return true;
    return ((await res.json()) as { private?: boolean }).private !== false;
  } catch {
    return true;
  }
}

/** What the brain is waiting for, when it is waiting for something. */
export interface ExpectedRepo {
  slug: string;
  status: string;
  brainName: string;
}

/**
 * The repository this brain expects, or null when it expects none.
 *
 * The website records it when the user chooses the local route, so this is how
 * the CLI knows whether the directory it is standing in is the one they asked
 * for. Mining the wrong repo into a brain is silent and very hard to notice
 * afterwards — the rules simply describe someone else's codebase — so the round
 * trip is worth it.
 *
 * Null on any failure, which keeps an older brain (or an unreachable one)
 * working exactly as it did before this check existed.
 */
export async function fetchExpectedRepo(link: BrainLink, fetchImpl: typeof fetch = fetch): Promise<ExpectedRepo | null> {
  try {
    const res = await fetchImpl(`${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/repo`, {
      headers: { authorization: `Bearer ${link.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { repo?: { slug?: string; status?: string } | null; brain_name?: string };
    if (!body.repo?.slug) return null;
    return { slug: body.repo.slug, status: String(body.repo.status ?? ""), brainName: String(body.brain_name ?? "") };
  } catch {
    return null;
  }
}

/** Whether two repo slugs name the same repository. GitHub is case-insensitive. */
export function sameRepo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Build the digest for the checkout at `root`. Reads nothing but text. */
export async function buildLocalDigest(
  root: string,
  graph: GraphV1 | null,
  opts: { autoApprove?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ digest: RepoDigest; warning?: string } | { error: string }> {
  const slug = repoSlugFromGit(root);
  if (!slug) {
    return { error: "this directory has no GitHub `origin` remote — graft can only push a GitHub repository today" };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = githubToken();

  const commits = readCommits(root);
  if (commits.length === 0) {
    return { error: "no commits found here — is this a shallow clone with no history?" };
  }
  const symbols = readSymbols(graph);

  let threads: Awaited<ReturnType<typeof readThreads>> = [];
  let warning: string | undefined;
  if (token) {
    try {
      threads = await readThreads(slug.owner, slug.name, token, fetchImpl as never);
    } catch {
      warning = "could not read pull-request discussion; mining commits and repo files only";
    }
  } else {
    warning =
      "no GitHub token found (`gh auth login`, or GH_TOKEN) — mining commits and repo files only, without pull-request discussion";
  }

  const branch = currentBranch(root);
  const sources = budgetSources([
    ...readAgentInstructions(root),
    ...readDecisionDocs(root),
    ...readCodeowners(root),
    ...readCodifiedRules(root),
    ...readReverts(root),
    ...readTestNames(symbols.map((s) => ({ name: s.name, path: s.path }))),
    ...(token ? await readBranchProtection(slug.owner, slug.name, branch, token, fetchImpl as never) : []),
    ...(token ? await readDeclinedIssues(slug.owner, slug.name, token, fetchImpl as never) : []),
  ]);

  const digest = buildDigest({
    owner: slug.owner,
    name: slug.name,
    headSha: git(root, ["rev-parse", "HEAD"]) ?? "",
    defaultBranch: branch,
    isPrivate: await isPrivate(slug.owner, slug.name, token, fetchImpl),
    commits,
    threads,
    symbols,
    sources,
    autoApprove: opts.autoApprove ?? true,
  });
  return { digest, warning };
}

/** Send a digest to the brain and return the job to poll. */
export async function pushDigest(
  link: BrainLink,
  digest: RepoDigest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ jobId: string } | { error: string }> {
  const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/repo`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${link.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(digest),
    });
    const text = await res.text();
    if (!res.ok) return { error: `the brain refused the ingest: ${res.status} ${text.slice(0, 200)}` };
    return { jobId: String((JSON.parse(text) as { job_id?: string }).job_id ?? "") };
  } catch (e) {
    return { error: `could not reach the brain: ${e instanceof Error ? e.message : e}` };
  }
}
