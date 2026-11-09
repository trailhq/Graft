/**
 * What every skills directive an agent reads opens with (D88, D101): who it
 * is from, and the person's own words it answers.
 *
 * An agent follows hook text it can trust and refuses the rest as prompt
 * injection. Trusted text says who it is from, ties itself to what the person
 * asked, gives the reason, never tells the agent to skip asking the person,
 * and never claims an approval it can't show. These are the shared pieces.
 *
 * The person's words are quoted in the hook output only, never written to
 * disk (design 0 rule 6): one line, at most 120 characters, through
 * `flatLine`, with its double quotes turned to single ones, so a quote can
 * neither close early nor open a `[trail]` line of its own.
 */
import { flatLine } from '../notes/flatten.js';

/** The sentence a directive opens with, after its `[trail]` marker. */
export const FROM_TRAIL = 'From Trail, the tool this person installed to keep commands that worked as skills.';

/** The longest quote of the person's words a directive carries. */
export const QUOTE_MAX = 120;

/** The person's words as one quotable line: '' when there are none. */
export function quoteOf(typed: unknown): string {
  return flatLine(typed, QUOTE_MAX).replace(/"/g, "'");
}

/** `They typed: "save this as a skill".`, or '' when there are no words to quote. */
export function typedWords(typed: unknown): string {
  const q = quoteOf(typed);
  return q ? `They typed: "${q}".` : '';
}

/** `[trail] From Trail, ... They typed: "...". <rest>`: the opening, the quote when there is one, then the rest. */
export function directive(typed: unknown, rest: string): string {
  return ['[trail]', FROM_TRAIL, typedWords(typed), rest].filter(Boolean).join(' ');
}
