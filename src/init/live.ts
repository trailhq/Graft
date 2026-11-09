/**
 * What init's reads find, as they find it: each read hands over a learning
 * the moment its quotes check out, and the terminal and Trail's page show it
 * then, not when every read is done. The list init offers at its end is still
 * the one to keep: this is only the first look at it.
 */
import { flatLine } from "../notes/flatten.js";
import { plainHeadline, sameLearning } from "../learn/bar.js";

export interface LiveLearning {
  /** The plain headline. */
  title: string;
  /** Its file body: the why under its kind, then `In the code:`. */
  body: string;
  from: "prs" | "sessions";
}

const FROM: Record<LiveLearning["from"], string> = { prs: "pull requests", sessions: "your past sessions" };

/** `· found "<headline>" in pull requests`: one line, as the terminal shows a learning landing. */
export function liveLine(l: LiveLearning): string {
  return `· found "${flatLine(plainHeadline(l.title), 100)}" in ${FROM[l.from]}`;
}

/** The learnings landed so far, each once; a listener hears every one, the earlier ones first. */
export class LiveFeed {
  private readonly landed: LiveLearning[] = [];
  private readonly listeners: Array<(l: LiveLearning) => void> = [];

  get count(): number {
    return this.landed.length;
  }

  /** One learning a read checked; the same one from the other read was already shown, so it isn't again. */
  push(l: LiveLearning): void {
    if (this.landed.some((o) => sameLearning(o.title, l.title, o.body, l.body))) return;
    this.landed.push(l);
    for (const fn of this.listeners) tell(fn, l);
  }

  listen(fn: (l: LiveLearning) => void): void {
    this.listeners.push(fn);
    for (const l of this.landed) tell(fn, l);
  }
}

function tell(fn: (l: LiveLearning) => void, l: LiveLearning): void {
  try {
    fn(l);
  } catch {
    /* one listener's trouble never stops the rest, or the read */
  }
}
