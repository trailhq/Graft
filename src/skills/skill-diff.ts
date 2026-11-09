/**
 * The line diff of two skill files, the size gate a fold must pass (phase 2
 * design 4.3, spec 13), and the printed diff a person reads for `show me`, a
 * proposal beside a hand-edited file, or (phase 3) a new file in a repo.
 *
 * Pure and bounded: texts over 64 KB, or a changed middle too big to align
 * cheaply, are read as all removed and all added, never line by line.
 */
import type { CompiledSkill } from './types.js';
import { oneLine } from './skillmd.js';
import { MAX_SKILL_BYTES } from './store-fs.js';

export interface LineDiff { removed: string[]; added: string[]; hunks: Array<{ at: number; del: string[]; add: string[] }> }

/** Spec 13: a fold changes at most 800 characters, and at most 40% of the file. */
export const FOLD_MAX_CHARS = 800;
export const FOLD_MAX_SHARE = 0.4;
/** The printed diff's default length, the more-lines line included. */
const PRINT_MAX_LINES = 40;
const CONTEXT = 3;
/** Cells of the alignment table after the common start and end are taken off; past it the middle is one hunk. */
const MAX_CELLS = 4_000_000;

/** Lines of a text; a trailing line break ends the last line, it doesn't start an empty one. '' has none. */
function linesOf(text: string): string[] {
  const t = String(text ?? '');
  if (!t) return [];
  const out = t.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

type Op = { kind: '=' | '-' | '+'; line: string };

/** The edit script of the middle (LCS, a table of at most MAX_CELLS); past it, all removed then all added. */
function middleOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (!n || !m || n * m > MAX_CELLS) return [...a.map((line) => ({ kind: '-' as const, line })), ...b.map((line) => ({ kind: '+' as const, line }))];
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: '=', line: a[i]! }); i++; j++; }
    else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) ops.push({ kind: '-', line: a[i++]! });
    else ops.push({ kind: '+', line: b[j++]! });
  }
  while (i < n) ops.push({ kind: '-', line: a[i++]! });
  while (j < m) ops.push({ kind: '+', line: b[j++]! });
  return ops;
}

function editScript(a: string, b: string): Op[] {
  const la = linesOf(a);
  const lb = linesOf(b);
  if (Buffer.byteLength(String(a ?? '')) > MAX_SKILL_BYTES || Buffer.byteLength(String(b ?? '')) > MAX_SKILL_BYTES) {
    return [...la.map((line) => ({ kind: '-' as const, line })), ...lb.map((line) => ({ kind: '+' as const, line }))];
  }
  let pre = 0;
  while (pre < la.length && pre < lb.length && la[pre] === lb[pre]) pre++;
  let post = 0;
  while (post < la.length - pre && post < lb.length - pre && la[la.length - 1 - post] === lb[lb.length - 1 - post]) post++;
  const same = (l: string[]) => l.map((line) => ({ kind: '=' as const, line }));
  return [...same(la.slice(0, pre)), ...middleOps(la.slice(pre, la.length - post), lb.slice(pre, lb.length - post)), ...same(la.slice(la.length - post))];
}

/** LCS on lines. A hunk's `at` is how many lines of `a` come before it (0-based). */
export function lineDiff(a: string, b: string): LineDiff {
  const out: LineDiff = { removed: [], added: [], hunks: [] };
  let at = 0;
  let open: LineDiff['hunks'][number] | null = null;
  for (const op of editScript(a, b)) {
    if (op.kind === '=') { open = null; at++; continue; }
    if (!open) { open = { at, del: [], add: [] }; out.hunks.push(open); }
    if (op.kind === '-') { open.del.push(op.line); out.removed.push(op.line); at++; }
    else { open.add.push(op.line); out.added.push(op.line); }
  }
  return out;
}

/**
 * D131: step numbers read as one mark, so a renumber alone changes no line: a Run line's `N. `, the check line's
 * `Step N, ` and an If it fails line's `what worked was step N.`.
 */
const unnumbered = (text: string) => String(text ?? '').split('\n').map((l) => l
  .replace(/^\d+\. /, '#. ')
  .replace(/^Step \d+, /, 'Step #, ')
  .replace(/\bwhat worked was step \d+\./, 'what worked was step #.')).join('\n');

/**
 * 4.3 as D131 changed it: the characters an edit changes (every removed and added line, its line break counted), step
 * numbers taken out first, so one inserted step anywhere costs about its own length. `share` is of the file as it is.
 */
export function sizeGate(before: string, after: string): { chars: number; share: number; ok: boolean } {
  const d = lineDiff(unnumbered(before), unnumbered(after));
  const chars = [...d.removed, ...d.added].reduce((n, l) => n + l.length + 1, 0);
  const len = String(before ?? '').length;
  const share = len ? chars / len : chars ? 1 : 0;
  return { chars, share, ok: chars <= FOLD_MAX_CHARS && share <= FOLD_MAX_SHARE };
}

/** A printed line's length cap: a 2 MB line (a binary file, a minified blob) is cut, never printed whole (review). */
const PRINT_MAX_LINE = 400;
/**
 * Control characters, bidi marks and line separators, printed as escapes (review): a file a person or a teammate
 * edited can hold an ESC sequence (a terminal title, a clipboard write) or a right-to-left mark that shows other text
 * than the bytes. Trail's own files never hold one (oneLine drops them), so a skill's text prints as it is.
 */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const escapeOne = (ch: string) => (ch === '\r' ? '\\r' : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
const shown = (line: string) => {
  const t = line.length > PRINT_MAX_LINE * 2 ? line.slice(0, PRINT_MAX_LINE * 2) : line;
  const e = t.replace(UNSAFE, escapeOne);
  return e.length > PRINT_MAX_LINE || t.length < line.length ? `${e.slice(0, PRINT_MAX_LINE)}…` : e;
};

const range = (start: number, count: number) => `${count === 0 ? start : start + 1},${count}`;

/**
 * A unified diff (3 lines of context), at most `maxLines` lines with the more-lines line, step text as it is. '' when
 * the texts are equal. Each line at most 400 characters, control characters and bidi marks as escapes (review). An empty `a` prints a new file: phase 3's `renderNewFileDiff` prints through it.
 */
export function printDiff(a: string, b: string, labels: [string, string], maxLines = PRINT_MAX_LINES): string {
  const ops = editScript(a, b);
  if (!ops.some((o) => o.kind !== '=')) return '';
  // Each op with its place in a and b; hunks are runs of changes with the context around them, merged when they touch.
  const at: Array<{ ai: number; bi: number }> = [];
  let ai = 0;
  let bi = 0;
  for (const o of ops) {
    at.push({ ai, bi });
    if (o.kind !== '+') ai++;
    if (o.kind !== '-') bi++;
  }
  const out = [`--- ${oneLine(labels[0])}`, `+++ ${oneLine(labels[1])}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.kind === '=') { k++; continue; }
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    for (;;) {
      while (end < ops.length && ops[end]!.kind !== '=') end++;
      let gap = end;
      while (gap < ops.length && ops[gap]!.kind === '=') gap++;
      if (gap < ops.length && gap - end <= CONTEXT * 2) { end = gap; continue; }
      end = Math.min(ops.length, end + CONTEXT);
      break;
    }
    const part = ops.slice(start, end);
    const aCount = part.filter((o) => o.kind !== '+').length;
    const bCount = part.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${range(at[start]!.ai, aCount)} +${range(at[start]!.bi, bCount)} @@`);
    for (const o of part) out.push(`${o.kind === '=' ? ' ' : o.kind}${shown(o.line)}`);
    k = end;
  }
  const max = Math.max(3, Math.floor(maxLines));
  if (out.length <= max) return out.join('\n');
  return [...out.slice(0, max - 1), `… ${out.length - (max - 1)} more lines`].join('\n');
}

/** A Run line without its number: what the step is, so a renumber alone changes no line. */
const stepKey = (s: CompiledSkill['steps'][number]) => `${s.gated ? 'G ' : ''}${oneLine(s.cmd)}${s.wait ? ' (wait)' : s.bg ? ' (bg)' : ''}`;

/** The Run lines a change touches, for "1 line changes": per hunk the larger of what goes and what comes. */
export function runLinesChanged(before: CompiledSkill, after: CompiledSkill): number {
  const text = (c: CompiledSkill) => c.steps.map(stepKey).join('\n') + (c.steps.length ? '\n' : '');
  return lineDiff(text(before), text(after)).hunks.reduce((n, h) => n + Math.max(h.del.length, h.add.length), 0);
}
