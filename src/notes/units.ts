/**
 * How a learning reads to a person or an agent. Three units, whatever the
 * file says its kind is:
 *
 *   - a learning: a line Claude follows by default; the person in the moment
 *     can say otherwise. On disk: `decision`, `preference`, and `lesson` (a
 *     learning at an early stage, shown as a new one).
 *   - always follow: a mark on a learning Claude won't go against even if
 *     asked. On disk: `guardrail`, or any learning a hook enforces (`check`
 *     or `enforce`).
 *   - a skill: a job's steps and files, with the learnings taught on it.
 *
 * The on-disk `kind` values never change (old `.trail/` files and the cloud
 * read them); only what's shown is mapped, here.
 */

/** The mark, as a heading or in brackets. */
export const ALWAYS_FOLLOW = "always follow";

/** What the mark is read from: the kind, and a hook's `check` or `enforce`. */
export interface Marked {
  kind?: string | null;
  check?: unknown;
  enforce?: unknown;
}

/** Whether a learning is marked always follow. */
export function isAlwaysFollow(l: Marked): boolean {
  return l.kind === "guardrail" || !!l.check || !!l.enforce;
}

/** `learning`, or `always-follow learning`, for prose ("the always-follow learning no-timeout"). */
export function learningWord(l: Marked): string {
  return isAlwaysFollow(l) ? "always-follow learning" : "learning";
}
