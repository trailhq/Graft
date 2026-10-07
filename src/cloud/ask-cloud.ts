/**
 * Ranked note search for `ask`, once a repo is linked to Trail.
 *
 * The local match (notes/ask-notes.ts) reads this machine's notes, every
 * word and file, which is right for a few dozen and starts to miss things in
 * the hundreds. Linked, the same query also goes to Trail, which ranks every
 * note the team has shared; its answers come first and the local ones fill
 * in. Unlinked, a repo with that many notes gets one line saying so, at most
 * once a day.
 */
import { basename, join } from "node:path";
import type { AskResult } from "../ask/ask.js";
import { readLink } from "../brain/link.js";
import { brand } from "../brand.js";
import { noteCount } from "../notes/home.js";
import { noteAuthor } from "../notes/git-facts.js";
import type { Note, NoteHit } from "../notes/notes.js";
import { currentTranscript } from "../notes/session-cost.js";
import { cacheDir, readJson, writeJsonAtomic } from "../util/state.js";
import { isError, searchNotes, type RemoteNote } from "./trail-api.js";
import { maybeIndexInBackground } from "./sync.js";

/** Past this many notes, local matching is worth a word about ranked search. */
export const MANY_NOTES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

function asNote(n: RemoteNote): Note {
  const minutes = n.minutes ?? undefined;
  const tokens = n.tokens ?? undefined;
  return {
    path: n.path,
    title: n.title,
    author: n.author,
    date: n.date,
    branch: n.branch,
    cost: minutes !== undefined || tokens !== undefined ? { minutes, tokens } : undefined,
    touches: n.touches ?? [],
    body: n.body,
  };
}

function pointerFile(pointer: string): string {
  return pointer.replace(/:L\d+(-L?\d+)?$/, "");
}

/** The once-a-day line for a repo with many notes that isn't linked, or null. */
function manyNotesHint(repo: string, total: number, now: number): string | null {
  if (total < MANY_NOTES) return null;
  const path = join(cacheDir(repo), "trail-hint.json");
  const last = readJson<{ shownAt?: number }>(path)?.shownAt ?? 0;
  if (now - last < DAY_MS) return null;
  try {
    writeJsonAtomic(path, { shownAt: now }, true);
  } catch {
    /* shown again next time */
  }
  return (
    `· you have ${total} notes on this repo now. local search matches their words and files and may have missed some. ` +
    `${brand() === "trail" ? "trail login" : "graft trail push"} ranks them, with your team's`
  );
}

/**
 * Add Trail's ranked notes to an answer, in place. Only for a repo that keeps
 * notes; a slow or unreachable Trail leaves the local notes as they were.
 */
export async function withRankedNotes(r: AskResult, repo: string, now = Date.now()): Promise<AskResult> {
  if (!r.notesChecked) return r;
  const link = readLink(repo);
  if (!link) {
    const hint = manyNotesHint(repo, noteCount(repo), now);
    if (hint) r.notesHint = hint;
    return r;
  }
  maybeIndexInBackground(repo, now);
  const asker = noteAuthor(repo);
  const transcript = currentTranscript(repo);
  const session = transcript ? basename(transcript, ".jsonl") : `${asker}-${new Date(now).toISOString().slice(0, 10)}`;
  const res = await searchNotes(link, { query: r.query, files: r.hits.map((h) => pointerFile(h.pointer)), limit: 3, asker, session });
  if (isError(res)) return r;
  const remote: NoteHit[] = res.notes.map((n) => ({ note: asNote(n), score: n.score, shared: [] }));
  // One note, whether Trail sent it back or it's on this machine: same file name.
  const seen = new Set(remote.map((h) => basename(h.note.path)));
  const merged = [...remote, ...(r.notes ?? []).filter((h) => !seen.has(basename(h.note.path)))].slice(0, 2);
  if (merged.length) r.notes = merged;
  r.notesRanked = true;
  return r;
}
