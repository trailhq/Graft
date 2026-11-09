/**
 * The words of a repeated-job offer and of the answers to it (design 3.4,
 * 3.5, 4.12, spec 9). Re-exported from `offers.ts`, where the design names
 * them.
 *
 * An offer is exactly 2 lines the agent says word for word: what checked out
 * and what it cost, in numbers counted from the transcript, then the
 * question with its three keys. Every value is flattened to one line, so a
 * branch name or a version from a command can never add a line. Never
 * "memory" or "remember", no em dashes: a test greps every string here.
 */
import type { Host } from '../trace/host.js';
import type { DialectUse } from '../trace/dialect.js';
import type { CheckHit, JobClass, PendingOffer } from '../trace/types.js';
import type { HookOut } from './types.js';
import { flatLine } from '../notes/flatten.js';
import { JOB_CLASSES } from '../trace/jobs.js';
import { hostFacts } from './host-facts.js';
import { directive, FROM_TRAIL } from './directive-words.js';
import { offerLinesOf } from './offer-lines.js';
import { answer1b, blockReason1b, postTool1b } from './offer-words-1b.js';
import { answer2, blockReason2, postTool2 } from './offer-words-2.js';

/** Phase 2 (R11): moments 5 and 6 and the retire proposal have words of their own (offer-words-2.ts). */
const isPhase2 = (o: Pick<PendingOffer, 'moment'>) => o.moment === 'update' || o.moment === 'drift' || o.moment === 'retire';

export interface OfferFacts {
  job: JobClass; check: CheckHit; ordinal: number; unit: 'day' | 'time';
  commands: number; failed: number; steps: number; where: 'this repo' | 'every repo';
  branches: string[];           // stable branches pushed, in order (ship)
}

/** For `trail skills` (2.10), once per time the governor turns on. */
export const GOVERNOR_LINE = 'you kept fewer than 1 in 3 offers lately, so a job now has to come back a 4th day before Trail offers it';

/** One line, at most `max` characters; '' when nothing is left. */
const one = (v: unknown, max = 40) => flatLine(v, max);

export function ordinalWord(n: number): string {
  const k = Math.max(0, Math.floor(n));
  const teen = k % 100;
  if (teen >= 11 && teen <= 13) return `${k}th`;
  return `${k}${['th', 'st', 'nd', 'rd'][k % 10] ?? 'th'}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "beta and prod", "beta, staging and prod". */
function listed(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The ship subject and its verb: "beta and prod are both", "prod is", "beta, staging and prod are all". */
function shipSubject(branches: string[]): string | null {
  const b = [...new Set(branches.map((x) => one(x)).filter(Boolean))];
  if (!b.length) return null;
  if (b.length === 1) return `${b[0]} is`;
  return `${listed(b)} are ${b.length === 2 ? 'both' : 'all'}`;
}

/** 4.12's lead: what checked out, from the check's facts. Facts missing: the plainer words. */
function lead(f: OfferFacts): string {
  const facts = f.check.facts;
  const sha = one(facts.sha ?? '').slice(0, 7);
  switch (f.check.family) {
    case 'npm-view': {
      const v = one(facts.version ?? '');
      return `Published ${v || 'the new version'}: npm shows it.`;
    }
    case 'deploy': {
      const state = one(facts.state ?? '') || 'ready';
      const subject = shipSubject(f.branches);
      if (subject) return `Shipped: ${subject}${sha ? ` at ${sha}` : ''} and ${state}.`;
      return `Shipped: the deploy${sha ? ` at ${sha}` : ''} is ${state}.`;
    }
    case 'ls-remote':
    case 'push': {
      const remote = one(facts.remote ?? '') || 'the remote';
      const subject = shipSubject(f.branches.length ? f.branches : facts.branch ? [facts.branch] : []);
      if (subject && sha) return `Shipped: ${subject} at ${sha} on ${remote}.`;
      if (subject) return `Shipped: ${subject.replace(/ (?:is|are (?:both|all))$/, '')} moved on ${remote}.`;
      return `Shipped: ${sha ? `${sha} is` : 'it is'} on ${remote}.`;
    }
    case 'tests': {
      const n = facts.passedCount;
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? `Tests pass (${Math.floor(n)} passed).` : 'Tests pass.';
    }
    case 'query':
      return 'Done: the numbers are in.';
    default:
      return 'Done: the check passed.';
  }
}

/** 1b (4.13): the check's own line, as moment 2's line 1 opens (`Tests pass (12 passed).`), for moment 3's line 1. */
export function checkLine(check: CheckHit, branches: string[] = []): string {
  return lead({ check, branches } as unknown as OfferFacts);
}

/** 4.12's line 2: the question an offer's yes answers. `n` is the skill's steps (a separate check counts as one). */
export function keepLine(n: number, where: 'this repo' | 'every repo' = 'this repo'): string {
  const k = Math.max(0, Math.floor(n));
  return `Keep the ${k === 1 ? 'one' : k} that worked as a skill, just for you in ${where === 'every repo' ? 'every repo' : 'this repo'}? (yes / show me / no)`;
}

const KEEP_RE = /^Keep the (?:one|[1-9]\d*) that worked as a skill, just for you in (?:this repo|every repo)\? \(yes \/ show me \/ no\)$/;
/** Moment 3's line 2 for a skill (4.13, offer-repair.ts `repairLines`). */
const REPAIR_KEEP_RE = /^Keep the [1-9]\d* working steps as a skill, just for you in this repo\? \(yes \/ show me \/ no\)$/;
/** `line` is a line 2 that `keepLine` (or moment 3's `repairLines`) writes, and nothing else (a question of the agent's own is not). */
export function isKeepLine(line: string): boolean {
  const l = String(line ?? '');
  return KEEP_RE.test(l) || REPAIR_KEEP_RE.test(l);
}

/** The question after "show me" and the draft (4.12): a yes after the draft answers this. */
export const KEEP_IT = 'Keep it? (yes / no)';

/** Spaces collapsed, and what a reply may dress its last line with (bold, italics, quotes, a full stop) taken off the end. */
const bare = (t: string) => String(t ?? '').replace(/\s+/g, ' ').trim().replace(/[\s*_`"'\u2018\u2019\u201c\u201d.]+$/u, '');

/** The reply's last words are `line` (said word for word as its last line): nothing after it, no question of the agent's own. */
export function endsWithLine(reply: string, line: string): boolean {
  const l = bare(line);
  return l.length > 0 && bare(reply).endsWith(l);
}

/** 4.12: exactly 2 lines, every number counted from the trace, every value flattened. */
export function offerLines(f: OfferFacts): [string, string] {
  const noun = JOB_CLASSES.find((j) => j.job === f.job)?.noun ?? 'job';
  const commands = Math.max(0, Math.floor(f.commands));
  const failed = Math.max(0, Math.floor(f.failed));
  const cost = failed ? `${plural(commands, 'command')} this time, ${failed} failed` : `${plural(commands, 'command')} this time`;
  const line1 = `${lead(f)} That's the ${ordinalWord(f.ordinal)} ${f.unit === 'day' ? 'day' : 'time'} I've worked out this ${noun} from scratch (${cost}).`;
  return [flatLine(line1, 400), flatLine(keepLine(f.steps, f.where), 400)];
}

/**
 * 1b (R12): the offer's lines through offerLinesOf (a correction's are rebuilt from the transcript); null when it has
 * none, and then its texts are empty, so nothing goes out.
 */
function lines(o: PendingOffer, transcriptPath: string | null, use?: DialectUse): [string, string] | null {
  const l = offerLinesOf(o, transcriptPath, process.env, use);
  return l ? [flatLine(l[0], 400), flatLine(l[1], 400)] : null;
}
const nameOf = (o: PendingOffer) => one(o.name, 60);
const runOf = (o: PendingOffer) => one(o.runId, 40);

/** D101: Trail's own reason for an offer, from its count: "Trail noticed this job worked out on 3 days; it offers once to keep it." */
function offerReason(o: PendingOffer): string {
  const n = Math.floor(Number(o.seen?.n));
  const how = !Number.isFinite(n) || n < 2 ? 'more than once' : o.seen?.unit === 'time' ? `${n} times` : `on ${n} days`;
  return `Trail noticed this job worked out ${how}; it offers once to keep it.`;
}

/** Why the 2 lines end the reply: the person answers the last one, and Trail matches that answer to its words. */
const SO_THEY_ANSWER = 'so the person can answer (Trail reads their answer to the last line, so keep it as it is)';

/**
 * 3.5: the Stop block's reason, which the agent reads. D101: from Trail, with Trail's own reason for offering; the
 * 2 lines are Trail's question for the person, never an order to recite.
 */
export function stopBlockReason(o: PendingOffer, transcriptPath: string | null = null, use?: DialectUse): string {
  const both = lines(o, transcriptPath, use);
  if (!both) return '';
  if (isPhase2(o)) return blockReason2(o, both);
  if (o.moment !== 'repeated') return blockReason1b(o, both);
  const [a, b] = both;
  return `[trail] ${FROM_TRAIL} ${offerReason(o)} If the job is done, end your reply with these 2 lines, ${SO_THEY_ANSWER}:\n${a}\n${b}\n`
    + `If they answer yes, run: trail skills add ${nameOf(o)} --run ${runOf(o)} (Trail checks their yes in this session before it keeps anything), then tell them the line it prints. `
    + `If they say show me, run trail skills draft ${runOf(o)} --print, paste what it prints, and ask "${KEEP_IT}". `
    + 'If they say no, Trail keeps nothing.';
}

/** 3.5: the Stop notice the person reads (channel `notice`). */
export function noticeText(o: PendingOffer, transcriptPath: string | null = null, use?: DialectUse): string {
  const both = lines(o, transcriptPath, use);
  if (!both) return '';
  const [a, b] = both;
  return `trail: ${a}\n${b}`;
}

/** 3.4: the passing check's PostToolUse context (channel `post-tool`). */
export function postToolOfferText(o: PendingOffer, transcriptPath: string | null = null): string {
  const both = lines(o, transcriptPath);
  if (!both) return '';
  if (isPhase2(o)) return postTool2(o, both);
  if (o.moment !== 'repeated') return postTool1b(o, both);
  const [a, b] = both;
  return `[trail] ${FROM_TRAIL} ${offerReason(o)} If this check finishes the job, end your reply with these 2 lines, ${SO_THEY_ANSWER}:\n${a}\n${b}\n`
    + "If the job isn't done yet, or you are about to ask the person something, leave them out.";
}

/** What "OK, not saved." grows into: the way to stop offers on the first no ever, the pause when it starts. */
export function notSaved(c: { paused: boolean; firstNo: boolean }): string {
  if (c.paused) return "OK, not saved. I won't offer skills in this repo for 2 weeks. (To stop them everywhere: trail skills offers off)";
  if (c.firstNo) return 'OK, not saved. (To stop these offers: trail skills offers off)';
  return 'OK, not saved.';
}

/**
 * 4.12, as context on the answering prompt; a bare no as a block where the host shows its reason (O2). D101: each
 * directive says it is from Trail, quotes the words the person typed (`typed`, from the prompt hook's payload, never
 * stored) and says why. 1b: a moment 3 or 4 offer's answers are `answer1b`'s, which need no lines.
 */
export function answerDirective(a: 'yes' | 'show' | 'no' | 'other', o: PendingOffer, c: { paused: boolean; firstNo: boolean }, env: NodeJS.ProcessEnv = process.env, typed: string = '', host?: Host): HookOut {
  if (isPhase2(o)) return answer2(a, o, c, env, typed, host);
  if (o.moment !== 'repeated') return answer1b(a, o, notSaved(c), env, typed, host);
  switch (a) {
    case 'yes':
      return { context: directive(typed, `${OFFERED}, and this is their answer. To keep it as they said, run: trail skills add ${nameOf(o)} --run ${runOf(o)}. ${CHECKS_YES} Then tell them the line it prints.`) };
    case 'show':
      return { context: directive(typed, `${OFFERED}, and they want to see it first. Run trail skills draft ${runOf(o)} --print, paste what it prints as it is, then ask "${KEEP_IT}", since Trail reads their answer to that question.`) };
    case 'no': {
      const say = notSaved(c);
      if (hostFacts(env, host).promptBlockShown) return { block: `trail: ${say}` };
      return { context: directive(typed, `${OFFERED}, and they said no, so Trail kept nothing. Let them know: "${say}"`) };
    }
    default:
      // The agent said the offer (stop, post-tool): it can let it go. A notice it never saw needs nothing.
      return o.channel === 'notice' ? {} : {
        context: directive(typed, "That isn't an answer to Trail's offer to keep the last job as a skill, so Trail dropped the offer and kept nothing. No need to bring the offer up again."),
      };
  }
}

/** What an answer directive says the offer was. */
const OFFERED = 'Trail offered to keep the last job as a skill';
/** Why the agent may run the add: the gate checks the yes, the agent's word is not taken for it. */
const CHECKS_YES = 'Trail checks their yes in this session before it keeps anything.';
