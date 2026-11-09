/**
 * The person's answer to init's list, and whether the agent showed that
 * list (design 4.9 steps 3 and 4). Shared by the PreToolUse keep gate and
 * `trail keep`'s CLI half, so both decide the same way. No imports beyond
 * node: the gate loads this on the hook's path.
 *
 * - `parseKeepAnswer`: whole-message forms only. Numbers joined by spaces,
 *   commas, `and` or `&`, with `keep`, `just`, `only` or `please` around
 *   them; `all`; `none`. Anything else ("sure do whats recommended here",
 *   "the release one") is no answer: Trail needs the numbers the person typed.
 * - `replyNamesList`: every item is named as `{n}.` followed by its name
 *   words, in any wording around them, so a list of the agent's own whose
 *   numbers point at other items is not the list (R22).
 */
import type { KeepAnswer } from './types.js';

const NUMS = /^(?:(?:please|keep|just|only)\s+)*(\d{1,2}(?:\s*(?:,|&|\band\b|\s)\s*\d{1,2})*)(?:\s+please)?$/;
const ALL = /^(?:please\s+)?(?:keep\s+)?all(?:\s+of\s+them)?(?:\s+please)?$/;
const NONE = /^(?:(?:keep\s+)?(?:none|nothing)|no)$/;

/** The answer a typed message gives, or null when it isn't one of the whole-message forms. */
export function parseKeepAnswer(typed: string): KeepAnswer | null {
  if (typeof typed !== 'string' || typed.length > 200) return null;
  const t = typed.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim();
  if (!t) return null;
  if (NONE.test(t)) return { none: true };
  if (ALL.test(t)) return { all: true };
  const m = NUMS.exec(t);
  if (!m) return null;
  const numbers = [...new Set((m[1]!.match(/\d{1,2}/g) ?? []).map(Number))].filter((n) => n >= 1).sort((a, b) => a - b);
  return numbers.length ? { numbers } : null;
}

/** Words as the list check compares them: lowercase, curly quotes straightened, split like the candidates' lead words. */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[‘’]/g, "'").split(/[^a-z0-9'+-]+/).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
}

/** Whether `want` appears in `have` in order (other words may sit between). */
function inOrder(have: string[], want: string[]): boolean {
  let k = 0;
  for (const w of have) if (k < want.length && w === want[k]!.toLowerCase().replace(/^'+|'+$/g, '')) k++;
  return k === want.length;
}

/**
 * The text after each `{n}.` marker up to the next marker or line end. A marker is a number of one or two digits
 * and a dot that is not part of a longer number (`1.` yes, `1.2` and `21.` for 1 no).
 */
function segments(text: string): Map<number, string[][]> {
  const out = new Map<number, string[][]>();
  for (const line of text.split('\n')) {
    const marks = [...line.matchAll(/(?:^|[^\w.])(\d{1,2})\.(?!\d)/g)];
    marks.forEach((m, k) => {
      const start = m.index! + m[0].length;
      const end = k + 1 < marks.length ? marks[k + 1]!.index! : line.length;
      const n = Number(m[1]);
      out.set(n, [...(out.get(n) ?? []), tokens(line.slice(start, end))]);
    });
  }
  return out;
}

/**
 * Every item of the list is named in `reply` as `{n}.` followed by its name words (4.9 step 3, R22), and no number
 * of the list is followed by another item's name words without its own (b6 review): "I'd pick 1. no-timeout" after
 * the real list would point the person's "1" at item 2.
 */
export function replyNamesList(reply: string, items: Array<{ n: number; nameWords: string[] }>): boolean {
  if (typeof reply !== 'string' || !items.length) return false;
  const segs = segments(reply);
  if (!items.every((it) => it.nameWords.length > 0 && (segs.get(it.n) ?? []).some((s) => inOrder(s, it.nameWords)))) return false;
  return items.every((it) => (segs.get(it.n) ?? []).every((s) => inOrder(s, it.nameWords)
    || !items.some((o) => o.n !== it.n && o.nameWords.length > 0 && inOrder(s, o.nameWords))));
}

/** Lead words of a preference's line, as the candidates make them (candidates.ts): the first 4 that aren't stop words. */
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'this', 'that', 'is', 'be', 'with', 'please', 'here', 'i', 'you', 'we']);
export function leadWords(line: string): string[] {
  return line.toLowerCase().split(/[^a-z0-9'+-]+/).filter((w) => w && !STOP.has(w)).slice(0, 4);
}

/** The command's numbers are within what the person typed (4.9 step 5). */
export function withinAnswer(asked: KeepAnswer, typed: KeepAnswer, listed: number[]): boolean {
  if ('none' in asked) return 'none' in typed;
  if ('none' in typed) return false;
  if ('all' in typed) return true;
  const ok = new Set(typed.numbers);
  const want = 'all' in asked ? listed : asked.numbers;
  return want.length > 0 && want.every((n) => ok.has(n));
}

/**
 * A redirection (`2>&1`, `>/dev/null`, `> out.txt`, `&>/dev/null`, `2>>log`, `< /dev/null`): it changes where the
 * output goes, never what `trail keep` is asked. Linear: one pass, no nested repeats.
 */
const REDIRECT = /(^|\s)(?:\d+|&)?(?:>>?|<)(?:&(?:\d+|-)|\s*[^\s;&|<>()`'"]+)?(?=\s|$|[;&|)])/g;

/**
 * The words `trail keep` gets from the text after it, the way the shell hands them over: redirections dropped, and
 * everything from the first `;`, `&`, `|`, `)`, quote, backtick or newline on is another command (`| cat`,
 * `; echo done`, `&& echo ok`), returned as `more`. Shared by the PreToolUse gate and the CLI half (fix-lab5).
 */
export function keepWords(text: string): { words: string[]; more: string } {
  const s = String(text ?? '').slice(0, 4096).replace(REDIRECT, '$1 ');
  const cut = s.search(/[;&|)`'"\n]/);
  const head = cut < 0 ? s : s.slice(0, cut);
  return { words: head.split(/[\s,]+/).filter(Boolean), more: cut < 0 ? '' : s.slice(cut) };
}

/** `trail keep`'s own arguments as an answer: numbers, `all` or `none`; null for anything else. Shell noise in them is read past (keepWords). */
export function keepArgs(args: string[]): KeepAnswer | null {
  const words = keepWords(args.map(String).join(' ')).words.map((w) => w.toLowerCase());
  if (words.length === 1 && words[0] === 'none') return { none: true };
  if (words.length === 1 && words[0] === 'all') return { all: true };
  if (!words.length || !words.every((w) => /^\d{1,2}$/.test(w))) return null;
  const numbers = [...new Set(words.map(Number))].filter((n) => n >= 1).sort((a, b) => a - b);
  return numbers.length === words.length ? { numbers } : null;
}

/** "1 and 3", "all", "none": the typed answer in words for a deny reason. */
export function answerWords(a: KeepAnswer): string {
  if ('none' in a) return 'none';
  if ('all' in a) return 'all';
  const n = a.numbers.map(String);
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}
