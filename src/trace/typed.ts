/**
 * Every reader of what the person typed, for learned skills: a save request
 * and the scope words in it, the answer to an offer, a correction, and the
 * hash, the only form typed text is ever stored in.
 *
 * An answer is a closed list of whole-message forms. "ok now fix the lint
 * errors" starts like a yes and is not one: a skill is saved only on a reply
 * that says nothing else. So the answer reads the whole message: a quote, a
 * pasted block, a second line with more in it or a question mark makes it
 * not a yes. The other matchers read `askText`: pasted code, quoted lines and
 * very long lines are not the person's words.
 *
 * Pure: no files, no clock.
 */
import { createHash } from 'node:crypto';
import { ownText } from './claude.js';
import { askText, wordCount, MAX_ASK_WORDS, STATUS_OR_HISTORY } from './jobs.js';
import type { TypedAnswer } from './types.js';

export type { TypedAnswer } from './types.js';

/** The person's words in a UserPromptSubmit `prompt`: phase 0's ownText(raw); null when that gives ''. */
export function typedPrompt(raw: string): string | null {
  return ownText(String(raw ?? '')) || null;
}

/** 4.4: the spec's phrasings and the self-learning worktree's keep asks. A file (`skill.md`) or a "skill issue" is not a skill. */
export const SAVE_REQUEST = new RegExp(
  [
    String.raw`\b(?:save|keep|make|turn)\s+(?:this|that|it|these(?:\s+steps)?|what\s+(?:you\s+)?(?:just\s+)?did|the\s+steps)\s+(?:as|into)\s+(?:a\s+)?skill(?!\w|[.-]\w|\s+issues?\b)`,
    String.raw`\b(?:save|keep)\s+(?:this|that|it|these\s+steps)\s+for\s+next\s+time\b`,
    String.raw`\bmake\s+(?:a\s+)?skill\s+(?:out\s+of|from)\s+(?:this|that|it)\b`,
    String.raw`\bremember\s+how\s+(?:to\s+do\s+(?:this|that)|you\s+did\s+(?:this|that))\b`,
  ].join('|'),
  'i',
);
/** A no before the verb, in the same clause: "don't save", "I don't want to save", "you shouldn't keep", "I'd rather not keep". */
export const NOT_SAVE = /\b(?:don'?t|do not|never|no need to|not|shouldn'?t|should not|won'?t|will not|wouldn'?t|would not|didn'?t|did not)\b[^,.;:!?\n]*?\b(?:sav\w*|keep\w*|kept|mak\w*|made|turn\w*|remember\w*)\b/i;
/** Asked, then taken back ("... actually no", "... ? nah", "never mind"), or not now ("not yet, ... later"). */
const TAKEN_BACK = /\b(?:actually,? no|no,? wait|wait,? no|never ?mind|on second thought|scratch that|forget (?:it|that)|just kidding)\b|\b(?:nah|nope|no|don'?t|later)\W*$|^\W*not (?:yet|now)\b/i;
/** Wondering, asking why or how, not asking for it. */
const WONDERING = /^\s*why\b|\bwhy (?:did|didn'?t|would|do|does|is|are)\b|\bwhat (?:happens|if)\b|(?<!remember )\bhow (?:do|does|would|can|could|should|to)\b|\bexplain (?:how|what|why)\b|\bshould (?:i|we)\b|\bwhether\b/i;
/** Asking whether the agent recalls a past run: "do you remember how...", "remember how you did this last time?". */
const RECALLING = /\b(?:do|did|can|could) (?:you|u) remember\b|\bremember how\b[^.?!\n]*\b(?:last time|before|yesterday|earlier)\b/i;

/**
 * SAVE_REQUEST on 25 words or fewer, and not NOT_SAVE. Also not a status or history question ("did you
 * save this as a skill?"), not taken back, not wondering, not recalling: a wrong yes here saves a skill
 * nobody asked for, a wrong no only means the person says it plainly.
 */
export function isSaveRequest(typed: string): boolean {
  const ask = askText(typed).replace(/[\u2018\u2019]/g, "'");
  if (wordCount(ask) > MAX_ASK_WORDS || !SAVE_REQUEST.test(ask) || NOT_SAVE.test(ask)) return false;
  return !STATUS_OR_HISTORY.test(ask) && !TAKEN_BACK.test(ask) && !WONDERING.test(ask) && !RECALLING.test(ask);
}

export function scopeWords(typed: string): 'every repo' | 'this repo' | 'repo' | 'team' {
  const t = askText(typed).toLowerCase();
  if (/\b(always|everywhere|every repo|all (my )?repos|on this (mac|machine|laptop))\b/.test(t)) return 'every repo';
  if (/\bfor (the|my|our) team\b/.test(t)) return 'team';
  if (/\bfor (the )?(whole )?repo\b/.test(t) || /\b(for|in) (this|the) repo\b.*\b(everyone|team|all of us)\b/.test(t)) return 'repo';
  return 'this repo';
}

const YES = [
  // "ok thanks" closes a turn more often than it agrees to anything: ok and okay take no thanks.
  /^(y|yes|yeah|yep|yup|sure)( please| do it| go ahead| save it| keep it| keep them| thanks| thank you)?$/,
  /^(ok|okay)( please| do it| go ahead| save it| keep it| keep them)?$/,
  /^(go ahead|do it|please do|save it|keep it|keep them|save them|sounds good)( please)?$/,
  /^(yes|yeah|sure|ok|okay),? (keep|save) (it|this|that|them)( as a skill)?( please)?$/,
  // Seen in real answers: praise, then the verb. Never praise alone.
  /^(looks good|looks great|looks right|perfect|great|nice),? (keep|save) (it|this|that|them)( as a skill)?( please)?$/,
];
const SHOW = /^(show( me)?( it| the steps| the draft| first)?|let me see( it)?|what are the steps|see the steps|what'?s in it)( please)?$/;
const NO = [
  /^(n|no|nope|nah|not now|no thanks|no thank you|don'?t|skip( it)?|never ?mind|pass)( thanks| thank you)?$/,
  /^(no )?(don'?t|do not)( (save|keep) (it|this|that|them)( as a skill)?)?( thanks| thank you)?$/,
];
const TRAILING_EMOJI = /[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+$/u;

/**
 * The whole message as one answer: lowercased, outer punctuation and a trailing emoji gone, commas and
 * spaces as single spaces. The whole message, not `askText`: a quote, a pasted block or a long line is
 * more than an answer, so it can't be one.
 */
function answerForm(typed: string): string {
  return String(typed ?? '').replace(/[\u2018\u2019]/g, "'").toLowerCase().trim()
    .replace(TRAILING_EMOJI, '')
    .replace(/^[\s.!?,;:]+|[\s.!?,;:]+$/g, '')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

/** D116 item 3: the go-ahead phrases a run spans turns on, as the line's whole first clause. */
const GO_AHEAD = /^(?:y|yes|yeah|yep|yup|sure|ok|okay|k|continue|go on|go ahead|do it|proceed|carry on|keep going|please do|please continue|please proceed|sounds good)(?: please)?$/;

/**
 * D116 item 3: the person said to go on: the line's first clause (up to `,` `:` `;` `.` `!` or a dash) is a
 * go-ahead (yes, ok, continue, go on, do it, proceed), whatever follows it. Never a question.
 */
export function isGoAhead(typed: string): boolean {
  const t = String(typed ?? '').replace(/[\u2018\u2019]/g, "'").toLowerCase().trim();
  if (!t || /\?\s*$/.test(t)) return false;
  const first = t.split(/\s*(?:[,:;.!]|\s-\s|\s\u2014\s|$)/)[0]!.replace(TRAILING_EMOJI, '').trim();
  return GO_AHEAD.test(first.replace(/\s+/g, ' '));
}

/** 4.12. afterShow: the offer already got its one 'show me'. A yes is never a question. */
export function classifyAnswer(typed: string, afterShow: boolean): TypedAnswer {
  const t = answerForm(typed);
  if (!t) return 'other';
  if (!String(typed).includes('?') && YES.some((re) => re.test(t))) return 'yes';
  if (!afterShow && SHOW.test(t)) return 'show';
  if (NO.some((re) => re.test(t))) return 'no';
  if (isCorrection(askText(typed))) return 'correction';
  return 'other';
}

/* Ported from the self-learning worktree's detect.ts. */
const CORRECTION_START = /^(no[,.!\s]|nope\b|not like that|that'?s (wrong|not)|wrong\b|actually[,\s]|i (said|told you)|why did you|you (keep|always|again)|again[,!]|stop\b|please don'?t|don'?t\b|do not\b|never\b|(it|you) (didn'?t|did not|forgot to|never)\b)/i;
const AGAIN = /\b(i told you|i said|as i said|you keep \w+ing|every single time|again and again|yet again|(did|doing|broke|happened) (it|that|this) again|again\?)/i;
const OUTPUT_CORRECTION = /\b(should (be|use|go|live) \S+.{0,30}\bnot\b|it'?s actually|is wrong|that'?s not (right|how)|you (got|have) (it|that) wrong)\b/i;
const MAX_CORRECTION_CHARS = 400;

/**
 * The person is correcting what the agent just did. Ported from the worktree's detect.ts `isCorrection`; D111 adds
 * "it didn't X" and "you forgot to X" without a leading no (moment 4's forms, 4.14 step 2).
 */
export function isCorrection(typed: string): boolean {
  // The person's own words: a quoted ('>') line or a fenced block is what they quoted, not their correction (b4 review).
  const t = askText(String(typed ?? '')).replace(/[\u2018\u2019]/g, "'").trim();
  return t.length <= MAX_CORRECTION_CHARS && (CORRECTION_START.test(t) || OUTPUT_CORRECTION.test(t) || AGAIN.test(t));
}

/** sha256 hex of the text NFC-normalised, trimmed, whitespace collapsed. The only form typed text is ever stored in. */
export function typedSha(typed: string): string {
  const t = String(typed ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(t).digest('hex');
}
