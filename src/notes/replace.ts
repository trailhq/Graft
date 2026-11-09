/**
 * `trail note --replaces <id>`: which learning a new one replaces, and what
 * the command says about it. The old file is never edited: the new one names
 * it, and from then on only the newest is read (`liveLearnings`).
 */
import { asLearningId, findLearning } from "./learning-fields.js";
import { notePlace, shortDate, whoseLearning, type Note } from "./notes.js";

/** How many learnings an unknown id lists, newest first. */
const LISTED = 5;

/**
 * The learning `ref` (an id or a file name) names among `notes`, or the lines
 * that say why a new learning can't replace it. A learning just for you never
 * replaces one added to the repo: nobody else would see the change.
 */
export function learningToReplace(notes: Note[], ref: string, personal: boolean): { note: Note } | { error: string[] } {
  const note = findLearning(notes, ref);
  if (!note) {
    const shown = ref.replace(/\s+/g, " ").trim().slice(0, 80);
    const head = asLearningId(ref) ? `✗ no learning here has the id ${shown}` : `✗ no learning here is called ${shown}`;
    const newest = notes.slice(0, LISTED).map((n) => `  ${n.id}  ${notePlace(n)}`);
    return { error: newest.length ? [head, "  learnings here, newest first:", ...newest] : [head, "  this repo has no learnings yet"] };
  }
  if (personal && note.scope !== "personal") {
    return {
      error: [
        "✗ a learning just for you can't replace one added to this repo: your teammates would still get the old one.",
        "  Save it for the repo (leave out --personal), or leave out --replaces.",
      ],
    };
  }
  return { note };
}

/** `· id l-3f9a21`, and what it replaces: `· id l-3f9a21 · replaces Maya's learning from Oct 8 (l-0a1b2c)`. */
export function savedIdLine(saved: Note[], replaced?: Note): string {
  const ids = [...new Set(saved.map((n) => n.id))].join(", ");
  return replaced ? `· id ${ids} · replaces ${whoseLearning(replaced)} from ${shortDate(replaced.date)} (${replaced.id})` : `· id ${ids}`;
}
