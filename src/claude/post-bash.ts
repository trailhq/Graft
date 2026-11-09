/**
 * The skills part of PostToolUse and PostToolUseFailure on Bash (design 3.4).
 *
 * Claude Code fires PostToolUse for a Bash call that worked and
 * PostToolUseFailure for one that failed, never PostToolUse (D34). Each
 * leaves a mark for a call whose result the transcript may not hold yet
 * (`<id>.post.jsonl`, taken by the next catch-up; the transcript's result
 * wins when it arrives); a check's mark carries the output's tail, cut by
 * the fold's own `cleanTail`, so a check read from a mark reads as it will
 * from the transcript. Marks are for Bash only: MCP results (a deploy read)
 * come from the transcript.
 *
 * The asked call's PostToolUse is the person's yes to a step that can't be
 * undone (the group's later steps are covered); a failure never approves,
 * since a refused ask arrives the same way.
 *
 * Where the host shows the offer best as PostToolUse context (`offerChannel`
 * 'post-tool'), the passing check of a job's 3rd day brings it; Stop counts
 * it shown only when the reply ends with it (3.5 step 6).
 *
 * 1b (3.4 step 1, recall half): a result whose error is in the wall catalog
 * gets the catalog's fix as context, from Trail (D88), plus what fixed it
 * here before when a kept lesson worked in 2 epochs; on PostToolUseFailure
 * only where the host reads that context (`failureContext`). Nothing is
 * written for it (R34): Stop records the hit from the transcript.
 *
 * Codex (phase 2, 3.4): PostToolUse fires on every exit, with `tool_response`
 * the text the model sees, so `codexPostBash` reads the exit from its header
 * (`codexFailed`) and hands on the body as the rollout reader shows it; a text
 * with no exit header writes no mark (P34). Each host's own facts decide what
 * context goes out (`postToolContext` on PostToolUse, `failureContext` on
 * PostToolUseFailure).
 */
import { existsSync } from 'node:fs';
import type { HookOut } from '../skills/types.js';
import { appendPostMark, gateFilePath, markApproved, skillsOnFast } from '../trace/gate-file.js';
import { checkFamilyOf } from '../trace/checks.js';
import { cleanTail } from '../trace/run-calls.js';
import { currentRun, skillsGate, withSkillSession } from '../trace/skill-session.js';
import { checkedSuccess, runHelpers, writeRunSheet } from '../trace/runs.js';
import { trailNow } from '../skills/settings.js';
import { hostFacts } from '../skills/host-facts.js';
import { detectHost } from '../trace/host.js';
import { codexExitOf, outputBody, outputText } from '../trace/codex-exec.js';
import { offerDue } from '../skills/offer-moment.js';
import { postToolOfferText } from '../skills/offers.js';
import { hookError, type Sent } from './skills-hook-util.js';
import { notePool } from './stop-skills.js';
import { wallContextText, wallOfResult } from './walls-hook.js';

/** PostToolUse(Bash) with `failed` false; PostToolUseFailure(Bash) with `failed` true. Never throws. */
export function postBashSkills(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, failed = false): HookOut {
  return postBashRun(input, dir, env, failed).out;
}

export interface PostBashResult { out: HookOut; marked: boolean; sent: Sent }

/** 3.4: 1a's marks and post-tool offer, then 1b's wall fix. `marked` or a wall hit means it did work (the caller times those). */
export function postBashRun(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, failed = false): PostBashResult {
  const r = marksAndOffer(input, dir, env, failed);
  const sent: Sent = [];
  const wall = wallPart(input, dir, env, failed, sent);
  const context = [r.out.context, wall].filter(Boolean).join('\n');
  return { out: context ? { ...r.out, context } : r.out, marked: r.marked, sent };
}

/** 3.4 step 1 (1b): the fix line for a wall hit, and `wall_hit` telemetry. '' when none, or on any throw. */
function wallPart(input: any, dir: string, env: NodeJS.ProcessEnv, failed: boolean, sent: Sent): string {
  try {
    if (!skillsOnFast(env) || input?.tool_name !== 'Bash') return '';
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    // The patterns first (8 KB at most); the gate only for a hit.
    const cls = command ? wallOfResult(resultText(input, failed), command, failed) : null;
    if (!cls) return '';
    const g = skillsGate(input, dir, env);
    if (!g.ok) return '';
    const { text, hadLesson } = wallContextText(cls, { checkout: g.ctx.checkout, repoKey: g.ctx.repoKey, env, now: g.ctx.now });
    sent.push(['wall_hit', { class: cls, had_lesson: String(hadLesson) }]);
    // Where the host doesn't read this event's context, nothing is appended (P23; 2.10: Codex's PostToolUse until HC1).
    return reachesModel(input, env, failed) ? text : '';
  } catch (e) {
    hookError(failed ? 'post-bash-fail' : 'post-bash', e, env);
    return '';
  }
}

/** 1a's 3.4 steps 1 to 4. */
function marksAndOffer(input: any, dir: string, env: NodeJS.ProcessEnv, failed: boolean): { out: HookOut; marked: boolean } {
  try {
    // 1.
    if (!skillsOnFast(env) || input?.tool_name !== 'Bash') return { out: {}, marked: false };
    const sid = [input.session_id, input.sessionId].find((v) => typeof v === 'string' && v !== '') as string | undefined;
    const id = typeof input.tool_use_id === 'string' ? input.tool_use_id : '';
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    if (!sid || !id) return { out: {}, marked: false };
    const now = trailNow(env);
    const gate = existsSync(gateFilePath(sid, env));
    // 2. The asked call ran: the person said yes.
    if (!failed && gate) markApproved(sid, id, now, env);
    // 3.
    const family = command ? checkFamilyOf(command, null) : null;
    if (!gate && family === null) return { out: {}, marked: false };
    const tail = family === null ? undefined : cleanTail(resultText(input, failed));
    appendPostMark(sid, { id, at: now.toISOString(), failed, ...(tail ? { tail } : {}) }, env);
    // 4.
    if (failed || family === null || factsOf(input, env).offerChannel !== 'post-tool' || !reachesModel(input, env, failed)) return { out: {}, marked: true };
    return { out: postToolOffer(input, dir, env), marked: true };
  } catch (e) {
    hookError(failed ? 'post-bash-fail' : 'post-bash', e, env);
    return { out: {}, marked: false };
  }
}

/** The facts of the host that sent `input` (c7: Codex's for a Codex payload, Claude Code's otherwise). */
function factsOf(input: unknown, env: NodeJS.ProcessEnv) {
  return hostFacts(env, detectHost(input).host);
}

/**
 * This event's context reaches the model: PostToolUseFailure's where `failureContext`, PostToolUse's where
 * `postToolContext`. Codex has no PostToolUseFailure: its failed calls come on PostToolUse.
 */
function reachesModel(input: unknown, env: NodeJS.ProcessEnv, failed: boolean): boolean {
  const host = detectHost(input).host;
  const facts = hostFacts(env, host);
  return failed && host !== 'codex' ? facts.failureContext : facts.postToolContext;
}

/** 1.7: whether a Codex shell output failed, from its header only; null when the text names no exit (P34). */
export function codexFailed(toolResponse: unknown): boolean | null {
  const exit = codexExitOf(outputText(toolResponse));
  return exit && 'code' in exit ? exit.code !== 0 : null;
}

/**
 * 3.4, Codex: the exit from the output's header, then 1a's marks and 1b's wall part with the body as the rollout
 * reader shows it (`Exit code N` in front when not 0, as Claude Code writes a failed result). Null when the text
 * names no exit: nothing is written and the rollout's result is the only one (P34).
 */
export function codexPostBash(input: any, dir: string, env: NodeJS.ProcessEnv = process.env): PostBashResult | null {
  const failed = codexFailed(input?.tool_response);
  if (failed === null) return null;
  const text = outputText(input.tool_response);
  const exit = codexExitOf(text) as { code: number };
  const body = outputBody(text);
  const shown = failed ? `Exit code ${exit.code}\n${body}` : body;
  const as = failed ? { ...input, tool_response: undefined, error: shown } : { ...input, tool_response: shown };
  return postBashRun(as, dir, env, failed);
}

/**
 * What the call printed, as the transcript's result holds it: stdout then stderr joined with nothing, which is how
 * Claude Code writes a Bash result (its stderr brings its own line break; checked on local transcripts, g7 review),
 * or the error text (PostToolUseFailure's `error`).
 */
export function resultText(input: any, failed: boolean): string {
  if (failed) return typeof input?.error === 'string' ? input.error : '';
  const r = input?.tool_response;
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  return [r.stdout, r.stderr].filter((t): t is string => typeof t === 'string').join('');
}

/**
 * 3.4 step 4: the open run, with this mark folded, checks out (the turn's end is judged at Stop, when the reply is
 * known); its sheet and today's pool day are written, and when 4.12 holds the offer waits, not yet shown.
 */
function postToolOffer(input: any, dir: string, env: NodeJS.ProcessEnv): HookOut {
  const g = skillsGate(input, dir, env);
  if (!g.ok || !g.ctx.learn) return {};
  const ctx = g.ctx;
  const text = withSkillSession(ctx, { catchUp: true }, (st) => {
    const run = currentRun(st);
    if (!run || st.pendingOffer || !run.calls.length) return null;
    const verdict = checkedSuccess({ ...run, end: 'done' }, null);
    if (!verdict.checked) return null;
    const sheet = writeRunSheet(run, verdict, { host: ctx.host, tier: ctx.tier, sessionHash: ctx.sessionHash, helpers: runHelpers(run) }, env);
    notePool(run, ctx);
    const due = offerDue({ run, verdict, sheet, st, ctx, channel: 'post-tool' });
    if (!due.due) return null;
    st.pendingOffer = due.offer;
    return postToolOfferText(due.offer);
  });
  return text ? { context: text } : {};
}
