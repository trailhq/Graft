/**
 * Every-repo personal learnings (design 1.0, P21, R6): learnings that hold
 * on this machine in every repo, in `<trail home>/learnings/`. A kept
 * guardrail, a preference the person typed in many repos, a machine wall's
 * lesson. Beside `notes.ts`, which keeps a personal learning per repo.
 *
 * A guardrail template has a fixed file name (`no-timeout.md`,
 * `push-over-ssh.md`) so the PreToolUse fast path can read that one file
 * without listing the folder (R4, R56). Every path goes through
 * `trailPath(env)`, never a home path (0 rule 11).
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { flatLine } from "./flatten.js";
import { EVERY_REPO, liveLearnings, newLearningId, readLearningFields, type LearningFields } from "./learning-fields.js";
import { parseNote, renderNote, type Note, type WriteNoteInput } from "./notes.js";
import { ensurePrivateDir, trailPath, writePrivate } from "../util/private-fs.js";
import { refuseLinkedIntoCheckout } from "./linked-learnings.js";

/** What a new every-repo learning is written from: phase 0's input plus 1b's fields. Its id, scope and status come from where it is written. */
export type LearningInput = WriteNoteInput & Pick<LearningFields, "skill" | "check" | "enforce" | "wall">;

/** A plain file name: no folder, no leading dot, `.md`. */
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.md$/;
/** A learning is a few lines; a bigger file is not one Trail wrote, and is skipped rather than read at every start. */
const MAX_FILE = 64 * 1024;

/** `<trail home>/learnings` (P21). */
export function everyRepoDir(env: NodeJS.ProcessEnv = process.env): string {
  return trailPath(env, "learnings");
}

/**
 * Writes one every-repo personal learning (0600 in a 0700 folder), id from its file name, `applies: every repo`
 * whatever the input says. A file of that name is replaced: a guardrail template keeps its one file; callers
 * pick other names so they don't meet. Returns the path.
 */
export function writeEveryRepo(input: LearningInput, fileName: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof fileName !== "string" || !FILE_NAME.test(fileName) || fileName.includes("..")) {
    throw new Error("writeEveryRepo: a plain .md file name is needed");
  }
  const dir = everyRepoDir(env);
  // D114 (1): a linked folder is fine (dotfiles), unless it leads into a Trail checkout.
  refuseLinkedIntoCheckout(dir, env);
  ensurePrivateDir(dir);
  const note: Omit<Note, "path"> = {
    title: flatLine(input.title),
    author: flatLine(input.author, 80),
    date: input.date,
    branch: input.branch,
    cost: input.cost,
    touches: input.touches ?? [],
    body: input.body,
    ...(input.standing ? { standing: true } : {}),
    ...readLearningFields({ ...input, id: newLearningId(fileName), scope: "personal", applies: EVERY_REPO, status: "active" }, fileName),
  };
  const path = join(dir, fileName);
  writePrivate(path, renderNote(note));
  return path;
}

/**
 * Active, not replaced, kind not lesson: what session start loads in every repo (R47). A file that says it holds
 * in one repo, a link, or anything that doesn't parse is left out.
 */
export function everyRepoLearnings(env: NodeJS.ProcessEnv = process.env): Note[] {
  const dir = everyRepoDir(env);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: Note[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const n = parseNote(readFileSync(path, "utf8"), path);
      if (!n || (n.applies && n.applies !== EVERY_REPO)) continue;
      out.push({ ...n, scope: "personal", applies: EVERY_REPO });
    } catch {
      /* unreadable: skip */
    }
  }
  return liveLearnings(out).filter((n) => n.kind !== "lesson");
}
