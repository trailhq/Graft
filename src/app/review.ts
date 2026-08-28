/**
 * One pull request, reviewed.
 *
 * Checkout → graph → blast radius → comment, with the page handed to whatever
 * the caller uses to publish it. Everything runs in-process against the same
 * functions the CLI calls, which is what keeps the App's comment and `graft
 * blast` on a laptop from drifting apart — and means the PR's own package.json
 * is never installed or run.
 */
import { blastRadiusIn } from "../blast/blast.js";
import { changedFiles } from "../blast/diff.js";
import { markdownReport } from "../blast/render.js";
import { blastVizGraph } from "../blast/viz.js";
import { buildGraph } from "../graph/build.js";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import { checkoutPullRequest, redact } from "./checkout.js";
import type { ReviewJob } from "./events.js";
import type { Fetch } from "./identity.js";

/** Hidden marker: how the App finds the comment it owns, on every later push. */
export const MARKER = "<!-- graft-blast-radius -->";

const DEPTH = 2;

export interface ReviewDeps {
  token: (installationId: number) => Promise<string>;
  fetch: Fetch;
  api?: string;
  /** Somewhere to put the viewer page; returns the URL to link. Optional: the
   * comment is useful on its own, and a page that fails to publish must not cost
   * the review. */
  publish?: (job: ReviewJob, html: string) => Promise<string | null>;
  log?: (msg: string) => void;
}

export interface ReviewResult {
  /** `null` when the diff had nothing indexed to say. */
  commentUrl: string | null;
  areas: number;
  affected: number;
  viewerUrl: string | null;
}

export async function reviewPullRequest(job: ReviewJob, deps: ReviewDeps): Promise<ReviewResult> {
  const log = deps.log ?? (() => {});
  const token = await deps.token(job.installationId);
  const checkout = checkoutPullRequest({ owner: job.owner, repo: job.repo, number: job.number, baseRef: job.baseRef, token });

  try {
    log(`${job.owner}/${job.repo}#${job.number}: building`);
    await buildGraph(checkout.dir);

    const contextDir = contextDirFor(checkout.dir);
    const graph = loadGraphCached(contextDir);
    if (!graph) throw new Error("build produced no graph");

    const diff = changedFiles(checkout.dir, checkout.base);
    if (!diff) throw new Error(`no diff against ${job.baseRef}`);

    const report = blastRadiusIn(graph, contextDir, diff.files, diff.basis, DEPTH);

    // Same two passes `graft blast --name` runs, in the same order: a reviewer's
    // reason cites area labels, and naming is what gives an area its final one.
    // Both are best-effort — without GRAFT_API_KEY the areas keep their symbol
    // names and the comment still goes out.
    const { nameReport } = await import("../blast/name.js");
    const { note } = await nameReport(graph, report, contextDir);
    if (note) log(`${job.owner}/${job.repo}#${job.number}: ${note}`);

    const { attachOwners, diffAuthors } = await import("../blast/owners.js");
    attachOwners(checkout.dir, report, { exclude: diffAuthors(checkout.dir, checkout.base) });

    // NOTE: once #180 lands, pass `{ root: checkout.dir }` so the collapsed list
    // quotes the reaching line here too. It is additive, and the App works without it.
    let body = `${MARKER}\n${markdownReport(report)}`;

    let viewerUrl: string | null = null;
    if (deps.publish) {
      const html = await exportPage(report, contextDir, checkout.dir, job);
      viewerUrl = html ? await deps.publish(job, html) : null;
      if (viewerUrl) {
        body += `\n[**Open the interactive graph →**](${viewerUrl}) — click an area to see the code that changed, and the line that reaches it.\n`;
      }
    }

    const commentUrl = await upsertComment(job, body, token, deps);
    return { commentUrl, areas: report.areas.length, affected: report.modules.length, viewerUrl };
  } catch (err) {
    // The token is in git's error text on a permissions failure, and this string
    // is about to be logged.
    throw new Error(redact(err instanceof Error ? err.message : String(err), token));
  } finally {
    checkout.cleanup();
  }
}

/** The self-contained viewer page for this radius, or null if it cannot be made. */
async function exportPage(
  report: ReturnType<typeof blastRadiusIn>,
  contextDir: string,
  root: string,
  job: ReviewJob,
): Promise<string | null> {
  const { exportViz } = await import("../viz/export.js");
  const { fileURLToPath } = await import("node:url");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const out = mkdtempSync(join(tmpdir(), "graft-page-"));
  try {
    const res = exportViz({
      contextDir,
      viewerDir: fileURLToPath(new URL("../viewer/", import.meta.url)),
      outDir: out,
      repoName: job.repo,
      subtitle: `PR #${job.number}`,
      contextGraph: blastVizGraph(report, { root }),
      // Context alone: the other tabs are about the repository, and this page is
      // about one pull request.
      tabs: ["context"],
    });
    return readFileSync(res.file, "utf8");
  } catch {
    return null;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * One comment per pull request, edited in place.
 *
 * A new comment on every push turns a busy PR into a wall of stale diagrams, so
 * the marker is searched for first. Listing is paginated because the comment the
 * App owns is not necessarily on page one of a long discussion.
 */
async function upsertComment(job: ReviewJob, body: string, token: string, deps: ReviewDeps): Promise<string | null> {
  const api = (deps.api ?? "https://api.github.com").replace(/\/$/, "");
  const base = `${api}/repos/${job.owner}/${job.repo}/issues/${job.number}/comments`;
  const headers = {
    authorization: `token ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "graft-app",
  };

  const existing = await findComment(base, headers, deps.fetch);
  const res = await deps.fetch(existing ? `${api}/repos/${job.owner}/${job.repo}/issues/comments/${existing}` : base, {
    method: existing ? "PATCH" : "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`comment failed: ${res.status} ${text.slice(0, 200)}`);
  return (JSON.parse(text) as { html_url?: string }).html_url ?? null;
}

async function findComment(base: string, headers: Record<string, string>, fetchImpl: Fetch): Promise<number | null> {
  for (let page = 1; page <= 10; page += 1) {
    const res = await fetchImpl(`${base}?per_page=100&page=${page}`, { headers });
    if (!res.ok) return null;
    const items = JSON.parse(await res.text()) as Array<{ id: number; body?: string }>;
    const mine = items.find((c) => c.body?.startsWith(MARKER));
    if (mine) return mine.id;
    if (items.length < 100) return null;
  }
  return null;
}
