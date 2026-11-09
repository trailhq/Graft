/**
 * Moment 2 and the answers to it, in one place (design 3.2 steps 4 and 6.4,
 * 3.4, 3.5 step 10, 4.12): when a repeated-job offer is due, what an answer
 * to it leaves in the session, and what a save request leaves.
 *
 * `captureAnswer` is the only place a `yes` is recorded, and
 * `noteSaveRequest` the only place a save request is: the save gate trusts
 * nothing else. Both take the person's typed words from the prompt hook's
 * payload; the gate then needs the same words, by hash, on a line the
 * person typed in the transcript (4.9 step 5).
 *
 * Either order of the prompt hook and the transcript works. When Claude Code
 * has written the typed line before the hook runs, the hook's own catch-up
 * folds it before a save request exists, so `noteSaveRequest` takes the line
 * from that catch-up (`fold.typed`); otherwise a later fold fills it in.
 */
import type { Host } from '../trace/host.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { CheckedVerdict, FoldResult } from '../trace/runs.js';
import type { GateCtx } from '../trace/skill-session.js';
import type { OfferChannel, PendingOffer, RunSheet, RunState, SkillSessionState, TypedAnswer } from '../trace/types.js';
import type { CompiledSkill, HookOut } from './types.js';
import { typedSha } from '../trace/typed.js';
import { OFFER_FAMILIES } from '../trace/jobs.js';
import { readPool, repeatedEnough } from '../trace/pool.js';
import { findPriorSheet, joinCarriedSheet, readRunSheet } from '../trace/runs.js';
import { compileRun } from './compile.js';
import { stableBranches } from './compile-words.js';
import { jobCovered, nameTaken } from './store.js';
import { stepsTotal } from './store-fs.js';
import { answerDirective, endsWithLine, newOfferId, offerBudget, offerLines, recordAnswer, recordNotShown } from './offers.js';
import { offerLinesOf, type OfferLinesIn } from './offer-lines.js';
import { isLessonOffer } from './offer-words-1b.js';
import { lessonOfferDue } from './offer-lesson.js';
import { repairOfferDue } from './offer-repair.js';
import { classifyFor } from './offer-answers.js';
import { updateOfferDue } from './offer-update.js';
import { driftOfferDue } from './offer-drift.js';
import { replyEndedWithOffer, retireOfferDue, retireSkill } from './offer-retire.js';
import { answer2 } from './offer-words-2.js';
import { skillOfOfferKey } from './offers.js';
import { runCheckout } from './run-checkout.js';
import { repoKnown } from '../trace/known-repo.js';
import type { FoldPlanner } from './offer-update.js';
import type { Fired, Settled } from './credit.js';
import { useFor, type DialectUse } from '../trace/dialect.js';
import { stepLearnings, withFollowLine } from './follow-learnings.js';

const SAME_LINE_MS = 5000;

/**
 * What a yes to an offer agrees to: the skill's steps (the calls each was copied from, and its text with the
 * skill's own name taken out) and its check. The gate saves only a skill with the same sha (4.9 step 5): steps run
 * after the offer, or a run sheet changed since, are not what the person said yes to.
 */
export function skillSha(c: CompiledSkill): string {
  const own = (t: string) => (c.name ? t.split(c.name).join('\u0000') : t);
  const steps = c.steps.map((s) => [(s.from ?? []).join(','), own(s.cmd)]);
  return createHash('sha256').update(JSON.stringify([steps, own(c.check), c.checkIsStep])).digest('hex');
}

/**
 * The repo an offer is for: its `repo` (1b), else from its key, '<repoKey>|job:<job>' or '<repoKey>|wall:<cls>|<program>'.
 * A skill-keyed offer ('<skillId>|correction', phase 2's update, drift and retire keys) names no repo: '' without
 * `repo` (D126).
 */
export function offerRepo(o: Pick<PendingOffer, 'key'> & { repo?: unknown }): string {
  if (typeof o.repo === 'string' && o.repo) return o.repo;
  if (skillOfOfferKey(o.key) !== null) return '';
  const i = o.key.lastIndexOf('|job:');
  if (i >= 0) return o.key.slice(0, i);
  const w = o.key.indexOf('|wall:');
  return w < 0 ? o.key : o.key.slice(0, w);
}

export interface Captured {
  /** Return this now (a directive for yes, show me or no); null: go on to 3.2 step 5. */
  out: HookOut | null;
  /** Going on: context to add first (the agent said the offer and the person moved on). */
  extra?: string;
  /** For telemetry `skill_answer`: the class, or why the offer was dropped unanswered; null with no offer, or for a
   *  second yes after the first (ignored, D70: nothing to send). */
  answer: TypedAnswer | 'stale' | 'not-shown' | null;
  /** Phase 2 (4.9): the prompt hook retired the skill on this answer (for telemetry `skill_changed{retire}`). */
  changed?: 'retire';
}

/**
 * 3.2 step 4, on the session state inside the prompt hook's lock. Only the first typed prompt after the offer
 * answers it, or the second after one "show me". A `yes` sets `pendingOffer.yes` from this prompt's own words
 * (hashed), which the gate later matches against the person's line in the transcript.
 */
export function captureAnswer(st: SkillSessionState, typed: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date(),
  o: { transcriptPath?: string | null } = {}): Captured {
  const po = st.pendingOffer;
  if (!po) return { out: null, answer: null };
  const repo = offerRepo(po);
  const plain = { paused: false, firstNo: false };
  if (po.yes) {
    // D70: two quick yeses keep the save once. The first counts (its line is the consent); the second is
    // ignored: no second directive, no answer recorded, the offer stays for the agent's add.
    if (classifyFor(po.moment, typed, po.showMe) === 'yes') return { out: null, answer: null };
    // Anything else: answered in an earlier prompt, and the agent had that turn to save.
    st.pendingOffer = null;
    return { out: null, answer: 'stale' };
  }
  if (po.shownAt === null) {
    recordNotShown(po, repo, env, now);
    st.pendingOffer = null;
    return { out: null, answer: 'not-shown' };
  }
  // Phase 2 (4.10): by the offer's own words (drift's replace is its yes, retire is retire).
  const said = classifyFor(po.moment, typed, po.showMe);
  // 1b: a lesson offer asks yes or no; its whole text is already in line 2, so "show me" is no answer to it.
  // Phase 2 (D72, R1): a retire moves the skill only after the agent's reply ended with the offer's line 2.
  const a = said === 'show' && isLessonOffer(po) ? 'other'
    : said === 'retire' && !(po.retire && replyEndedWithOffer(po, typed, o.transcriptPath ?? null, env, useFor(st.host, st))) ? 'other' : said;
  switch (a) {
    case 'retire': {
      // 4.9, P12: the one write the prompt hook makes on an answer: a move `trail skills restore` undoes.
      const r = retireSkill(po.retire!.name, 'retire-offer', env, now, po.retire!.skillId);
      recordAnswer(po, repo, 'yes', env, now, 'retire');
      st.pendingOffer = null;
      return { out: answer2('retire', po, { ...plain, retired: r.ok ? po.retire!.name : null }, env, typed, st.host as Host), answer: 'retire', ...(r.ok ? { changed: 'retire' as const } : {}) };
    }
    case 'yes':
      recordAnswer(po, repo, 'yes', env, now, po.fold?.op);
      po.yes = { at: now.toISOString(), typedSha: typedSha(typed) };
      return { out: answerDirective('yes', po, plain, env, typed, st.host as Host), answer: 'yes' };
    case 'show':
      recordAnswer(po, repo, 'show', env, now);
      po.showMe = true;
      return { out: answerDirective('show', po, plain, env, typed, st.host as Host), answer: 'show' };
    case 'no': {
      const c = recordAnswer(po, repo, 'no', env, now);
      st.pendingOffer = null;
      return { out: answerDirective('no', po, c, env, typed, st.host as Host), answer: 'no' };
    }
    case 'correction':
      recordAnswer(po, repo, 'withdrawn', env, now);
      st.pendingOffer = null;
      // P18, R40: only the lesson offer for this same correction may use the slot it freed, at this turn's Stop. A
      // withdrawn lesson offer frees nothing: the slot is for a pending offer of another moment (4.14, b4 review).
      st.withdrewFor = po.moment === 'correction' ? null : { typedSha: typedSha(typed) };
      return { out: null, answer: 'correction' };
    default: {
      recordAnswer(po, repo, 'none', env, now);
      st.pendingOffer = null;
      const d = answerDirective('other', po, plain, env, typed, st.host as Host);
      return d.context ? { out: null, extra: d.context, answer: 'other' } : { out: null, answer: 'other' };
    }
  }
}

/**
 * 3.2 step 6.4: the person asked to keep a run. Spends the session's offer, withdraws a pending one, and records
 * the request with this prompt's words hashed. When this hook's catch-up already folded the typed line (Claude Code
 * wrote it before the hook ran), its offset is taken from `fold.typed` now: the fold only fills `typed` for a line
 * it meets after the request exists. `skill` is the skill compiled for this ask (3.2 step 6.3); its `skillSha` is
 * kept (D73): the gate keeps only that skill, so steps run or written into the sheet after the ask are not what was
 * asked for.
 */
export function noteSaveRequest(st: SkillSessionState, fold: Pick<FoldResult, 'typed'> | null,
  req: { runId: string; typed: string; scope: NonNullable<SkillSessionState['saveRequest']>['scope']; skill: CompiledSkill },
  env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): void {
  const sha = typedSha(req.typed);
  const line = (fold?.typed ?? []).filter((t) => t.sha === sha && t.offset >= 0 && Date.parse(t.at) >= now.getTime() - SAME_LINE_MS).pop();
  if (st.pendingOffer) {
    recordAnswer(st.pendingOffer, offerRepo(st.pendingOffer), 'withdrawn', env, now);
    st.pendingOffer = null;
  }
  st.saveRequest = {
    runId: req.runId, at: now.toISOString(), typedSha: sha, scope: req.scope, typed: line ? { offset: line.offset, sha } : null, skillSha: skillSha(req.skill), name: req.skill.name,
  };
  st.offerUsed = true;
  st.offerUsedBy = 'asked';
}

export interface OfferInput {
  run: RunState;
  /** checkedSuccess(run, lastAssistant) (Stop) or with lastAssistant null (post-tool, 3.4). */
  verdict: CheckedVerdict;
  /** The run's sheet as written for this verdict. */
  sheet: RunSheet | null;
  st: SkillSessionState;
  /** 1b: Stop passes its whole GateCtx; moment 4 reads the transcript (no transcript: no moment 4). */
  ctx: Pick<GateCtx, 'learn' | 'checkout' | 'repoKey' | 'env' | 'now'> & Partial<Pick<GateCtx, 'transcriptPath'>>;
  channel: OfferChannel;
  /** Phase 2 (moments 5 and 6): c2's foldInputFor and replan (update-gate.ts); without them neither is due. */
  plan?: FoldPlanner;
  /** Phase 2: the uses this Stop's settle flushed (moment 5 needs this run's, checked). */
  settled?: Settled[];
  /** Phase 2: the firings this Stop's settle wrote (the retire proposal needs a not-followed one). */
  fired?: Fired[];
}
export type OfferDue =
  | { due: true; offer: PendingOffer }
  | { due: false; why: 'learn' | 'pending' | 'job' | 'skill' | 'not-checked' | 'family' | 'no-repo' | 'covered' | 'not-repeated' | 'no-sheet' | 'compile' | 'one-step' | 'unknown-repo' | `budget:${string}` };

/** Phase 2 (4.10, P18): the order offerDue tries the moments in; the first that is due is the offer. */
export const OFFER_ORDER = ['correction', 'drift', 'update', 'repaired', 'repeated', 'retire'] as const;

/**
 * 1b (4.13, 4.14, 3.5 step 6), phase 2 (4.10, P18): moment 4, 6, 5, 3, 2, then the retire proposal, the first that is
 * due. All but moment 2 are Stop's only (stop and notice channels, R13); none due, the answer is moment 2's. Writes
 * nothing: the caller records it shown.
 */
export function offerDue(i: OfferInput): OfferDue {
  // D117 (3), J16: no offer in a repo Trail doesn't know (no .trail/, not in the repo index).
  if (!repoKnown(i.run.repoKey, i.run.checkout ?? (i.run.repoKey === i.ctx.repoKey ? i.ctx.checkout : ''), i.ctx.env)) return { due: false, why: 'unknown-repo' };
  const atStop = i.channel !== 'post-tool' && i.ctx.learn && !i.st.pendingOffer;
  if (atStop) {
    const m4 = lessonOfferDue({ ...i, ctx: { ...i.ctx, transcriptPath: i.ctx.transcriptPath ?? null } });
    if (m4.due) return m4;
    const m6 = driftOfferDue(i);
    if (m6.due) return m6;
    const m5 = updateOfferDue(i);
    if (m5.due) return m5;
    const m3 = repairOfferDue(i);
    if (m3.due) return m3;
  }
  const m2 = repeatedOfferDue(i);
  if (m2.due || !atStop) return m2;
  const retire = retireOfferDue(i, i.fired ?? []);
  return retire.due ? retire : m2;
}

/** What compile makes of an offer's run, exactly as the save gate's compile of its yes will (moments 2 and 3, R58). */
export function compileOffered(sheet: RunSheet, st: SkillSessionState, ctx: OfferInput['ctx']): ReturnType<typeof compileRun> {
  const env = ctx.env;
  const scope = { repoKeys: [...new Set([...st.scopeKeys, sheet.repoKey])], checkout: ctx.checkout, env };
  const read = (id: string) => readRunSheet(id, env);
  // D93: the run's own checkout, as both halves of the save gate compile it.
  const root = runCheckout(sheet, env, ctx.repoKey === sheet.repoKey ? ctx.checkout : '');
  return compileRun(sheet, {
    repoRoot: root, home: env.HOME || homedir(), platform: process.platform,
    prior: findPriorSheet(sheet, env), moment: 'repeated', applies: sheet.repoKey, now: ctx.now, readSheet: read,
    taken: (n) => nameTaken(n, { ...scope, checkout: root || scope.checkout }) !== null,
    learnings: stepLearnings({ repoKeys: [sheet.repoKey], checkout: root, env }),
  });
}

/**
 * Moment 2: 4.12 conditions 1 to 6, in order. Due: the offer to hold as `pendingOffer` (shown now for `stop` and
 * `notice`; `shownAt` null for `post-tool`, set when the reply carries it). Writes nothing.
 */
export function repeatedOfferDue(i: OfferInput): OfferDue {
  const { run, verdict, st, ctx, channel } = i;
  const env = ctx.env;
  const now = ctx.now;
  if (!ctx.learn) return { due: false, why: 'learn' };
  if (st.pendingOffer) return { due: false, why: 'pending' };
  const job = run.job;
  const families = job ? OFFER_FAMILIES[job] : undefined;
  if (!job || !families) return { due: false, why: 'job' };
  if (run.skillId) return { due: false, why: 'skill' };
  if (!verdict.checked || verdict.checkIndex === null) return { due: false, why: 'not-checked' };
  const hit = run.calls[verdict.checkIndex]?.check;
  if (!hit || !hit.passed || !families.includes(hit.family)) return { due: false, why: 'family' };
  if (!run.repoKey) return { due: false, why: 'no-repo' };

  const scope = { repoKeys: [...new Set([...st.scopeKeys, run.repoKey])], checkout: ctx.checkout, env };
  if (jobCovered(job, scope)) return { due: false, why: 'covered' };
  const key = `${run.repoKey}|job:${job}`;
  const budget = offerBudget({ repoKey: run.repoKey, key, sessionOfferUsed: st.offerUsed, now, env });
  if (!budget.ok) return { due: false, why: `budget:${budget.why}` };
  const pool = readPool(run.repoKey, env).jobs[job];
  const rep = pool ? repeatedEnough(pool, budget.extraDay, now) : null;
  if (!rep || !rep.ok) return { due: false, why: 'not-repeated' };

  const sheet = i.sheet;
  if (!sheet || sheet.id !== run.id) return { due: false, why: 'no-sheet' };
  const read = (id: string) => readRunSheet(id, env);
  const compiled = compileOffered(sheet, st, ctx);
  if (!compiled.ok) return { due: false, why: 'compile' };
  // D70: a skill of one Run step is not offered; a one-command job is better kept as a lesson.
  if (compiled.skill.steps.length < 2) return { due: false, why: 'one-step' };
  const joined = joinCarriedSheet(sheet, read);
  const ownDates = rep.dates === rep.sessionDays;
  const seen = { n: ownDates ? rep.dates : rep.sessionDays, unit: ownDates ? 'day' as const : 'time' as const };
  const lines = withFollowLine(offerLines({
    job, check: hit, ordinal: seen.n, unit: seen.unit,
    commands: joined.counts.commands, failed: joined.counts.failed, steps: stepsTotal(compiled.skill), where: 'this repo',
    branches: job === 'ship' ? stableBranches(joined.calls, joined.jobWords) : [],
  }), compiled.skill.followed);
  return {
    due: true,
    offer: {
      offerId: newOfferId(), moment: 'repeated', runId: run.id, name: compiled.skill.name, key, lines, channel,
      shownAt: channel === 'post-tool' ? null : now.toISOString(), showMe: false, yes: null, typedAfter: [],
      skillSha: skillSha(compiled.skill), seen,
    },
  };
}

/**
 * For g7's Stop (3.5 steps 6 and 7): the agent's reply carried the offer, as its last line. A reply that adds a
 * question of its own after the offer, or leaves it out, did not: the offer is recorded not shown and dropped, so
 * the person's next yes can't be taken as a yes to the skill.
 */
export function offerEndsReply(o: OfferLinesIn, reply: string | null, transcriptPath: string | null = null, use?: DialectUse): boolean {
  // 1b (R12): through offerLinesOf; an offer with no lines (a correction whose line is gone or changed) never ends a reply.
  const l = reply === null ? null : offerLinesOf(o, transcriptPath, process.env, use);
  return l !== null && endsWithLine(reply!, l[1]);
}
