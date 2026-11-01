/**
 * What the agent reads around an offer of moments 3 and 4 (design 4.13 to
 * 4.15): the Stop block's reason, the post-tool text, and the answers to it.
 * `offer-words.ts` hands every non-repeated offer here.
 *
 * Built from `directive-words.ts`, as moment 2's texts are, so every offer
 * reads the same way. D88 and D101: an agent follows hook text it can trust and refuses the rest
 * as prompt injection. So every text says it is from Trail, gives Trail's own
 * reason, quotes the words the person typed when it answers them (in the
 * hook output only, never on disk), and never tells the agent to recite, to
 * skip asking, or that one yes covers more than it does. The 2 lines are
 * Trail's question for the person; the agent ends its reply with them so the
 * person can answer, and Trail reads that answer against the last one.
 *
 * Never "memory" or "remember", no em dashes: the words tests read this file.
 */
import type { Host } from '../trace/host.js';
import type { PendingOffer } from '../trace/types.js';
import type { HookOut } from './types.js';
import { flatLine } from '../notes/flatten.js';
import { WALLS } from '../trace/walls.js';
import { hostFacts } from './host-facts.js';
import { directive, FROM_TRAIL } from './directive-words.js';

const one = (v: unknown, max = 60) => flatLine(v, max);
const KEEP_IT = 'Keep it? (yes / no)';
/** Why the 2 lines end the reply (as p1a/agent-trust says it). */
const SO_THEY_ANSWER = 'so the person can answer (Trail reads their answer to the last line, so keep it as it is)';
const CHECKS_YES = 'Trail checks their yes in this session before it keeps anything.';

/** An offer whose yes keeps a lesson, not a skill: moment 4, or moment 3 kept as a lesson. */
export function isLessonOffer(o: Pick<PendingOffer, 'moment'> & Partial<Pick<PendingOffer, 'repair'>>): boolean {
  return o.moment === 'correction' || (o.moment === 'repaired' && o.repair?.as === 'lesson');
}

/** The wall's fixed words (`"rootless Docker not found"`), or plainer ones. */
export function wallWords(o: Partial<Pick<PendingOffer, 'repair'>>): string {
  return WALLS.find((w) => w.cls === o.repair?.cls)?.words ?? 'a known error';
}

/** The command the agent runs on a yes. */
export function yesCommand(o: PendingOffer): string {
  const id = one(o.offerId, 40);
  if (o.moment === 'correction') return `trail skills lesson ${one(o.name)} --offer ${id}`;
  if (isLessonOffer(o)) return `trail skills lesson --offer ${id}`;
  return `trail skills add ${one(o.name)} --run ${one(o.runId, 40)}`;
}

/** What Trail offered, for the answers. */
function offered(o: PendingOffer): string {
  if (o.moment === 'correction') return `Trail offered to add a learning to the skill ${one(o.name)}, from what they said when they corrected it`;
  if (isLessonOffer(o)) return `Trail offered to keep what got past ${wallWords(o)} as a learning`;
  return `Trail offered to keep the steps that got past ${wallWords(o)} as a skill`;
}

/** Trail's own reason for the offer (D101). */
function reason(o: PendingOffer): string {
  if (o.moment === 'correction') {
    return `The person corrected ${one(o.name)}, a skill Trail brought in for this job; Trail offers once to add what they said to it as a learning.`;
  }
  const program = one(o.repair?.program ?? '', 40) || 'a command';
  const n = Math.floor(Number(o.repair?.nth));
  const times = Number.isFinite(n) && n >= 2 ? `${n} times` : 'more than once';
  return `Trail noticed ${program} failed on ${wallWords(o)} here ${times} and the same change got past it; it offers once to keep that.`;
}

/** After the 2 lines: what to run on each answer. */
function onAnswer(o: PendingOffer): string {
  const yes = `If they answer yes, run: ${yesCommand(o)} (${CHECKS_YES.replace(/\.$/, '')}), then tell them the line it prints. `;
  if (isLessonOffer(o)) return `${yes}If they say no, Trail keeps nothing.`;
  return `${yes}If they say show me, run trail skills draft ${one(o.runId, 40)} --print, paste what it prints, and ask "${KEEP_IT}". If they say no, Trail keeps nothing.`;
}

/** 3.5: the Stop block's reason for a moment 3 or 4 offer, given its 2 lines. */
export function blockReason1b(o: PendingOffer, [a, b]: [string, string]): string {
  return `[trail] ${FROM_TRAIL} ${reason(o)} When you finish this reply, end it with these 2 lines, ${SO_THEY_ANSWER}:\n${a}\n${b}\n${onAnswer(o)}`;
}

/** 3.4: the post-tool text, for completeness (moments 3 and 4 are offered at Stop only). */
export function postTool1b(o: PendingOffer, [a, b]: [string, string]): string {
  return `[trail] ${FROM_TRAIL} ${reason(o)} If this check finishes the job, end your reply with these 2 lines, ${SO_THEY_ANSWER}:\n${a}\n${b}\n`
    + "If the job isn't done yet, or you are about to ask the person something, leave them out.";
}

/** The answers to a moment 3 or 4 offer, as context on the answering prompt (a bare no as a block where the host shows it). */
export function answer1b(a: 'yes' | 'show' | 'no' | 'other', o: PendingOffer, say: string, env: NodeJS.ProcessEnv, typed: string, host?: Host): HookOut {
  switch (a) {
    case 'yes':
      return { context: directive(typed, `${offered(o)}, and this is their answer. To keep it as they said, run: ${yesCommand(o)}. ${CHECKS_YES} Then tell them the line it prints.`) };
    case 'show':
      if (isLessonOffer(o)) return answer1b('other', o, say, env, typed, host);
      return { context: directive(typed, `${offered(o)}, and they want to see it first. Run trail skills draft ${one(o.runId, 40)} --print, paste what it prints as it is, then ask "${KEEP_IT}", since Trail reads their answer to that question.`) };
    case 'no':
      if (hostFacts(env, host).promptBlockShown) return { block: `trail: ${say}` };
      return { context: directive(typed, `${offered(o)}, and they said no, so Trail kept nothing. Let them know: "${say}"`) };
    default:
      return o.channel === 'notice' ? {} : {
        context: directive(typed, `That isn't an answer to Trail's offer (${offered(o).replace(/^Trail offered /, '')}), so Trail dropped the offer and kept nothing. No need to bring the offer up again.`),
      };
  }
}
