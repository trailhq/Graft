/**
 * Learnings and skills, said once and never against each other (part 7).
 *
 * A person's live preferences, decisions and guardrails are read for what
 * they say about commands (learning-steps.ts, no model), then:
 *
 * - at a skill's save or offer, the steps follow them: a step a learning
 *   forbids is written its way when Trail can do that safely, else left
 *   out, and the offer names either in one plain line (`followAtSave`);
 * - at recall, a learning that only repeats a step is said once, in the run
 *   block, and the prompt's learnings lines leave it out; one that goes
 *   against a step wins, and the block marks the step (`recallMarks`,
 *   `markLines`). The update offer then proposes the change, with its usual
 *   consent (fold.ts, why `preference`).
 *
 * Retired, replaced and held learnings never count (`liveLearnings`), nor
 * one on a teammate's unmerged branch, nor a lesson. Reading fails open:
 * no learnings, nothing changes.
 */
import { readNotesIn, type Note } from '../notes/notes.js';
import { everyRepoLearnings } from '../notes/every-repo.js';
import { EVERY_REPO, learningFileName, liveLearnings, type LearningKind, type Scope } from '../notes/learning-fields.js';
import { repoNotesDir } from '../notes/repo-notes-dir.js';
import { learningsDir } from '../notes/repo-trail.js';
import { flatLine } from '../notes/flatten.js';
import { learningWord } from '../notes/units.js';
import { gatedKind } from './risk.js';
import { neverSave } from './never-save.js';
import { matchSteps, rulesOf, type StepRule } from './learning-steps.js';

export interface StepLearning {
  id: string;
  /** Its file name: one learning wherever it sits, as the session's shown list knows it (`shownFiles`). */
  file: string;
  kind: LearningKind | null;
  scope: Scope;
  /** The learning's words as a line quotes them. */
  quote: string;
  /** The quote is the whole learning and every sentence of it was read: a line that says it leaves nothing out. */
  whole: boolean;
  rules: StepRule[];
}

/** Where a save or a block reads learnings: the run's repo, its checkout's committed ones, and every-repo ones. */
export interface LearningsWhere { repoKeys: string[]; checkout: string; env: NodeJS.ProcessEnv }

export const QUOTE_MAX = 160;
const MARKS_MAX = 3;

/** The words the person and the agent read. No em dashes; never notes, rules or the like (the words test reads these). */
export const FOLLOW_COPY = {
  savedOne: 'Step {n} runs {next} rather than this run\'s {old}, as {whose} "{quote}" says.',
  savedMany: 'Steps {list} follow {whose} "{quote}" rather than this run\'s commands.',
  leftOne: 'Trail left out {old}: it goes against {whose} "{quote}", and Trail can\'t change it safely.',
  leftMany: 'Trail left out {k} steps: they go against {whose} "{quote}", and Trail can\'t change them safely.',
  refuse: 'goes against {whose} "{quote}", and it is the check',
  short: 'Some steps follow your learnings rather than this run; say show me to see them.',
  counts: 'To follow your learnings, Trail {did}; say show me to see them.',
  stepFixed: ' ({whose_s} way; the skill has {old})',
  stepAgainst: ' (against {whose}: see below)',
  wins: '{Whose} wins over the skill: "{quote}". {Steps} {are} written its way; run {them} as shown.',
  against: '{Whose} "{quote}" goes against {steps}: leave {it} out, do that part its way, and tell the person.',
  follows: '{Steps} {follow} {whose}: "{quote}".',
} as const;

const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (v[k] === undefined ? m : String(v[k])));
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const quoteText = (l: StepLearning) => l.quote.replace(/"/g, "'");
/** A command as a line shows it: one line, at most 60 characters, its single quotes made double, in single quotes. */
export const cmdWords = (cmd: string) => `'${flatLine(String(cmd ?? '').replace(/'/g, '"'), 60)}'`;
const listWords = (ns: number[]) => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

const OWNER: Record<Scope, string> = { personal: 'your', repo: "this repo's", team: "your team's" };
/** 'your learning', "this repo's learning", "your team's always-follow learning" (notes/units.ts). */
export function whose(l: Pick<StepLearning, 'kind' | 'scope'>): string {
  return `${OWNER[l.scope] ?? 'your'} ${learningWord(l)}`;
}

/* ------------------------------------------------------------ reading */

/** The lines a learning's commands are read from: its title and body, headings and the tried-and-ruled-out part left out. */
function linesOf(n: Pick<Note, 'title' | 'body'>): string[] {
  const out: string[] = [];
  let skip = false;
  for (const raw of [n.title, ...String(n.body ?? '').split('\n')]) {
    const l = flatLine(raw, 4000);
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (h) {
      skip = /tried|ruled out/i.test(h[1]!);
      continue;
    }
    if (l && !skip && !out.includes(l)) out.push(l);
  }
  return out;
}

/** What one learning says about commands; null when it says nothing a step could repeat or go against. */
export function stepLearningOf(n: Pick<Note, 'id' | 'kind' | 'scope' | 'title' | 'body'> & { path?: string }): StepLearning | null {
  if (n.kind === 'lesson') return null;
  const lines = linesOf(n);
  const read = rulesOf(lines.join('\n'));
  if (!read.rules.length) return null;
  const only = lines.length === 1 ? lines[0]! : null;
  const quote = flatLine(only ?? n.title, QUOTE_MAX);
  return { id: n.id, file: n.path ? learningFileName(n.path) : '', kind: n.kind ?? null, scope: n.scope ?? 'repo', quote, whole: read.whole && only !== null && quote === only, rules: read.rules };
}

/** The file names of the learnings a session has shown already (its `injectedNotes`: paths, or a title for one with none). */
export function shownFiles(injected: readonly string[] | undefined): Set<string> {
  return new Set((injected ?? []).map((p) => learningFileName(p)).filter(Boolean));
}

/** The live learnings that say something about commands, for a run in `where`. [] on any read failure. */
export function stepLearnings(where: LearningsWhere): StepLearning[] {
  const notes: Note[] = [];
  const add = (f: () => Note[]) => {
    try { notes.push(...f()); } catch { /* none from there this time */ }
  };
  add(() => everyRepoLearnings(where.env));
  for (const key of [...new Set(where.repoKeys.filter(Boolean))]) {
    const k = key.toLowerCase();
    add(() => readNotesIn(repoNotesDir(key, where.env), '', '', 'personal').filter((n) => !n.applies || n.applies === EVERY_REPO || n.applies === k));
  }
  if (where.checkout) add(() => readNotesIn(learningsDir(where.checkout), where.checkout, where.checkout, 'repo'));
  try {
    const seen = new Set<string>();
    const unique = notes.filter((n) => !seen.has(n.id) && (seen.add(n.id), true));
    return liveLearnings(unique).flatMap((n) => stepLearningOf(n) ?? []);
  } catch {
    return [];
  }
}

/**
 * The learning's words only repeat what the steps do: every sentence read, at least one step repeats it, none goes
 * against it. What init folds into a skill as a lesson (part 7).
 */
export function onlyRepeats(text: string, steps: string[]): boolean {
  const l = stepLearningOf({ id: 'l-000000', kind: 'preference', scope: 'personal', title: text, body: text });
  if (!l || !l.whole) return false;
  const v = matchSteps(l.rules, steps);
  return v.repeats.length > 0 && v.contradicts.length === 0;
}

/* ------------------------------------------------------------ at a save */

export interface SaveItem { cmd: string; gated: boolean; isCheck: boolean }
export interface SaveFollow {
  /** The steps kept, by their index in the input, with the command they keep. */
  keep: Array<{ i: number; cmd: string }>;
  /** The one plain line the offer and the save name it in; '' when nothing changed. */
  line: string;
  /** Why the skill can't be kept: the check itself goes against a learning and can't follow it. */
  refuse: string | null;
}

/** A fix the save or the block may use: a step that can be undone stays one, and nothing the risk rules refuse. */
const safeFix = (fix: string | null, gated: boolean) => (fix && !gated && !gatedKind(fix) && !neverSave(fix) ? fix : null);

/** The first learning that goes against each step, and the step its way when that is safe. */
function against(cmds: string[], gated: boolean[], ls: StepLearning[]): Map<number, { l: StepLearning; fix: string | null }> {
  const out = new Map<number, { l: StepLearning; fix: string | null }>();
  for (const l of ls) {
    for (const c of matchSteps(l.rules, cmds).contradicts) if (!out.has(c.step)) out.set(c.step, { l, fix: safeFix(c.fix, gated[c.step - 1] ?? true) });
  }
  return out;
}

/** The steps as a save keeps them: each one a learning goes against written its way, or left out, and the line that says so. */
export function followAtSave(items: SaveItem[], ls: StepLearning[]): SaveFollow {
  const same: SaveFollow = { keep: items.map((it, i) => ({ i, cmd: it.cmd })), line: '', refuse: null };
  if (!ls.length || !items.length) return same;
  const hit = against(items.map((it) => it.cmd), items.map((it) => it.gated), ls);
  if (!hit.size) return same;
  const keep: SaveFollow['keep'] = [];
  const fixed = new Map<StepLearning, Array<{ n: number; old: string; next: string }>>();
  const left = new Map<StepLearning, string[]>();
  for (const [i, it] of items.entries()) {
    const h = hit.get(i + 1);
    if (!h) {
      keep.push({ i, cmd: it.cmd });
    } else if (h.fix) {
      keep.push({ i, cmd: h.fix });
      fixed.set(h.l, [...(fixed.get(h.l) ?? []), { n: keep.length, old: it.cmd, next: h.fix }]);
    } else if (it.isCheck) {
      return { ...same, refuse: fill(FOLLOW_COPY.refuse, { whose: whose(h.l), quote: flatLine(quoteText(h.l), 80) }) };
    } else {
      left.set(h.l, [...(left.get(h.l) ?? []), it.cmd]);
    }
  }
  const said: string[] = [];
  for (const [l, fs] of fixed) {
    const v = { whose: whose(l), quote: flatLine(quoteText(l), 80) };
    said.push(fs.length === 1 ? fill(FOLLOW_COPY.savedOne, { ...v, n: fs[0]!.n, next: cmdWords(fs[0]!.next), old: cmdWords(fs[0]!.old) })
      : fill(FOLLOW_COPY.savedMany, { ...v, list: listWords(fs.map((f) => f.n)) }));
  }
  for (const [l, olds] of left) {
    const v = { whose: whose(l), quote: flatLine(quoteText(l), 80) };
    said.push(olds.length === 1 ? fill(FOLLOW_COPY.leftOne, { ...v, old: cmdWords(olds[0]!) }) : fill(FOLLOW_COPY.leftMany, { ...v, k: olds.length }));
  }
  const all = said.join(' ');
  const changed = [...fixed.values()].reduce((n, fs) => n + fs.length, 0);
  const dropped = [...left.values()].reduce((n, olds) => n + olds.length, 0);
  const n = (k: number) => (k === 1 ? '1 step' : `${k} steps`);
  const did = [changed ? `changed ${n(changed)}` : '', dropped ? `left out ${n(dropped)}` : ''].filter(Boolean).join(' and ');
  const counts = fill(FOLLOW_COPY.counts, { did });
  return { keep, line: flatLine(all.length <= LINE_ROOM ? all : counts, 400), refuse: null };
}

/** Room an offer's line 1 leaves for the follow line (offer lines are at most 400 characters). */
const LINE_ROOM = 240;
const OFFER_LINE_MAX = 400;

/** An offer's 2 lines with the follow line at the end of line 1 (a shorter one when both don't fit). */
export function withFollowLine(lines: [string, string], followed: string | undefined): [string, string] {
  if (!followed) return lines;
  const both = `${lines[0]} ${followed}`;
  return [both.length <= OFFER_LINE_MAX ? both : flatLine(`${lines[0]} ${FOLLOW_COPY.short}`, OFFER_LINE_MAX), lines[1]];
}

/* ------------------------------------------------------------ at recall */

/** One learning's say in a run block: the steps it repeats, or the steps it goes against (written its way, or to leave out). */
export interface RecallMark {
  l: StepLearning;
  against: boolean;
  steps: number[];
  /** Against: each step's command its way (with the skill's {params}), or null for a step to leave out. */
  fixes: Map<number, string | null>;
}

/**
 * What the live learnings say of a skill's steps, at most 3 learnings. A learning that goes against a step wins over
 * one that repeats it. A repeat is said only for a preference or decision (or a plain learning) the line can quote in
 * full, so leaving it out of the prompt's learnings lines loses nothing, and only once a session: one the session showed
 * already (`shown`, file names: on a file the agent opened, or with an earlier prompt) is not said again. A learning
 * that goes against a step is always marked, since the step is shown its way.
 */
export function recallMarks(steps: Array<{ n: number; cmd: string; gated?: unknown }>, ls: StepLearning[], shown: ReadonlySet<string> = new Set()): RecallMark[] {
  if (!ls.length || !steps.length) return [];
  const cmds = steps.map((s) => s.cmd);
  const hit = against(cmds, steps.map((s) => !!s.gated), ls);
  const out: RecallMark[] = [];
  for (const l of ls) {
    const mine = [...hit].filter(([, h]) => h.l === l).map(([n]) => n);
    if (mine.length) {
      out.push({ l, against: true, steps: mine, fixes: new Map(mine.map((n) => [n, hit.get(n)!.fix])) });
      continue;
    }
    if (!l.whole || (l.kind !== null && l.kind !== 'preference' && l.kind !== 'decision')) continue;
    // Shown this session already (on a file the agent opened, or with an earlier prompt): not said again here.
    if (l.file && shown.has(l.file)) continue;
    const reps = matchSteps(l.rules, cmds).repeats.filter((n) => !hit.has(n));
    if (reps.length) out.push({ l, against: false, steps: reps, fixes: new Map() });
  }
  return out.slice(0, MARKS_MAX);
}

/** The step texts and check as the block shows them: each fix in place of its step (and of the check it is). */
export function withFixes<T extends { steps: Array<{ n: number; cmd: string }>; check: string | null }>(skill: T, marks: RecallMark[]): T {
  const fixes = new Map<number, string>();
  for (const m of marks) for (const [n, f] of m.fixes) if (f) fixes.set(n, f);
  if (!fixes.size) return skill;
  let check = skill.check;
  const steps = skill.steps.map((s) => {
    const f = fixes.get(s.n);
    if (!f) return s;
    if (check !== null && check === s.cmd) check = f;
    return { ...s, cmd: f };
  });
  return { ...skill, steps, check };
}

/** What a marked step's line ends with in the block (`n` is the step, `old` the skill's own command, filled). */
export function stepNote(marks: RecallMark[], n: number, old: string): string {
  const m = marks.find((x) => x.against && x.steps.includes(n));
  if (!m) return '';
  return m.fixes.get(n) ? fill(FOLLOW_COPY.stepFixed, { whose_s: `${whose(m.l)}'s`, old: flatLine(old, 120) }) : fill(FOLLOW_COPY.stepAgainst, { whose: whose(m.l) });
}

/** The lines after a block's steps, one per learning, each quoting it once. */
export function markLines(marks: RecallMark[]): string[] {
  return marks.map((m) => {
    const one = m.steps.length === 1;
    const steps = `${one ? 'step' : 'steps'} ${listWords(m.steps)}`;
    const v = { whose: whose(m.l), Whose: cap(whose(m.l)), quote: quoteText(m.l), steps, Steps: cap(steps) };
    if (!m.against) return fill(FOLLOW_COPY.follows, { ...v, follow: one ? 'follows' : 'follow' });
    const fixed = m.steps.filter((n) => m.fixes.get(n));
    const out = m.steps.filter((n) => !m.fixes.get(n));
    const parts: string[] = [];
    if (fixed.length) {
      const s = `${fixed.length === 1 ? 'Step' : 'Steps'} ${listWords(fixed)}`;
      parts.push(fill(FOLLOW_COPY.wins, { ...v, Steps: s, are: fixed.length === 1 ? 'is' : 'are', them: fixed.length === 1 ? 'it' : 'them' }));
    }
    if (out.length) {
      const s = `${out.length === 1 ? 'step' : 'steps'} ${listWords(out)}`;
      parts.push(fill(FOLLOW_COPY.against, { ...v, steps: s, it: out.length === 1 ? 'it' : 'them' }));
    }
    // Both kinds from one learning: its words once, in the first sentence.
    return parts.length === 2 ? `${parts[0]} ${parts[1]!.replace(/^.+? goes against /, 'It goes against ')}` : parts[0]!;
  });
}

/** The ids of the learnings a block says (its lines are in the block as it went out). */
export function saidIn(block: string, marks: RecallMark[]): string[] {
  const lines = markLines(marks);
  return marks.filter((_, k) => block.includes(lines[k]!)).map((m) => m.l.id);
}
