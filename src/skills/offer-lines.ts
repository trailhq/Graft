/**
 * The two lines of a pending offer (design 1.4, P17, R12). A moment-2 or
 * moment-3 offer keeps them in the session file. A moment-4 offer can't: its
 * first line quotes the person's correction and its lesson starts from their
 * words, and no typed text is ever written to disk (0 rule 6). So it keeps a
 * pointer to the typed line (offset and sha), the fix command and the
 * lesson's sha, and its lines are rebuilt here from the transcript each time
 * they are read. When the line is gone, isn't the person's, or no longer
 * gives the same lesson, there are no lines: the offer is dropped, never
 * shown or answered with other words.
 *
 * Every reader of `PendingOffer.lines` goes through `offerLinesOf` (R12).
 * Re-exported from `offer-lesson.ts`, where the design names it.
 */
import type { PendingOffer } from '../trace/types.js';
import { isTypedByPerson, typedText } from '../trace/claude.js';
import { typedOnLine, type DialectUse } from '../trace/dialect.js';
import { typedSha } from '../trace/typed.js';
import { flatLine } from '../notes/flatten.js';
import { lineAt } from './receipts.js';
import { correctionPhrase, LESSON_COPY, lessonRefused, lessonSha, lessonText } from './lessons.js';

const LINE_MAX = 400;
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

/** What a reader needs of an offer to know its lines. */
export type OfferLinesIn = Pick<PendingOffer, 'lines'> & Partial<Pick<PendingOffer, 'moment' | 'name' | 'correction'>>;

/**
 * The person's typed line at `offset`, when its words still hash to `sha`; null otherwise. D133: read through the
 * host's dialect when `use` is given (a Codex line is the person's only by its keyed hash, P30); Claude's reader without.
 */
export function typedLineAt(transcriptPath: string, offset: number, sha: string, env: NodeJS.ProcessEnv = process.env, use?: DialectUse): string | null {
  if (!Number.isInteger(offset) || offset < 0 || typeof sha !== 'string') return null;
  const line = lineAt(transcriptPath, offset);
  if (line === null) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (use && use.dialect.host !== 'claude') {
    const said = typedOnLine(entry, use, env);
    return said && typedSha(said) === sha ? said : null;
  }
  if (!isTypedByPerson(entry, env)) return null;
  const text = typedText(entry, env);
  return typedSha(text) === sha ? text : null;
}

/**
 * Moment 4's lesson and the words it quotes, from the correction line and the fix command (4.14 steps 2 and 5):
 * null when the line can't be read back, has no correction phrase, or gives a lesson whose sha isn't `lessonSha`.
 */
export function correctionLesson(c: NonNullable<PendingOffer['correction']>, transcriptPath: string | null, env: NodeJS.ProcessEnv = process.env, use?: DialectUse):
  { said: string; text: string; kind: 'lesson' | 'guardrail' } | null {
  if (!transcriptPath || !c || !c.typed) return null;
  const typed = typedLineAt(transcriptPath, c.typed.offset, c.typed.sha, env, use);
  const phrase = typed === null ? null : correctionPhrase(typed);
  if (!phrase) return null;
  const text = lessonText(phrase, typeof c.fix === 'string' && c.fix ? c.fix : null, {});
  if (!text || lessonRefused(text) || lessonSha(text) !== c.lessonSha) return null;
  return { said: phrase.said, text, kind: phrase.kind };
}

/** Moment 4's 2 lines (J07): `You corrected {skill}: {said}.` and the question with the lesson's exact text. */
export function correctionLines(skill: string, said: string, text: string): [string, string] {
  return [
    flatLine(fill(LESSON_COPY.offerFirst!, { skill: flatLine(skill, 60), said: flatLine(said, 120) }), LINE_MAX),
    // D114 (3), as moment 3's line 2 (b7 review): the quotes inside the quoted lesson become single ones.
    flatLine(fill(LESSON_COPY.offerSecond!, { lesson: flatLine(text, 200).replace(/["\u201c\u201d]/g, "'") }), LINE_MAX),
  ];
}

const pair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !!v[0] && !!v[1];

/**
 * The two lines of any pending offer: `o.lines`, or for a 'correction' rebuilt from the transcript (a correction's
 * stored lines are never read). Null when the correction line is gone or its sha changed, or the offer has none.
 */
export function offerLinesOf(o: OfferLinesIn | null | undefined, transcriptPath: string | null, env: NodeJS.ProcessEnv = process.env, use?: DialectUse): [string, string] | null {
  try {
    if (!o) return null;
    if (o.moment === 'correction') {
      if (!o.correction) return null;
      const l = correctionLesson(o.correction, transcriptPath, env, use);
      return l ? correctionLines(String(o.name ?? ''), l.said, l.text) : null;
    }
    return pair(o.lines) ? o.lines : null;
  } catch {
    return null;
  }
}
