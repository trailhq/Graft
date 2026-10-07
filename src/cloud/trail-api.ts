/**
 * The Trail cloud side of notes and skills: what turns on after `trail login`.
 *
 * Locally, notes and skills are plain files in ~/.trail that `ask` searches
 * itself, and nobody else sees them. Once a repo is linked to Trail (the same
 * brain link and token `trail push` and `trail pull` use), they are uploaded,
 * which is how they reach the team: search ranks everyone's notes together,
 * `trail team` shows what the team did this week, and `trail check` holds a
 * diff up against everything the team has learned. The server is Trail's
 * (app.trailhq.com) or a team's own self-hosted one: whichever the link
 * points at.
 *
 * Every call is bounded and never throws: a failure comes back as
 * `{ error }`, so the local answer still prints when Trail is unreachable.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { baseUrlFor, type BrainLink } from "../brain/link.js";
import { noteAuthor } from "../notes/git-facts.js";
import { repoPlace, uploaderId } from "../notes/home.js";
import { listNotes } from "../notes/notes.js";
import { listSkills } from "../skills/skills.js";

type Fetch = typeof fetch;

export interface ApiError {
  error: string;
  /** HTTP status, when the server answered at all. */
  status?: number;
}

function endpoint(link: BrainLink, path: string): string {
  return `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/trail/${path}`;
}

async function call<T>(
  link: BrainLink,
  method: "GET" | "POST" | "PUT",
  path: string,
  body: unknown,
  opts: { timeoutMs?: number; fetchImpl?: Fetch } = {},
): Promise<T | ApiError> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(endpoint(link, path), {
      method,
      headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json", accept: "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = (json as { error?: unknown } | null)?.error;
      return { error: typeof msg === "string" ? msg : `Trail answered ${res.status}`, status: res.status };
    }
    return json as T;
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { error: timedOut ? "Trail didn't answer in time" : "couldn't reach Trail" };
  }
}

export function isError(x: unknown): x is ApiError {
  return typeof x === "object" && x !== null && typeof (x as ApiError).error === "string";
}

/** A 404 from an older Trail that doesn't have these endpoints yet. */
export function notSupported(e: ApiError): boolean {
  return e.status === 404 || e.status === 405;
}

/* -------------------------------------------------------------------------- */
/* index: upload the repo's notes and skills                                  */
/* -------------------------------------------------------------------------- */

export interface IndexPayload {
  repo?: string;
  /** This machine's random id (`~/.trail/id`): the server replaces this uploader's notes, never a teammate's. */
  uploader: string;
  /** The uploader's name as their notes carry it. */
  author: string;
  /** `notes` is every note this uploader has for the repo, so a deleted one leaves the index. */
  complete: true;
  notes: Array<{
    /** `notes/<file>`: where it is under the repo's folder in ~/.trail, never a path on this machine. */
    path: string;
    title: string;
    author: string;
    date: string;
    branch?: string;
    minutes?: number;
    tokens?: number;
    touches: string[];
    body: string;
    hash: string;
  }>;
  skills: Array<{
    name: string;
    description: string;
    version: number;
    /** `repo`: the team's, committed in `.claude/skills/`. `home`: this uploader's own. */
    where: "repo" | "home";
    body: string;
    takeaways: Array<{ path: string; taught_by: string; date: string; confirmed_by: string[]; folded: boolean; text: string }>;
  }>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * This repo's notes and skills from ~/.trail, as the index endpoint takes
 * them: the full set, so a deleted note leaves the index too. Touches are
 * relative to the top of the checkout; no path on this machine is sent.
 */
export function indexPayload(repo: string, slug?: string): IndexPayload {
  const place = repoPlace(repo);
  const notes = listNotes(place.checkout, { children: false }).map((n) => {
    let text = "";
    try {
      text = readFileSync(n.path, "utf8");
    } catch {
      /* listed a moment ago; hash what we have */
    }
    return {
      path: `notes/${basename(n.path)}`,
      title: n.title,
      author: n.author,
      date: n.date,
      branch: n.branch,
      minutes: n.cost?.minutes,
      tokens: n.cost?.tokens,
      touches: n.touches,
      body: n.body,
      hash: sha256(text || n.body),
    };
  });
  const skills = listSkills(repo).map((s) => ({
    name: s.name,
    description: s.description,
    version: s.version,
    where: s.where,
    body: s.body,
    takeaways: s.takeaways.map((t) => ({
      path: `skills/${s.name}/takeaways/${basename(t.path)}`,
      taught_by: t.taughtBy,
      date: t.date,
      confirmed_by: t.confirmedBy,
      folded: t.foldedIn !== undefined,
      text: t.text,
    })),
  }));
  return { repo: slug, uploader: uploaderId(), author: noteAuthor(place.checkout), complete: true, notes, skills };
}

/** What the notes and skills look like right now, to tell whether the index is behind. */
export function indexFingerprint(payload: IndexPayload): string {
  return sha256(
    JSON.stringify([payload.notes.map((n) => [n.path, n.hash]), payload.skills.map((s) => [s.name, s.version, s.takeaways.length, s.takeaways.filter((t) => t.folded).length])]),
  );
}

export interface IndexResult {
  workspace: string;
  repo: string;
  notes: number;
  skills: number;
}

export function uploadIndex(link: BrainLink, payload: IndexPayload, fetchImpl?: Fetch): Promise<IndexResult | ApiError> {
  return call<IndexResult>(link, "PUT", "index", payload, { timeoutMs: 60_000, fetchImpl });
}

/* -------------------------------------------------------------------------- */
/* ranked search                                                              */
/* -------------------------------------------------------------------------- */

export interface RemoteNote {
  path: string;
  title: string;
  author: string;
  date: string;
  branch?: string;
  minutes?: number | null;
  tokens?: number | null;
  touches: string[];
  body: string;
  score: number;
}

export interface SearchResult {
  total: number;
  notes: RemoteNote[];
}

export function searchNotes(
  link: BrainLink,
  q: { query: string; files: string[]; limit?: number; asker?: string; session?: string },
  fetchImpl?: Fetch,
): Promise<SearchResult | ApiError> {
  // Short: this sits inside an agent's ask. A slow Trail falls back to the local notes.
  return call<SearchResult>(link, "POST", "search", q, { timeoutMs: 2_500, fetchImpl });
}

/* -------------------------------------------------------------------------- */
/* the team view                                                              */
/* -------------------------------------------------------------------------- */

export interface TeamView {
  repo: string;
  days: number;
  people: number;
  sessions: number;
  new_notes: number;
  members: Array<{ name: string; topics: string[]; notes: number; reused: number }>;
  overlaps: Array<{ kind: string; text: string }>;
  url?: string;
}

export function fetchTeam(link: BrainLink, days = 7, fetchImpl?: Fetch): Promise<TeamView | ApiError> {
  return call<TeamView>(link, "GET", `team?days=${days}`, undefined, { fetchImpl });
}

/* -------------------------------------------------------------------------- */
/* check a diff                                                               */
/* -------------------------------------------------------------------------- */

export interface CheckFinding {
  file: string;
  line?: number;
  verdict: "conflict" | "follows";
  summary: string;
  source: { kind: string; title?: string; author?: string; date?: string; path?: string; quote?: string; name?: string; version?: number };
}

export interface CheckResult {
  files: number;
  notes: number;
  skills: number;
  findings: CheckFinding[];
}

export function checkDiff(
  link: BrainLink,
  req: { base: string; diff: string; files: string[]; asker?: string },
  fetchImpl?: Fetch,
): Promise<CheckResult | ApiError> {
  return call<CheckResult>(link, "POST", "check", req, { timeoutMs: 120_000, fetchImpl });
}
