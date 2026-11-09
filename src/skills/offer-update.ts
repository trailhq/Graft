/**
 * Moment 5 (phase 2 design 4.7, P1, P5, P8, P9, P29, R3, R14, rule 13): a
 * skill's block drove a run that checked out and did one thing differently,
 * so Trail offers once to change the skill to match: update a step done
 * another way, extend it with at most 2 steps a lesson or the use before
 * backs, or split the steps two uses ran into a skill of their own.
 *
 * The plan is c1's `planFold` on c2's `foldInputFor`; the pin (the text a
 * yes would write and the file it was computed from) is c2's `replan`, the
 * same function both halves of `trail skills update` run, so the offer and
 * the gate can't disagree. Both come in through `OfferInput.plan` (c8 passes
 * update-gate.ts's): without them nothing is due. A split is saved through
 * 1a's add gate, pinned by `skillSha` of the compile that gate checks (R3).
 *
 * Writes nothing: the caller records the offer shown.
 */
import type { PendingOffer, SkillInjection } from '../trace/types.js';
import type { CompiledSkill, FoldOp } from './types.js';
import type { FoldInput, FoldPlan } from './fold.js';
import type { OfferDue, OfferInput } from './offer-moment.js';
import { planFold } from './fold.js';
import { fillParams } from './params.js';
import { runLinesChanged } from './skill-diff.js';
import { skillHash } from './skillmd.js';
import { getSkillState } from './state.js';
import { listAllPersonal, readSkill } from './store.js';
import { newOfferId, offerBudget, updateOfferKey } from './offers.js';
import { checkLine } from './offer-words.js';
import { updateLines } from './offer-words-2.js';
import { compileOffered, skillSha } from './offer-moment.js';

/** What a planner is given of the block: its filled params and steps, when it came in, its check. */
export type PlanInj = Pick<SkillInjection, 'params' | 'steps' | 'at' | 'check'>;

/** c2's plan again, from the run sheet and the file as they are now (update-gate.ts `replan`). */
export interface Replanned {
  next: CompiledSkill; text: string; proposalSha: string; baseHash: string; handEdited: boolean;
  plan: FoldPlan | null; base: CompiledSkill; fresh: CompiledSkill | null;
}

/** c2's two shared functions (update-gate.ts), passed in so the offer and both halves of the gate plan alike. */
export interface FoldPlanner {
  foldInputFor(skillId: string, runId: string, env: NodeJS.ProcessEnv, o?: { inj?: PlanInj; now?: Date }): FoldInput | null;
  replan(skillId: string, runId: string, op: FoldOp | 'replace', env: NodeJS.ProcessEnv, o?: { inj?: PlanInj; now?: Date }): Replanned | null;
}

type Why = 'learn' | 'pending' | 'channel' | 'no-skill' | 'not-checked' | 'no-sheet' | 'not-settled' | 'corrected' | 'skill' | 'status'
  | 'version' | 'no-plan' | 'replan' | 'compile' | `plan:${string}` | `budget:${string}`;

/** A version Trail can key and bump: a positive integer. */
export const versionNumber = (v: unknown): number | null => (/^[1-9]\d{0,5}$/.test(String(v ?? '')) ? Number(v) : null);

/** 4.7: moment 5's conditions 1 to 5, in order. */
export function updateOfferDue(i: OfferInput): OfferDue | { due: false; why: Why } {
  const { run, verdict, st, ctx, channel } = i;
  const env = ctx.env;
  if (!ctx.learn) return { due: false, why: 'learn' };
  if (st.pendingOffer) return { due: false, why: 'pending' };
  // R13: the facts exist only at Stop.
  if (channel !== 'stop' && channel !== 'notice') return { due: false, why: 'channel' };
  const skillId = run.skillId;
  if (!skillId) return { due: false, why: 'no-skill' };
  if (!verdict.checked || verdict.checkIndex === null) return { due: false, why: 'not-checked' };
  const hit = run.calls[verdict.checkIndex]?.check;
  if (!hit || !hit.passed) return { due: false, why: 'not-checked' };
  const sheet = i.sheet;
  if (!sheet || sheet.id !== run.id) return { due: false, why: 'no-sheet' };

  // 1. This Stop's settle flushed this run's use of the skill with its check passed (spec 9: a checked success).
  const parts = new Set([run.id, ...(sheet.joined ?? []).map((j) => j.id)]);
  const settled = (i.settled ?? []).find((s) => s.skillId === skillId && s.use.check === 'passed'
    && s.injIds.some((id) => parts.has(st.injected.find((x) => x.injId === id)?.runId ?? '')));
  if (!settled) return { due: false, why: 'not-settled' };
  const inj = st.injected.filter((x) => settled.injIds.includes(x.injId)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const block = inj[inj.length - 1]!;
  // 3. No correction came after the use (moment 4 goes first).
  if (st.credit.some((c) => c.useId === settled.use.useId && c.corrected) || st.lessonWatch?.useId === settled.use.useId) return { due: false, why: 'corrected' };

  // 2. Personal (rule 13), Trail's, active or candidate.
  const ref = listAllPersonal(env).find((r) => r.id === skillId);
  const state = ref ? getSkillState(skillId, env) : null;
  const skill = ref ? readSkill(ref, state) : null;
  if (!ref || !skill || !state || ref.scope !== 'personal' || state.scope !== 'personal' || skill.meta.trail !== skillId) return { due: false, why: 'skill' };
  if (state.status !== 'active' && state.status !== 'candidate') return { due: false, why: 'status' };
  const version = versionNumber(skill.meta.version);
  if (version === null) return { due: false, why: 'version' };

  // 5. The budget, keyed per version (P8).
  const repo = run.repoKey || ctx.repoKey;
  const key = updateOfferKey(skillId, version);
  const budget = offerBudget({ repoKey: repo, key, sessionOfferUsed: st.offerUsed, now: ctx.now, env });
  if (!budget.ok) return { due: false, why: `budget:${budget.why}` };

  // 4. The plan.
  if (!i.plan) return { due: false, why: 'no-plan' };
  const o = { inj: { params: block.params, steps: block.steps, at: inj[0]!.at, check: block.check }, now: ctx.now };
  const fi = i.plan.foldInputFor(skillId, run.id, env, o);
  if (!fi) return { due: false, why: 'no-plan' };
  const plan = planFold(fi);
  if (plan.op === 'none') return { due: false, why: `plan:${plan.why}` };

  const check = checkLine(hit);
  const base: Omit<PendingOffer, 'lines' | 'name'> = {
    offerId: newOfferId(), moment: 'update', runId: run.id, key, channel,
    shownAt: ctx.now.toISOString(), showMe: false, yes: null, typedAfter: [], repo,
  };
  if (plan.op === 'split') {
    // R3: the split saves through 1a's add gate, which compiles the run as moment 2's offer does; the pin is that skill.
    const c = compileOffered(sheet, st, ctx);
    if (!c.ok || c.skill.steps.length < 2) return { due: false, why: 'compile' };
    const sha = skillSha(c.skill);
    const lines = updateLines({ op: 'split', check, name: ref.name, job: run.job ?? skill.meta.job ?? 'job', at: 0, cmds: [], changes: 0,
      split: { from: plan.from, to: plan.to, name: c.skill.name }, handEdited: false });
    return {
      due: true,
      offer: {
        ...base, name: c.skill.name, lines, skillSha: sha,
        fold: { op: 'split', skillId, baseHash: skillHash(fi.text), proposalSha: sha.slice(0, 16), handEdited: false, splitName: c.skill.name, version },
      },
    };
  }
  const r = i.plan.replan(skillId, run.id, plan.op, env, o);
  if (!r || (r.plan && r.plan.op !== plan.op)) return { due: false, why: 'replan' };
  const vals = block.params ?? {};
  const more = plan.op === 'update' && plan.why === 'preference' ? plan.more ?? [] : [];
  const cmds = plan.op === 'update' ? [plan.cmd, ...more].map((c) => fillParams(c.cmd, vals)) : plan.cmds.map((c) => fillParams(c.cmd, vals));
  const lessonIds = plan.op === 'extend' && plan.why === 'lesson' ? plan.lessonIds : [];
  const lessonDate = fi.lessons.find((l) => lessonIds.includes(l.id))?.at;
  const lines = updateLines({
    op: plan.op, why: plan.why, ...(plan.op === 'update' && plan.why === 'preference' ? { follows: plan.follows, steps: [plan.step, ...more.map((c) => c.n)] } : {}),
    check, name: ref.name, job: run.job ?? skill.meta.job ?? 'job', at: plan.op === 'update' ? plan.step : plan.at,
    cmds, changes: runLinesChanged(r.base, r.next), ...(lessonDate ? { lessonDate } : {}), handEdited: r.handEdited,
  });
  return {
    due: true,
    offer: {
      ...base, name: ref.name, lines,
      fold: { op: plan.op, skillId, baseHash: r.baseHash, proposalSha: r.proposalSha, handEdited: r.handEdited, version, ...(lessonIds.length ? { lessonIds } : {}) },
    },
  };
}
