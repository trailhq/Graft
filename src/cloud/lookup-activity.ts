/**
 * What a code lookup tells the workspace: the learnings it showed (a use) and
 * the tokens the map saved against reading the files whole. Shared by the CLI's
 * `ask` and the MCP `graft_find_code`, so both report the same event.
 */
import { askSavedTokens, type AskResult } from "../ask/ask.js";
import { repoPlace } from "../notes/home.js";
import { noteAuthor } from "../notes/git-facts.js";
import { noteName } from "../notes/notes.js";
import { sessionKey } from "./nudge.js";
import { cloudForRepo, type Cloud } from "./workspace.js";
import { recordActivity, records } from "./workspace-sync.js";

/** The file part of a hit's `file:Lx-Ly` pointer. */
function pointerFile(pointer: string): string {
  return pointer.replace(/:L\d+(-L?\d+)?$/, "");
}

/**
 * Queue one search event for `r`, when it showed a learning or saved tokens.
 * Uses are counted from the learnings shown only; `saved_tokens` rides along.
 * A count of the files, never the query or the paths: for the prompt hook the
 * query is the person's prompt. Only learnings the workspace gets are named:
 * a personal one's file name carries its title. `savedTokens` is the saving
 * from a pack the caller already rendered (see formatAskWithSaved), so the
 * lookup isn't rendered a second time. Never throws.
 */
export function recordLookup(r: AskResult, repo: string, cloud?: Cloud | null, savedTokens?: number): void {
  try {
    // Cheapest checks first: most lookups are on a machine that isn't connected,
    // or in a repo outside the workspace, and must cost nothing here.
    const key = repoPlace(repo).key;
    // Unless told, the workspace this machine sends the repo to.
    const to = cloud === undefined ? cloudForRepo(key) : cloud;
    if (!records(to, key)) return;
    const shown = (r.notes ?? []).filter((h) => h.note.scope !== "personal");
    const saved = savedTokens ?? askSavedTokens(r);
    if (!shown.length && saved <= 0) return;
    const me = noteAuthor(repo);
    // A lookup that showed no learning leaves with its savings only.
    const used = shown.length > 0;
    recordActivity(
      {
        repo: key,
        kind: "search",
        asker: me,
        session: sessionKey(repo) ?? `${me}-${new Date().toISOString().slice(0, 10)}`,
        file_count: used ? new Set(r.hits.map((h) => pointerFile(h.pointer))).size : 0,
        shown_paths: shown.map((h) => noteName(h.note)),
        shown_authors: shown.map((h) => h.note.author),
        ...(saved > 0 ? { saved_tokens: saved } : {}),
        at: new Date().toISOString(),
      },
      to,
    );
  } catch {
    /* a lost event undercounts by one */
  }
}
