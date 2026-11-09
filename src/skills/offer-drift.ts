/**
 * Moment 6 (phase 2 design 4.8, J15, P10, P15, P16, P17, rule 13): a skill
 * that needs a fix is never brought in for its job, so when that job checks
 * out from scratch another way, Trail offers once to replace the skill with
 * the steps that just worked, retire it, or leave it.
 *
 * "Another way" is counted from the run: a skill step that matches no step
 * of the fresh compile, or a fresh step that matches no skill step. A run the
 * same way as the skill isn't drift (its failures were something else, P15).
 * The new version is c2's `replan(..., 'replace')`: `replaceWith` of the
 * fresh compile, keeping the skill's id, name, scope, applies, job and asks
 * (P17), compiled under every copy rule; the size gate doesn't apply (P10).
 * A "retire" answer is the prompt hook's own move (4.9), so the offer names
 * the skill in `retire` as well.
 *
 * Writes nothing: the caller records the offer shown.
 */
import type { CompiledSkill } from './types.js';
import type { OfferDue, OfferInput } from './offer-moment.js';
import { ranAs } from './ledger.js';
import { fillParams } from './params.js';
import { normalizeCommand } from '../trace/shell.js';
import { getSkillState } from './state.js';
import { listAllPersonal, readSkill } from './store.js';
import { driftOfferKey, newOfferId, offerBudget } from './offers.js';
import { checkLine } from './offer-words.js';
import { driftLines } from './offer-words-2.js';
import { versionNumber } from './offer-update.js';

type Why = 'learn' | 'pending' | 'channel' | 'skill-run' | 'job' | 'not-checked' | 'no-sheet' | 'no-skill' | 'version' | 'no-plan'
  | 'replan' | 'one-step' | 'same-way' | `budget:${string}`;

/** The values a fresh compile filled its params with (this run's). */
const freshValues = (c: CompiledSkill) => Object.fromEntries(c.params.filter((p) => p.seen[0] !== undefined).map((p) => [p.name, p.seen[0]!]));

/** 4.8 step 2: the skill steps the run skipped and the fresh steps the skill doesn't have, in order. */
export function wentAnotherWay(base: CompiledSkill, fresh: CompiledSkill): { skipped: Array<{ n: number; cmd: string }>; ran: string[] } {
  const filled = fresh.steps.map((s) => fillParams(s.cmd, freshValues(fresh)));
  const isCheck = (cmd: string) => !!base.check && normalizeCommand(cmd) === normalizeCommand(base.check);
  const skipped = base.steps.filter((b) => !isCheck(b.cmd) && !filled.some((f) => ranAs(b.cmd, f, {}))).map((b) => ({ n: b.n, cmd: b.cmd }));
  const ran = filled.filter((f) => !base.steps.some((b) => ranAs(b.cmd, f, {})) && !(base.check && ranAs(base.check, f, {})));
  return { skipped, ran };
}

/** Applies here: this repo's skill, or one for every repo. */
const appliesTo = (applies: string | null | undefined, repoKey: string) =>
  applies === 'every repo' || (!!applies && applies.toLowerCase() === repoKey.toLowerCase());

/** 4.8: moment 6's conditions 1 to 3. */
export function driftOfferDue(i: OfferInput): OfferDue | { due: false; why: Why } {
  const { run, verdict, st, ctx, channel } = i;
  const env = ctx.env;
  if (!ctx.learn) return { due: false, why: 'learn' };
  if (st.pendingOffer) return { due: false, why: 'pending' };
  if (channel !== 'stop' && channel !== 'notice') return { due: false, why: 'channel' };
  // 1. A run no block drove (a needs-fix skill is never injected), of a job, checked.
  if (run.skillId) return { due: false, why: 'skill-run' };
  if (!run.job) return { due: false, why: 'job' };
  if (!verdict.checked || verdict.checkIndex === null) return { due: false, why: 'not-checked' };
  const hit = run.calls[verdict.checkIndex]?.check;
  if (!hit || !hit.passed) return { due: false, why: 'not-checked' };
  const sheet = i.sheet;
  if (!sheet || sheet.id !== run.id) return { due: false, why: 'no-sheet' };
  const repo = run.repoKey || ctx.repoKey;

  // A personal skill (rule 13) for this job, needs-fix, that applies here; by name, so the pick is stable.
  const refs = listAllPersonal(env).filter((r) => r.scope === 'personal').sort((a, b) => a.name.localeCompare(b.name));
  let last: Why = 'no-skill';
  for (const ref of refs) {
    const state = getSkillState(ref.id, env);
    if (!state || state.status !== 'needs-fix' || state.scope !== 'personal') continue;
    const skill = readSkill(ref, state);
    if (!skill || skill.meta.trail !== ref.id || skill.meta.job !== run.job || !appliesTo(skill.meta.applies ?? ref.applies, repo)) continue;
    const version = versionNumber(skill.meta.version);
    if (version === null) { last = 'version'; continue; }
    // 3. The budget, keyed per version (P8).
    const key = driftOfferKey(ref.id, version);
    const budget = offerBudget({ repoKey: repo, key, sessionOfferUsed: st.offerUsed, now: ctx.now, env });
    if (!budget.ok) { last = `budget:${budget.why}`; continue; }
    // 2. The run compiles to 2 or more steps (D70) and went another way (P15).
    if (!i.plan) return { due: false, why: 'no-plan' };
    const r = i.plan.replan(ref.id, run.id, 'replace', env, { now: ctx.now });
    if (!r || !r.fresh) { last = 'replan'; continue; }
    if (r.next.steps.length < 2) { last = 'one-step'; continue; }
    const way = wentAnotherWay(r.base, r.fresh);
    if (!way.skipped.length && !way.ran.length) { last = 'same-way'; continue; }
    const lines = driftLines({ check: checkLine(hit), name: ref.name, job: run.job, steps: r.next.steps.length, ...way, handEdited: r.handEdited });
    return {
      due: true,
      offer: {
        offerId: newOfferId(), moment: 'drift', runId: run.id, name: ref.name, key, lines, channel,
        shownAt: ctx.now.toISOString(), showMe: false, yes: null, typedAfter: [], repo,
        fold: { op: 'replace', skillId: ref.id, baseHash: r.baseHash, proposalSha: r.proposalSha, handEdited: r.handEdited, version },
        retire: { skillId: ref.id, name: ref.name },
      },
    };
  }
  return { due: false, why: last };
}
