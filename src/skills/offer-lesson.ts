/**
 * Moment 4 (design 4.14, J07): the person corrected a skill Trail brought
 * in, within 2 typed prompts of its use, in a form Trail can read as a
 * lesson ("no, it didn't push the tag"). At the Stop of that turn Trail
 * offers to add the lesson to the skill, with its exact text in line 2.
 *
 * The prompt hook only records the correction's sha (`creditWindow`); the
 * offer needs the fold to have found the person's own typed line with that
 * sha (`corrected.offset`, `noteCorrectionLine`), so the hook's payload alone
 * never makes an offer and the agent's text can't fill it (R27). The lesson
 * starts from the person's words, read back by that pointer; the fix command
 * is the first new step that worked after the correction, held to the rules
 * every skill step and every repair delta meets (R27, D104).
 *
 * Nothing typed is written: the pending offer keeps the pointer, the fix
 * command and the lesson's sha, and its lines are rebuilt by `offerLinesOf`.
 */
import { homedir } from 'node:os';
import { useFor } from '../trace/dialect.js';
import type { GateCtx } from '../trace/skill-session.js';
import type { PendingOffer, RunCall, SkillSessionState } from '../trace/types.js';
import { commandKind, relativizePaths, stepMatches } from '../trace/shell.js';
import { secretReason } from '../notes/secrets.js';
import { gatedKind } from './risk.js';
import { neverSave } from './never-save.js';
import { riskyCommand } from './risk-delta.js';
import { listAllPersonal, readSkill } from './store.js';
import { readLessons, lessonRefused, lessonSha, lessonText, correctionPhrase } from './lessons.js';
import { newOfferId, offerBudget } from './offers.js';
import { typedLineAt } from './offer-lines.js';
import type { OfferDue, OfferInput } from './offer-moment.js';

export { offerLinesOf, correctionLesson, correctionLines, typedLineAt, type OfferLinesIn } from './offer-lines.js';

/** A skill with this many lessons gets no more offers (4.14 step 4). */
export const MAX_LESSONS = 10;
/** A fix command longer than this is not used: the lesson is the phrase alone (4.14 step 3). */
const FIX_MAX = 300;

/** The calls the session still holds that came after `offset` in the transcript, in transcript order. */
function callsAfter(st: SkillSessionState, offset: number): RunCall[] {
  const all = st.runs.flatMap((r) => (Array.isArray(r.calls) ? r.calls : []));
  return all.filter((c) => Number.isInteger(c.src?.use) && c.src.use > offset).sort((a, b) => a.src.use - b.src.use);
}

/** A call that ran and worked, with its whole command: a result read, not failed, not in the background. */
const worked = (c: RunCall) => !c.failed && typeof c.cmd === 'string' && !c.truncated && !c.secret && c.bg !== true
  && (c.src?.result != null || c.fromMark === true);

/**
 * 4.14 step 3: the first call after the correction that worked, is a step-kind call and matches no step of the
 * skill, as the lesson holds it: params put back by `lessonText`, paths relativized here. Null (the phrase alone)
 * when there is none, or it carries a secret, is on the never-save list, is gated, teaches a way around a check
 * (D104) or runs past 300 characters. `id` is the call's, also when its command isn't used.
 */
export function fixCommand(st: SkillSessionState, offset: number, steps: string[], params: Record<string, string>,
  where: { checkout: string; home: string }): { id: string | null; cmd: string | null } {
  for (const c of callsAfter(st, offset)) {
    if (!worked(c) || c.kind !== 'step' || commandKind(c.cmd!) !== 'step') continue;
    if (steps.some((s) => stepMatches(s, c.cmd!, params))) continue;
    const cmd = relativizePaths(c.cmd!, where.checkout, where.home).trim();
    const bad = !cmd || cmd.length > FIX_MAX || secretReason(cmd) !== null || neverSave(cmd) !== null || gatedKind(cmd) !== null || riskyCommand(cmd);
    return { id: c.id, cmd: bad ? null : cmd };
  }
  return { id: null, cmd: null };
}

type Why = 'learn' | 'pending' | 'no-watch' | 'no-line' | 'end' | 'skill' | 'lessons' | 'phrase' | 'refused' | `budget:${string}`;

/**
 * Moment 4 (4.14). Called first by offerDue at Stop, inside the session lock. Due: the offer to hold as
 * `pendingOffer`, its lines null (rebuilt by offerLinesOf). Writes nothing.
 */
export function lessonOfferDue(i: OfferInput & { ctx: OfferInput['ctx'] & Pick<GateCtx, 'transcriptPath'> }): OfferDue | { due: false; why: Why } {
  const { run, verdict, st, ctx, channel } = i;
  const env = ctx.env;
  if (!ctx.learn) return { due: false, why: 'learn' };
  if (st.pendingOffer) return { due: false, why: 'pending' };
  const watch = st.lessonWatch;
  if (!watch) return { due: false, why: 'no-watch' };
  const credit = st.credit.find((c) => c.useId === watch.useId && c.skillId === watch.skillId && c.corrected?.sha === watch.typedSha);
  const offset = credit?.corrected?.offset;
  // R27: only once the fold met the person's own typed line with the hook's sha.
  if (!credit || typeof offset !== 'number' || !ctx.transcriptPath) return { due: false, why: 'no-line' };
  if (verdict.end === 'failure' || verdict.end === 'question') return { due: false, why: 'end' };

  const ref = listAllPersonal(env).find((r) => r.id === watch.skillId);
  const skill = ref ? readSkill(ref) : null;
  if (!ref || !skill) return { due: false, why: 'skill' };
  if (readLessons(ref.dir).length >= MAX_LESSONS) return { due: false, why: 'lessons' };

  const typed = typedLineAt(ctx.transcriptPath, offset, watch.typedSha, env, useFor(st.host, st));
  const phrase = typed === null ? null : correctionPhrase(typed);
  if (!phrase) return { due: false, why: 'phrase' };

  const repo = run.repoKey || ctx.repoKey;
  const key = `${watch.skillId}|correction`;
  // P18, R40: a pending offer this same correction withdrew frees the session's slot for this one offer only.
  const freed = st.withdrewFor?.typedSha === watch.typedSha;
  const budget = offerBudget({ repoKey: repo, key, sessionOfferUsed: st.offerUsed && !freed, now: ctx.now, env });
  if (!budget.ok) return { due: false, why: `budget:${budget.why}` };

  const inj = st.injected.find((x) => x.injId === credit.injId);
  const params = inj && inj.params && typeof inj.params === 'object' ? inj.params : {};
  const fix = fixCommand(st, offset, skill.steps.map((s) => s.cmd), params, { checkout: ctx.checkout, home: env.HOME || homedir() });
  let text = lessonText(phrase, fix.cmd, params);
  const alone = lessonText(phrase, null, params);
  if (!text || !alone) return { due: false, why: 'phrase' };
  // The fix as the lesson holds it (params put back), so offerLinesOf rebuilds this very text from the typed line.
  let kept: string | null = fix.cmd && text.startsWith(`${alone}: `) ? text.slice(alone.length + 2) : null;
  if (kept !== null && lessonText(phrase, kept, {}) !== text) kept = null;
  if (kept === null || lessonRefused(text)) {
    kept = null;
    text = alone;
  }
  // D109: the final text is held to the run block's rule too (a skip-the-ask lesson is never offered).
  if (lessonRefused(text)) return { due: false, why: 'refused' };
  const offer: PendingOffer = {
    offerId: newOfferId(), moment: 'correction', runId: credit.runId ?? run.id, name: skill.name, key, lines: null, channel,
    shownAt: channel === 'post-tool' ? null : ctx.now.toISOString(), showMe: false, yes: null, typedAfter: [], repo,
    correction: { skillId: watch.skillId, useId: watch.useId, typed: { offset, sha: watch.typedSha }, fixCallId: fix.id, lessonSha: lessonSha(text), fix: kept },
  };
  return { due: true, offer };
}
