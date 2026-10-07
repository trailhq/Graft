/**
 * Keeps Trail's copy of this person's notes and skills in step with ~/.trail.
 *
 * `trail login` uploads everything once. After that, `trail note`, `trail
 * learn` and `trail skills` change them, so any command that might have
 * changed them compares a fingerprint with the last one uploaded and, when
 * they differ, re-uploads in a detached child. Nothing waits on it: a search
 * answered from a slightly older index is still a good answer.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readLink, type BrainLink } from "../brain/link.js";
import { repoSlugFromGit } from "../brain/push.js";
import { graftCliPath } from "../claude/paths.js";
import { cacheDir, readJson, writeJsonAtomic } from "../util/state.js";
import { indexFingerprint, indexPayload, isError, uploadIndex, type ApiError, type IndexResult } from "./trail-api.js";
import { keepsNotes } from "../notes/home.js";

interface IndexState {
  fingerprint: string;
  at: number;
  /** When the last upload failed; cleared by the next one that succeeds. */
  failedAt?: number;
  workspace?: string;
  notes?: number;
  skills?: number;
}

/** A failed upload is retried after this long, not on every command. */
const RETRY_MS = 10 * 60 * 1000;

function statePath(repo: string): string {
  return join(cacheDir(repo), "trail-index.json");
}

export function readIndexState(repo: string): IndexState | null {
  return readJson<IndexState>(statePath(repo));
}

/** Upload the notes and skills now and remember what was sent. */
export async function syncIndex(repo: string, link: BrainLink, fetchImpl?: typeof fetch): Promise<IndexResult | ApiError> {
  const slug = repoSlugFromGit(repo);
  const payload = indexPayload(repo, slug ? `${slug.owner}/${slug.name}` : undefined);
  const res = await uploadIndex(link, payload, fetchImpl);
  if (!isError(res)) {
    writeJsonAtomic(statePath(repo), { fingerprint: indexFingerprint(payload), at: Date.now(), workspace: res.workspace, notes: res.notes, skills: res.skills }, true);
  } else {
    // Remember the attempt so a down Trail isn't retried by every command.
    const prior = readIndexState(repo);
    writeJsonAtomic(statePath(repo), { ...(prior ?? { fingerprint: "", at: 0 }), failedAt: Date.now() }, true);
  }
  return res;
}

/** Whether Trail's copy is behind the notes and skills, and a retry is due. */
export function indexIsBehind(repo: string, now = Date.now()): boolean {
  const state = readIndexState(repo);
  const fp = indexFingerprint(indexPayload(repo));
  if (state?.fingerprint === fp) return false;
  return !state?.failedAt || now - state.failedAt >= RETRY_MS;
}

/**
 * Re-upload in the background when the repo is linked, keeps notes, and its
 * notes or skills changed since the last upload. Never waits, never throws.
 */
export function maybeIndexInBackground(repo: string, now = Date.now()): boolean {
  try {
    if (!keepsNotes(repo) || !readLink(repo) || !indexIsBehind(repo, now)) return false;
    // Marked first, so commands run while the child works don't start another.
    const prior = readIndexState(repo);
    writeJsonAtomic(statePath(repo), { ...(prior ?? { fingerprint: "", at: 0 }), failedAt: now }, true);
    const child = spawn(process.execPath, [graftCliPath(), "_trail-index", repo], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
