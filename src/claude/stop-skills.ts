/**
 * The skills part of Stop (design 3.5): judge the open run, settle credit,
 * count the job's day, keep the run's sheet, and, on the 3rd day a job
 * checks out from scratch, the repeated-job offer (moment 2, 4.12).
 *
 * `handleStopEvent` calls it last and writes its one answer: a block (the
 * agent ends its reply with the offer's 2 lines), or a notice, never both,
 * and never a block twice in a turn (`stop_hook_active`). The offer is kept
 * exactly as g5's `offerDue` returns it (it carries `skillSha`, the steps
 * the person says yes to). Fails open: nothing out, one line in
 * `state/hook-errors.log`.
 */
import type { Host } from '../trace/host.js';
import type { HookOut } from '../skills/types.js';
import type { PendingOffer, RunState, SkillSessionState } from '../trace/types.js';
import { currentRun, skillsGate, withSkillSession, type GateCtx } from '../trace/skill-session.js';
import { checkedSuccess, costly, runHelpers, writeRunSheet, type CheckedVerdict, type FoldResult } from '../trace/runs.js';
import { notePoolDay } from '../trace/pool.js';
import { repoKnown } from '../trace/known-repo.js';
import { OFFER_FAMILIES } from '../trace/jobs.js';
import { localDate } from '../skills/settings.js';
import { hostFacts } from '../skills/host-facts.js';
import { noteCorrectionLine, settleCredit, type Fired, type Settled } from '../skills/credit.js';
import { foldInputFor, replan } from '../skills/update-plan.js';
import { guardrailStopsIn, noteValue } from '../skills/value-line.js';
import { offerDue, offerEndsReply, offerRepo } from '../skills/offer-moment.js';
import { offerLinesOf, type OfferLinesIn } from '../skills/offer-lines.js';
import { noticeText, recordNotShown, recordShown, stopBlockReason } from '../skills/offers.js';
import { flatLine } from '../notes/flatten.js';
import { hookError, syncGate, type Sent } from './skills-hook-util.js';
import { guardrailCounts, wallsAtStop } from './walls-hook.js';
import { refreshLessonIndex } from '../notes/lesson-index.js';
import { useFor, type DialectUse } from '../trace/dialect.js';

/** The fields of a Stop payload the skills part reads. */
interface StopIn {
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
}

export interface StopResult { out: HookOut; sent: Sent }

/** c2's planner, which the update gate and `draft --print` replan with (P29, R14). */
const PLANNER = { foldInputFor, replan };

/** 3.5. Never throws. */
export function stopSkills(input: any, dir: string, env: NodeJS.ProcessEnv = process.env): HookOut {
  return stopSkillsRun(input, dir, env).out;
}

/** 3.5, with the telemetry it collected inside the lock, for the caller to send after it. */
export function stopSkillsRun(input: any, dir: string, env: NodeJS.ProcessEnv = process.env): StopResult {
  const sent: Sent = [];
  try {
    // 1.
    const g = skillsGate(input, dir, env);
    if (!g.ok || g.ctx.subagent || !g.ctx.fold) return { out: {}, sent };
    const ctx = g.ctx;
    const p: StopIn = input && typeof input === 'object' ? input : {};
    const said = typeof p.last_assistant_message === 'string' && p.last_assistant_message.trim() ? p.last_assistant_message : null;
    // 2. A lock that timed out is nothing: the next hook catches up.
    const out = withSkillSession(ctx, { catchUp: true }, (st, fold) => inside(ctx, st, fold, said, p.stop_hook_active === true, sent));
    return { out: out ?? {}, sent };
  } catch (e) {
    hookError('stop', e, env);
    return { out: {}, sent: [] };
  }
}

function inside(ctx: GateCtx, st: SkillSessionState, fold: FoldResult | null, said: string | null, active: boolean, sent: Sent): HookOut {
  const { env, now } = ctx;
  // 1b (4.14 step 1, D109): a correction line the fold met only now (written after the prompt hook ran) fills its offset.
  if (fold) noteCorrectionLine(st, fold.typed);
  // 3. The reply's last words may reach the payload before the transcript.
  const reply = said ?? (fold?.lastAssistant || null);
  const offer = st.pendingOffer;
  const run = currentRun(st);
  // D133: the offer's lines are read through the host's dialect (a Codex correction line by its keyed hash).
  const use = useFor(ctx.host, st);
  const judged = withoutOffer(reply, offer, ctx.transcriptPath, use);
  if (run) run.end = checkedSuccess(run, judged).end;

  // 1b (3.5 steps 1, 2 and 5): wall hits, repairs and lessons that worked into walls.json, before the offers read it;
  // the guardrail's denies since the last Stop counted. Each part fails open on its own.
  let wallFixes = 0;
  if (ctx.learn) {
    try { wallFixes = wallsAtStop(st, ctx); } catch (e) { hookError('stop', e, env); }
  }
  const before = sent.length;
  try { guardrailCounts(st, ctx, sent); } catch (e) { hookError('stop', e, env); }
  // Phase 2 (3.5, 4.14, learning half): this Stop's timeout guardrail stops and the known errors whose fix reached the
  // model, counted for the weekly value line (a busy lock drops them, never waits).
  if (ctx.learn && ctx.repoKey) {
    try { noteValue(ctx.repoKey, { guardrailStops: guardrailStopsIn(sent.slice(before)), wallFixes }, env, now); } catch (e) { hookError('stop', e, env); }
  }
  // D117 (4): the lesson index the wall fix reads, brought up to date here (PostToolUseFailure writes nothing, R34).
  refreshLessonIndex(ctx.repoKey, env);

  // 5. Credit (the prompt hook settles a run the next ask closed, D57). 1b: a cue phrase dropped at the flush (4.19).
  // Phase 2 (4.9): the firings the flush wrote, for the retire proposal.
  let settled: Settled[] = [];
  // c8 (4.9): with the firings the prompt hook's settle wrote since the last Stop (their run closed on the next ask).
  const fired: Fired[] = ctx.learn ? [...(st.firedLater ?? [])] : [];
  delete st.firedLater;
  if (ctx.learn) {
    settled = settleCredit(st, { host: ctx.host, env, now, sessionId: ctx.sessionId, cueDropped: () => sent.push(['skill_stale', { reason: 'unfollowed' }]), fired: (f) => fired.push(f) });
    for (const s of settled) sent.push(['skill_used', { outcome: s.outcome }]);
  }

  // 6. A post-tool offer counts as shown only when the reply ends with it.
  let spent = false;
  if (offer && offer.channel === 'post-tool' && offer.shownAt === null) {
    if (offerEndsReply(offer, reply, ctx.transcriptPath, use)) {
      offer.shownAt = now.toISOString();
      recordShown(offer, offerRepo(offer), env, now);
      st.offerUsed = true;
      st.offerUsedBy = 'offer';
      sent.push(['skill_offered', { moment: offer.moment }]);
    } else {
      recordNotShown(offer, offerRepo(offer), env, now);
      st.pendingOffer = null;
    }
    spent = true;
  }

  // 7. The turn a block continued: the offer the reply left out (or followed with words of its own) is not shown.
  if (active) {
    if (offer && offer.channel === 'stop' && blockedThisTurn(offer) && !offerEndsReply(offer, reply, ctx.transcriptPath, use)) {
      recordNotShown(offer, offerRepo(offer), env, now);
      st.pendingOffer = null;
    }
    syncGate(ctx, st);
    return {};
  }

  // 8. Pool days.
  if (ctx.learn) for (const r of st.runs) if (r.epoch === st.epoch) notePool(r, ctx);

  // 9. The open run's sheet when it checks out, then its pool day again, so the pool points at a sheet on disk.
  let verdict: CheckedVerdict | null = null;
  let sheet = null;
  if (run && run.stepCalls > 0 && run.calls.length) {
    verdict = checkedSuccess(run, judged);
    if (verdict.checked) {
      sheet = writeRunSheet(run, verdict, { host: ctx.host, tier: ctx.tier, sessionHash: ctx.sessionHash, helpers: runHelpers(run) }, env);
      if (ctx.learn) notePool(run, ctx);
    }
  }

  // 10. Moments 4, 6, 5, 3, 2, then the retire proposal, the first that is due (1b, 3.5 step 6; phase 2, 4.10). Moment
  // 4 needs no checked run: the turn's last run (open, else the newest) carries the verdict on how the turn ended.
  // Moments 5 and 6 plan through c2's `foldInputFor` and `replan`, so the offer pins what the update gate replans.
  const channel = hostFacts(env, ctx.host as Host).offerChannel;
  const last = run ?? st.runs[st.runs.length - 1] ?? null;
  if (ctx.learn && !spent && last && (channel === 'stop' || channel === 'notice')) {
    const due = offerDue({ run: last, verdict: verdict ?? checkedSuccess(last, judged), sheet, st, ctx, channel, settled, fired, plan: PLANNER });
    if (due.due) {
      st.pendingOffer = due.offer;
      recordShown(due.offer, offerRepo(due.offer) || last.repoKey, env, now);
      st.offerUsed = true;
      st.offerUsedBy = 'offer';
      sent.push(['skill_offered', { moment: due.offer.moment }]);
      endWatch(st);
      syncGate(ctx, st);
      return channel === 'stop' ? { block: stopBlockReason(due.offer, ctx.transcriptPath, use) } : { notice: noticeText(due.offer, ctx.transcriptPath, use) };
    }
  }

  // 11.
  endWatch(st);
  syncGate(ctx, st);
  const notice = hostFacts(env, ctx.host as Host).stopNotice ? useLine(settled) : '';
  return notice ? { notice } : {};
}

/**
 * 1b: moment 4 is due at the Stop of the correction's turn only (4.14 step 4). Once the fold found the correction's
 * line, the watch ends with this Stop, offered or not; the slot a correction freed (P18, R40) is for this Stop only.
 */
function endWatch(st: SkillSessionState): void {
  const w = st.lessonWatch;
  if (w && st.credit.some((c) => c.useId === w.useId && c.corrected?.sha === w.typedSha && typeof c.corrected.offset === 'number')) st.lessonWatch = null;
  if (w && !st.credit.some((c) => c.useId === w.useId)) st.lessonWatch = null;
  st.withdrewFor = null;
}

/**
 * The reply as judged for the turn's end (4.3): without the offer's own 2 lines when it ends with them. Line 1
 * counts what failed on the way ("17 commands this time, 3 failed"), which would read as a turn that failed, and
 * the job was judged done before the offer was made. A reply that is only the offer reads as done.
 */
export function withoutOffer(reply: string | null, offer: OfferLinesIn | null, transcriptPath: string | null = null, use?: DialectUse): string | null {
  // 1b (R12): the lines through offerLinesOf; an offer with none (a correction whose line is gone) was never said.
  const said = reply === null || !offer ? null : offerLinesOf(offer, transcriptPath, process.env, use);
  if (reply === null || !said || !offerEndsReply(offer!, reply, transcriptPath, use)) return reply;
  // The words of each line, without what the agent may dress them in (a fence, a quote, bold, end punctuation).
  const core = (t: string) => t.replace(/\s+/g, ' ').replace(/[*_`"'>\u2018\u2019\u201c\u201d]/gu, '').trim().replace(/[.\s]+$/u, '');
  const [first, second] = [core(said[0]), core(said[1])];
  const lines = reply.split(/\r?\n/);
  let i = lines.length - 1;
  while (i >= 0 && !core(lines[i]!).includes(second)) i--;
  if (i < 0) return reply;
  const cut = core(lines[i]!).indexOf(first);
  const kept = lines.slice(0, i);
  if (first && cut > 0) kept.push(lines[i]!.slice(0, lines[i]!.indexOf(said[0].slice(0, 12))));
  else if (first && cut < 0) {
    while (kept.length && !core(kept[kept.length - 1]!)) kept.pop();
    if (kept.length && core(kept[kept.length - 1]!).includes(first)) kept.pop();
  }
  while (kept.length && !core(kept[kept.length - 1]!)) kept.pop();
  return kept.join('\n');
}

/** A stop offer shown by the block that started this continued turn: no answer of the person's since. */
function blockedThisTurn(o: PendingOffer): boolean {
  return o.shownAt !== null && o.yes === null && !o.showMe && o.typedAfter.length === 0;
}

/** 3.5 step 8 for one run: a job of a moment-2 family with a step call; idempotent per (day, session), costly OR-ed. */
export function notePool(run: RunState, ctx: Pick<GateCtx, 'sessionHash' | 'env' | 'now'> & Partial<Pick<GateCtx, 'repoKey' | 'checkout'>>): void {
  if (!run.job || !OFFER_FAMILIES[run.job] || run.stepCalls <= 0 || !run.repoKey) return;
  // D117 (3), J16: no pool for a repo Trail doesn't know.
  if (!repoKnown(run.repoKey, run.checkout ?? (run.repoKey === ctx.repoKey ? ctx.checkout : ''), ctx.env)) return;
  const day = { d: localDate(run.startedAt), s: ctx.sessionHash, costly: costly(run) };
  if (notePoolDay(run.repoKey, { job: run.job, words: run.jobWords }, day, run.sheet === 'checked' ? run.id : null, ctx.env, ctx.now)) run.poolNoted = true;
}

/** The Stop use line (4.15), when the host shows a Stop notice and nothing else is said. */
function useLine(settled: Settled[]): string {
  return settled.map((s) => {
    const src = s.state?.source;
    const before = src ? ` (by hand last time: ${src.commands} commands, ${src.failed} failed)` : '';
    return `trail: ${flatLine(s.name, 60)}, ${s.use.calls} commands, ${s.use.failed} failed${before}`;
  }).join('\n');
}
