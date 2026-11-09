/**
 * Who may mark a learning always follow. The mark makes Claude hold to it
 * even when someone asks otherwise, and loads it at every session start, so
 * an agent never sets it on its own say:
 *
 *   - the person at their own terminal (`personAtTerminal`) may;
 *   - an agent may only when the person's own words in this session back it:
 *     a line they typed (`typedText`, the same reading the skill offers use)
 *     that says it must hold ("always", "never", "even if", "must", ...) and
 *     shares a word with the learning's title.
 *
 * Anything else is saved as a plain learning, and the agent is told why.
 * Reading the transcript is bounded and never throws: a session that can't
 * be read backs nothing.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { currentTranscript } from "./session-cost.js";
import { typedText } from "../trace/claude.js";
import { personAtTerminal } from "../skills/person.js";

/** The last part of the transcript read: the person's say-so is recent. */
const TAIL_BYTES = 2 * 1024 * 1024;

/** Words that say a line must hold even if asked otherwise. */
const HOLDS = /\b(?:always|never|must|even if|no matter|every time|don'?t ever|do not ever|under no circumstances|without exception)\b/i;

/** Words too plain to tie a typed line to a learning. */
const PLAIN = new Set([
  "always", "never", "must", "should", "every", "even", "that", "this", "with", "from", "into", "when", "what", "there", "their", "they",
  "have", "only", "then", "than", "them", "your", "ours", "about", "after", "before", "keep", "make", "sure", "using", "use", "code",
]);

/** A title's or a line's words that can tie the two together: 4 letters or more, not plain. */
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((w) => !PLAIN.has(w)));
}

/** The lines the person typed in the tail of `transcript`. */
function typedLines(transcript: string, env: NodeJS.ProcessEnv): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(transcript, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const out: string[] = [];
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = typedText(JSON.parse(line), env);
        if (t) out.push(t);
      } catch {
        /* a line cut by the tail, or not JSON */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Whether a line the person typed says `title` must always hold. */
export function typedBacks(typed: string, title: string): boolean {
  if (!HOLDS.test(typed)) return false;
  const want = words(title);
  for (const w of words(typed)) if (want.has(w)) return true;
  return false;
}

export type AlwaysFollowSay = { ok: true; by: "person" | "typed" } | { ok: false };

/** May a learning saved now from `repo`, titled `title`, be marked always follow? */
export function alwaysFollowBacked(
  repo: string,
  title: string,
  opts: { env?: NodeJS.ProcessEnv; home?: string; person?: () => boolean } = {},
): AlwaysFollowSay {
  const env = opts.env ?? process.env;
  try {
    if ((opts.person ?? (() => personAtTerminal(env).ok))()) return { ok: true, by: "person" };
  } catch {
    /* can't tell: the transcript decides */
  }
  const transcript = currentTranscript(repo, opts.home);
  if (!transcript) return { ok: false };
  return typedLines(transcript, env).some((t) => typedBacks(t, title)) ? { ok: true, by: "typed" } : { ok: false };
}
