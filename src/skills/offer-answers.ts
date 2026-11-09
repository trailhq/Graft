/**
 * The answer words per moment (phase 2 design 4.10, D53). Moment 6 (drift)
 * asks "(replace / retire / leave it)" and the retire proposal asks
 * "(retire / keep it)"; every other moment is 1a's `classifyAnswer`.
 *
 * The whole message is read, as 1a reads it: a quote, a pasted block or a
 * second request after the answer ("retire it and also push") is no answer.
 * A plain yes to drift means replace and to the retire proposal means
 * retire. 1a's keep and save words ("keep it") answer neither: to drift they
 * could mean keeping the old skill, and to the retire proposal "keep it" is
 * its no. A message whose first clause is a no and whose rest is about the
 * offer ("no, retire it later") is a no; any other "no, ..." stays 1a's (a
 * correction withdraws the offer and goes to moment 4).
 *
 * Imports only `trace/typed.ts`, so the fold and the gates can use it.
 */
import type { OfferMoment, TypedAnswer } from '../trace/types.js';
import { classifyAnswer } from '../trace/typed.js';

const TRAILING_EMOJI = /[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+$/u;

/** 1a's answer form: lowercased, outer punctuation and a trailing emoji gone, commas and spaces as single spaces. */
function form(typed: string): string {
  return String(typed ?? '').replace(/[‘’]/g, "'").toLowerCase().trim()
    .replace(TRAILING_EMOJI, '')
    .replace(/^[\s.!?,;:]+|[\s.!?,;:]+$/g, '')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

const PLAIN_YES = /^(y|yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|sounds good)( please| go ahead| do it)?$/;
const REPLACE = /^(yes |ok |okay |sure )?(replace|replace it)( please)?$/;
const RETIRE = /^(yes |ok |okay |sure )?(retire|retire it)( please)?$/;
const LEAVE = /^(no )?(leave|leave it|leave it as is|leave it alone|leave it be)( please| thanks| thank you)?$/;
const KEEP = /^(no )?(keep|keep it|keep the skill|keep it as is)( please| thanks| thank you)?$/;
/** "no, retire it later", "nah, leave it for now": a no whose rest is about the offer. */
const NO_ABOUT = /^(no|nope|nah|not now)\b[\s,.;:!]+.*\b(retire|replace|leave|keep|later|for now|not now)\b/;

/** 4.10: the person's whole message as an answer to an offer of `moment`. `afterShow`: it already got its one "show me". */
export function classifyFor(moment: OfferMoment, typed: string, afterShow: boolean): TypedAnswer {
  if (moment !== 'drift' && moment !== 'retire') return classifyAnswer(typed, afterShow);
  const t = form(typed);
  if (!t) return 'other';
  const question = String(typed).includes('?');
  const lower = String(typed ?? '').replace(/[‘’]/g, "'").toLowerCase().trim();
  if (moment === 'drift') {
    if (!question && (REPLACE.test(t) || PLAIN_YES.test(t))) return 'yes';
    if (!question && RETIRE.test(t)) return 'retire';
    if (LEAVE.test(t)) return 'no';
  } else {
    if (KEEP.test(t)) return 'no';
    if (!question && (RETIRE.test(t) || PLAIN_YES.test(t))) return 'retire';
  }
  if (!question && !/\n/.test(lower) && NO_ABOUT.test(lower)) return 'no';
  const a = classifyAnswer(typed, afterShow);
  // 1a's other yes words (keep it, save it) answer neither question; the retire proposal has nothing to show.
  if (a === 'yes') return 'other';
  if (a === 'show' && moment === 'retire') return 'other';
  return a;
}
