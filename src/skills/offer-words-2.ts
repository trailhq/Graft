/**
 * The words of moments 5 and 6 and the retire proposal (phase 2 design 4.7
 * to 4.9, R11, R19, R24): their two lines, the Stop reason and post-tool
 * text around them, and what the agent reads on each answer. `offer-words.ts`
 * hands moments update, drift and retire here; 1b's lesson and repair words
 * never see them (R11: they would name `trail skills lesson` or `add`).
 *
 * D88, D101, D107: every text says it is from Trail, gives Trail's own
 * reason, quotes the words the person typed when it answers them (in the
 * hook output only, never on disk), says who checks the answer, and never
 * tells the agent to recite, to skip asking, or what one yes covers.
 * Commands in a line are the agent's own from this session (through
 * compile's secret check), one line, cut at 60 characters, in single quotes
 * (R24). Lines are counted facts; no model writes any of them (P16).
 *
 * Never "memory" or "remember", no em dashes: the words tests read this file.
 */
import type { PendingOffer, TypedAnswer } from '../trace/types.js';
import type { HookOut } from './types.js';
import type { Host } from '../trace/host.js';
import { flatLine } from '../notes/flatten.js';
import { JOB_CLASSES } from '../trace/jobs.js';
import { hostFacts } from './host-facts.js';
import { FROM_TRAIL, quoteOf } from './directive-words.js';
import { notSaved } from './offer-words.js';

/** Moment 5 (4.7). `line2*` end with the keys the person answers with. */
export const UPDATE_COPY = {
  line1Update: '{check} This time step {step} of {name} failed and {cmds} worked instead.',
  line1Preference: '{check} This time {steps} of {name} ran as {cmds}, the way {follows} says.',
  line2Preference: 'Change {steps} of {name} to match? {size} (yes / show me / no)',
  line1Extend: '{check} This time {name} also needed {cmds} {where}.',
  line1Split: '{check} This time {name} ran only steps {from} to {to}, as it did last time.',
  line2Lesson: 'Fold your {date} learning into {name} as {steps}? {size} (yes / show me / no)',
  line2TwoUses: 'Add {it} to {name} as {steps}? {They} ran in your last 2 {jobs}. {size} (yes / show me / no)',
  line2Update: 'Change step {step} of {name} to the command that worked? {size} (yes / show me / no)',
  line2Split: 'Keep steps {from} to {to} as their own skill, {new}, beside {name}? (yes / show me / no)',
  size: '{n} line changes.',
  handEdited: 'You changed {name} by hand, so Trail writes it beside your file for you to compare.',
  reason: 'Skill {name} just ran and checked out, and this run did one thing differently; Trail offers once to change the skill to match.',
  offered: 'Trail offered to change the skill {name} to match how this job just ran',
  reasonSplit: 'A skill Trail brought in just ran only some of its steps, the same ones as last time; Trail offers once to keep those steps as a skill of their own, {name}.',
  offeredSplit: 'Trail offered to keep steps of a skill as a skill of their own, {name}',
} as const;

/** Moment 6 (4.8, J15, P16). */
export const DRIFT_COPY = {
  line1: '{check} {name} needs a fix, and this {job} went another way: {how}.',
  line2: 'Replace {name} with the {k} steps that just worked, retire it, or leave it? (replace / retire / leave it)',
  line2Hand: 'Write the {k} steps that just worked beside your edited {name}, retire it, or leave it? (replace / retire / leave it)',
  reason: 'Skill {name} needs a fix, and this job just checked out another way; Trail offers once to replace it, retire it or leave it.',
  offered: 'Trail offered to replace the skill {name} with the steps that just worked',
} as const;

/** The retire proposal (4.9, P13). */
export const RETIRE_COPY = {
  line1: 'Trail brought in skill {name} {n} times lately, and its steps ran in {k} of them.',
  line2: 'Retire it? trail skills restore {name} brings it back. (retire / keep it)',
  reason: 'Trail brought in skill {name} for jobs here and its steps mostly did not run; it offers once, ever, to retire a skill like that.',
  offered: 'Trail offered to retire the skill {name}',
  retired: 'Trail retired {name}. Tell them in one line, with how to bring it back: trail skills restore {name}.',
  busy: "Trail couldn't retire it just now: the person can run trail forget {name}. Tell them that in one line.",
} as const;

const LINE_MAX = 400;
const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (v[k] === undefined ? m : String(v[k])));
const one = (v: unknown, max = 60) => flatLine(v, max);
/** A command as a line shows it (R24): one line, at most 60 characters, its own single quotes made double, in single quotes. */
export const quoted = (cmd: string) => `'${one(String(cmd ?? '').replace(/'/g, '"'), 60)}'`;
const both = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const nounOf = (job: string) => JOB_CLASSES.find((j) => j.job === job)?.noun ?? job ?? 'job';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A lesson's local date ('2026-10-30') as 'Oct 30'; never shifted by the time zone. */
function dayWords(local: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(local ?? ''));
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : 'an earlier';
}
const pairOf = (a: string, b: string): [string, string] => [flatLine(a, LINE_MAX), flatLine(b, LINE_MAX)];

export interface UpdateFacts {
  op: 'update' | 'extend' | 'split';
  why?: 'failed-then-worked' | 'lesson' | 'two-uses' | 'preference';
  /** Part 7, why 'preference': whose learning the steps followed ("your preference"), and every step it changes. */
  follows?: string;
  steps?: number[];
  /** The job's check as 1a's `checkLine` says it ("Published 0.22.4: npm shows it."). */
  check: string;
  name: string;
  job: string;
  /** update: the step changed; extend: the skill step the new ones go after (0: before step 1). */
  at: number;
  /** The new or changed steps, filled with this run's values. */
  cmds: string[];
  /** Run lines the change touches (`runLinesChanged`). */
  changes: number;
  lessonDate?: string;
  split?: { from: number; to: number; name: string };
  handEdited: boolean;
}

/** 4.7: moment 5's two lines. */
export function updateLines(f: UpdateFacts): [string, string] {
  const C = UPDATE_COPY;
  const name = one(f.name);
  const check = one(f.check, 160);
  const cmds = both(f.cmds.slice(0, 2).map(quoted));
  const size = f.handEdited ? fill(C.handEdited, { name }) : fill(C.size, { n: Math.max(0, Math.floor(f.changes)) });
  if (f.op === 'split' && f.split) {
    const s = { from: f.split.from, to: f.split.to };
    return pairOf(fill(C.line1Split, { check, name, ...s }), fill(C.line2Split, { ...s, name, new: one(f.split.name) }));
  }
  if (f.op === 'update') {
    if (f.why === 'preference' && f.follows) {
      const ns = f.steps?.length ? f.steps : [f.at];
      const steps = ns.length === 1 ? `step ${ns[0]}` : `steps ${both(ns.map(String))}`;
      const all = f.cmds.map(quoted);
      const ran = all.length > 2 ? `${all.slice(0, 2).join(', ')} and ${all.length - 2} more` : both(all);
      return pairOf(fill(C.line1Preference, { check, name, steps, cmds: ran, follows: one(f.follows) }), fill(C.line2Preference, { steps, name, size }));
    }
    return pairOf(fill(C.line1Update, { check, name, step: f.at, cmds }), fill(C.line2Update, { step: f.at, name, size }));
  }
  const n = Math.min(2, Math.max(1, f.cmds.length));
  const steps = n === 1 ? `step ${f.at + 1}` : `steps ${f.at + 1} and ${f.at + 2}`;
  const where = f.at > 0 ? `after step ${f.at}` : 'before step 1';
  const line1 = fill(C.line1Extend, { check, name, cmds, where });
  const line2 = f.why === 'lesson'
    ? fill(C.line2Lesson, { date: dayWords(f.lessonDate), name, steps, size })
    : fill(C.line2TwoUses, { it: n === 1 ? 'it' : 'them', They: n === 1 ? 'It' : 'They', name, steps, jobs: `${nounOf(f.job)}s`, size });
  return pairOf(line1, line2);
}

export interface DriftFacts {
  check: string; name: string; job: string;
  /** Run steps of the fresh compile (the new version's). */
  steps: number;
  /** Skill steps that didn't run, and fresh steps that match no skill step, in order. */
  skipped: Array<{ n: number; cmd: string }>;
  ran: string[];
  handEdited: boolean;
}

/** 4.8: moment 6's two lines; at most 2 named each way. */
export function driftLines(f: DriftFacts): [string, string] {
  const C = DRIFT_COPY;
  const name = one(f.name);
  const skipped = both(f.skipped.slice(0, 2).map((s) => `${quoted(s.cmd)} (step ${s.n})`));
  const ran = both(f.ran.slice(0, 2).map(quoted));
  const how = skipped && ran ? `it skipped ${skipped} and ran ${ran}` : skipped ? `it skipped ${skipped}` : `it ran ${ran}`;
  const line1 = fill(C.line1, { check: one(f.check, 160), name, job: nounOf(f.job), how });
  return pairOf(line1, fill(f.handEdited ? C.line2Hand : C.line2, { name, k: Math.max(0, Math.floor(f.steps)) }));
}

export interface RetireFacts { name: string; fired: number; followed: number }

/** 4.9: the retire proposal's two lines. */
export function retireLines(f: RetireFacts): [string, string] {
  const name = one(f.name);
  return pairOf(fill(RETIRE_COPY.line1, { name, n: Math.floor(f.fired), k: Math.floor(f.followed) }), fill(RETIRE_COPY.line2, { name }));
}

/** Why the 2 lines end the reply (as 1a and 1b say it). */
const SO_THEY_ANSWER = 'so the person can answer (Trail reads their answer to the last line, so keep it as it is)';
const CHECKS = 'Trail checks their answer in this session before it changes anything';
const CHECKS_KEEP = 'Trail checks their answer in this session before it keeps anything';

const idOf = (o: PendingOffer) => one(o.offerId, 40);
const runOf = (o: PendingOffer) => one(o.runId, 40);
const isSplit = (o: PendingOffer) => o.moment === 'update' && o.fold?.op === 'split';
/** The skill an offer is about: its folder name. A split's offer names the new skill (its lines name the old one). */
const skillName = (o: PendingOffer) => one(o.name);

function reason(o: PendingOffer): string {
  const name = skillName(o);
  if (o.moment === 'drift') return fill(DRIFT_COPY.reason, { name });
  if (o.moment === 'retire') return fill(RETIRE_COPY.reason, { name });
  if (isSplit(o)) return fill(UPDATE_COPY.reasonSplit, { name });
  return fill(UPDATE_COPY.reason, { name });
}

/** The command a yes runs (4.11): `trail skills update` for update, extend and replace; 1a's add for a split. */
export function yesCommand2(o: PendingOffer): string {
  if (isSplit(o)) return `trail skills add ${one(o.fold?.splitName ?? o.name)} --run ${runOf(o)}`;
  return `trail skills update ${one(o.name)} --offer ${idOf(o)}`;
}

/** After "show me": the draft, then the offer's own last line again, so Trail reads the answer to it (D72). */
const showStep = (o: PendingOffer) => `run trail skills draft ${runOf(o)} --print, paste what it prints as it is, then ask the last line again: "${one(o.lines?.[1] ?? '', 400)}"`;

function onAnswer(o: PendingOffer): string {
  if (o.moment === 'retire') {
    return 'If they answer retire, Trail retires it itself when it reads their answer, and tells you what to say. If they say keep it, Trail changes nothing.';
  }
  const checks = isSplit(o) ? CHECKS_KEEP : CHECKS;
  const yesWord = o.moment === 'drift' ? 'replace' : 'yes';
  const yes = `If they answer ${yesWord}, run: ${yesCommand2(o)} (${checks}), then tell them the line it prints. `;
  const show = `If they say show me, ${showStep(o)}. `;
  if (o.moment === 'drift') return `${yes}If they say retire, Trail retires it itself when it reads their answer. ${show}If they say leave it, Trail changes nothing.`;
  return `${yes}${show}If they say no, Trail changes nothing.`;
}

/** 3.5 (R11): the Stop block's reason for moments 5, 6 and the retire proposal, given its 2 lines. */
export function blockReason2(o: PendingOffer, [a, b]: [string, string]): string {
  return `[trail] ${FROM_TRAIL} ${reason(o)} When you finish this reply, end it with these 2 lines, ${SO_THEY_ANSWER}:\n${a}\n${b}\n${onAnswer(o)}`;
}

/** 3.4: the post-tool text, for completeness (these moments go out at Stop only, R13). */
export function postTool2(o: PendingOffer, [a, b]: [string, string]): string {
  return `[trail] ${FROM_TRAIL} ${reason(o)} If this check finishes the job, end your reply with these 2 lines, ${SO_THEY_ANSWER}:\n${a}\n${b}\n`
    + "If the job isn't done yet, or you are about to ask the person something, leave them out.";
}

/** `[trail] From Trail, ... They typed "x" <tail>`: the D107 opening, quoting the person's words when there are any. */
function said(typed: string, tail: string): string {
  const q = quoteOf(typed);
  return ['[trail]', FROM_TRAIL, q ? `They typed "${q}"${tail.startsWith('to ') ? ' ' : '. '}${tail}` : tail].join(' ');
}

function offered(o: PendingOffer): string {
  const name = skillName(o);
  if (o.moment === 'drift') return fill(DRIFT_COPY.offered, { name });
  if (o.moment === 'retire') return fill(RETIRE_COPY.offered, { name });
  if (isSplit(o)) return fill(UPDATE_COPY.offeredSplit, { name });
  return fill(UPDATE_COPY.offered, { name });
}

/**
 * 4.7 to 4.10: what the agent reads on the person's answer, as context on the answering prompt (a bare no as a block
 * where the host shows its reason). `c.retired`: the retire the prompt hook made (the folder name), or null when the
 * store was busy and nothing moved.
 */
export function answer2(a: TypedAnswer, o: PendingOffer, c: { paused: boolean; firstNo: boolean; retired?: string | null }, env: NodeJS.ProcessEnv, typed: string, host?: Host): HookOut {
  switch (a) {
    case 'yes': {
      const what = isSplit(o) ? 'to the new skill Trail showed,' : 'to the change Trail showed for';
      const check = isSplit(o) ? CHECKS_KEEP : CHECKS;
      const then = isSplit(o) ? ' Then tell them the line it prints.' : '';
      return { context: said(typed, `${what} ${skillName(o)}. Run: ${yesCommand2(o)}. ${check}.${then}`) };
    }
    case 'show':
      return { context: said(typed, `${offered(o)}, and they want to see it first. To show them, ${showStep(o)}, since Trail reads their answer to that question.`) };
    case 'retire': {
      const name = one(o.retire?.name ?? o.name);
      return { context: said(typed, c.retired ? fill(RETIRE_COPY.retired, { name: one(c.retired) }) : fill(RETIRE_COPY.busy, { name })) };
    }
    case 'no': {
      const say = notSaved(c).replace(/^OK, not saved\./, 'OK, nothing changed.');
      if (hostFacts(env, host).promptBlockShown) return { block: `trail: ${say}` };
      return { context: said(typed, `${offered(o)}, and they said no, so Trail changed nothing. Let them know: "${say}"`) };
    }
    default:
      return o.channel === 'notice' ? {} : {
        context: said(typed, `That isn't an answer to Trail's offer (${offered(o).replace(/^Trail offered /, '')}), so Trail dropped the offer and changed nothing. No need to bring the offer up again.`),
      };
  }
}
