/**
 * The retire proposal (phase 2 design 4.9, spec 13, P12, P13, P46, R1, R12,
 * R27): a skill Trail keeps bringing in whose steps mostly don't run is
 * offered for retirement once, ever.
 *
 * Firings: each settled job or name cue block is one, followed when a step of
 * the skill ran (`noteFiring`, called at the credit flush beside 1b's cue
 * misses, under the state lock; a busy lock drops it). The last 10 are kept;
 * a version change resets them (c2).
 *
 * The offer is due at the Stop whose settle wrote a not-followed firing, when
 * the turn ended done, the skill is personal and active or candidate, it has
 * 5 or more firings and half or fewer were followed. It needs no checked
 * success: it is about a block the agent didn't use.
 *
 * A "retire" answer is the one write the prompt hook makes on an answer
 * (P12): `retireSkill` moves the folder to `.retired/` (restorable, nothing
 * deleted) with ledger reason `retire-offer`, and only after the agent's
 * reply before the answer ended with the offer's line 2 (D72, R1).
 */
import { statSync } from 'node:fs';
import type { DialectUse } from '../trace/dialect.js';
import type { SkillState } from './types.js';
import type { PendingOffer } from '../trace/types.js';
import type { OfferDue, OfferInput } from './offer-moment.js';
import { updateSkillState, getSkillState } from './state.js';
import { forgetSkill, listAllPersonal } from './store.js';
import { HOOK_WAIT_MS } from './store-fs.js';
import { newOfferId, offerBudget, readOffers, retireOfferKey } from './offers.js';
import { retireLines } from './offer-words-2.js';
import { offerLinesOf } from './offer-lines.js';
import { endsWithLine } from './offer-words.js';
import { replyBefore } from './save-verify.js';
import { typedSha } from '../trace/typed.js';

/** One settled job or name cue block, as `noteFiring` wrote it (settleCredit's `fired` callback). */
export interface Fired { skillId: string; name: string; followed: boolean; runId: string; at: string }

export const FIRINGS_KEPT = 10;
/** The fewest firings before the proposal (spec 13: "5 or more firings"). */
export const RETIRE_MIN_FIRINGS = 5;

const validFiring = (f: unknown): f is { at: string; followed: boolean } =>
  !!f && typeof f === 'object' && typeof (f as { at?: unknown }).at === 'string' && typeof (f as { followed?: unknown }).followed === 'boolean';

/** 4.9: one firing, last 10 kept. False when nothing was written (no state, retired, or the state lock was busy). */
export function noteFiring(skillId: string, followed: boolean, env?: NodeJS.ProcessEnv, now: Date = new Date()): boolean {
  let wrote = false;
  const next = updateSkillState(skillId, (s) => {
    if (!s || s.status === 'retired') return s;
    const kept = Array.isArray(s.firings) ? s.firings.filter(validFiring) : [];
    s.firings = [...kept, { at: now.toISOString(), followed: followed === true }].slice(-FIRINGS_KEPT);
    wrote = true;
    return s;
  }, env);
  return wrote && next !== undefined;
}

/** The firings a state holds, and how many were followed. */
export function firingsOf(s: Pick<SkillState, 'firings'> | null | undefined): { n: number; followed: number } {
  const f = Array.isArray(s?.firings) ? s!.firings!.filter(validFiring) : [];
  return { n: f.length, followed: f.filter((x) => x.followed).length };
}

export type RetireResult = { ok: true; to: string } | { ok: false; reason: 'unknown' | 'busy' };

/**
 * 4.9's write: 1a's forget with ledger reason `retire-offer`, waiting at most a hook's 200 ms for the store. Busy:
 * nothing moved. `skillId`, when given, must be the folder's own skill (a folder since replaced is not retired).
 */
export function retireSkill(name: string, reason: 'retire-offer', env?: NodeJS.ProcessEnv, now: Date = new Date(), skillId?: string): RetireResult {
  if (skillId !== undefined && !listAllPersonal(env).some((r) => r.name === name && r.id === skillId)) return { ok: false, reason: 'unknown' };
  try {
    return forgetSkill(name, env, now, { reason, waitMs: HOOK_WAIT_MS });
  } catch {
    return { ok: false, reason: 'busy' };
  }
}

type Why = 'learn' | 'pending' | 'channel' | 'end' | 'no-firing' | 'skill' | 'status' | 'few' | 'followed' | 'once' | `budget:${string}`;

/**
 * 4.9: due at the Stop whose settle wrote a not-followed firing (`fired`, from settleCredit's `fired` callback), the
 * turn ended done (R12), the skill personal and active or candidate, 5 or more firings with half or fewer followed,
 * and the budget's key `<skillId>|retire` (once per skill, ever). Writes nothing.
 */
export function retireOfferDue(i: OfferInput, fired: Fired[]): OfferDue | { due: false; why: Why } {
  const { verdict, st, ctx, channel } = i;
  const env = ctx.env;
  if (!ctx.learn) return { due: false, why: 'learn' };
  if (st.pendingOffer) return { due: false, why: 'pending' };
  if (channel !== 'stop' && channel !== 'notice') return { due: false, why: 'channel' };
  if (verdict.end === 'failure' || verdict.end === 'question') return { due: false, why: 'end' };
  let last: Why = 'no-firing';
  for (const f of fired.filter((x) => x && x.followed === false)) {
    const ref = listAllPersonal(env).find((r) => r.id === f.skillId);
    const s = ref ? getSkillState(f.skillId, env) : null;
    if (!ref || !s || s.scope !== 'personal') { last = 'skill'; continue; }
    if (s.status !== 'active' && s.status !== 'candidate') { last = 'status'; continue; }
    const { n, followed } = firingsOf(s);
    if (n < RETIRE_MIN_FIRINGS) { last = 'few'; continue; }
    if (followed * 2 > n) { last = 'followed'; continue; }
    const repo = i.run.repoKey || ctx.repoKey;
    const key = retireOfferKey(f.skillId);
    // P13: once per skill, ever. Shown once is enough, answered or not (1a's second chance is for moments 2 and 3).
    if (readOffers(env).some((l) => l.key === key && l.event === 'shown')) { last = 'once'; continue; }
    const budget = offerBudget({ repoKey: repo, key, sessionOfferUsed: st.offerUsed, now: ctx.now, env });
    if (!budget.ok) { last = `budget:${budget.why}`; continue; }
    return {
      due: true,
      offer: {
        offerId: newOfferId(), moment: 'retire', runId: f.runId ?? i.run.id, name: ref.name, key, lines: retireLines({ name: ref.name, fired: n, followed }),
        channel, shownAt: ctx.now.toISOString(), showMe: false, yes: null, typedAfter: [], repo, retire: { skillId: f.skillId, name: ref.name },
      },
    };
  }
  return { due: false, why: last };
}

/**
 * D72, R1: the agent's reply right before the person's answer ended with the offer's own line 2, so a "retire" typed
 * to some other question (or after an agent that never showed the offer) moves nothing. The person's line is found by
 * its sha where the fold already met it; else (Claude Code writes the line just after the hook starts) the reply is the
 * transcript's last one. An offer shown as Trail's own notice needs no reply: the person read Trail's words.
 */
export function replyEndedWithOffer(po: PendingOffer, typed: string, transcriptPath: string | null, env: NodeJS.ProcessEnv = process.env, use?: DialectUse): boolean {
  try {
    if (po.channel === 'notice') return true;
    const line2 = offerLinesOf(po, transcriptPath, env, use)?.[1];
    if (!line2 || !transcriptPath) return false;
    const sha = typedSha(typed);
    const entry = po.typedAfter.find((t) => t.sha === sha && Number.isInteger(t.offset) && t.offset >= 0);
    const offset = entry ? entry.offset : statSync(transcriptPath).size;
    const reply = replyBefore(transcriptPath, offset, env, use);
    return reply !== null && endsWithLine(reply, line2);
  } catch {
    return false;
  }
}
