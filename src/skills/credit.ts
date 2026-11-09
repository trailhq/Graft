/**
 * Settling credit for run blocks (design 3.5 step 5, 3.2 step 5, 4.8), for
 * Stop and the prompt hook alike, inside `withSkillSession`'s fn.
 *
 * A block's use is credited from the commands that ran after it came in and
 * flushed once, when its run closed or its check passed: one ledger `use`
 * line, one `recordUse`. The prompt hook settles too (D57): a run the next
 * typed ask closes is never seen open by a Stop, and once its sheet is
 * written the session drops its calls, so they are read from the sheet.
 *
 * A job a compaction cut and the agent carried on (D59a, `carriedFrom`) is
 * one use: the cut run's block and the compaction re-inject (same skill, the
 * carried run) are credited together over both halves' calls, oldest first,
 * joined the way g3 joins them for compile (`joinCarriedSheet`, so the same
 * links hold), and flushed together when the newest half closes or its check
 * passes. A cut run still waiting to be carried (`st.cut`) is not credited
 * alone.
 *
 * A block nothing ran from (no step ran or failed, the check never ran) is
 * settled without a use: the skill wasn't used.
 */
import type { CreditState, RunSheet, RunState, SkillInjection, SkillSessionState } from '../trace/types.js';
import type { LedgerUse, ParsedSkill, SkillState } from './types.js';
import { appendLedger, creditRun, newUseId, probeForm } from './ledger.js';
import { getSkillState, recordCorrected, recordUse } from './state.js';
import { listAllPersonal, readSkill } from './store.js';
import { readRunSheet } from '../trace/run-sheets.js';
import { joinCarriedSheet, MAX_CARRY_HOPS } from '../trace/run-join.js';
import { cueFlush } from './staleness.js';
import { useFacts } from './credit-facts.js';
import { noteFiring, type Fired } from './offer-retire.js';
import { readHanded } from '../trace/gate-file.js';
export type { Fired };

const MAX_CREDIT = 10;

export interface Settled {
  /** The blocks this use flushed (two for a job carried across a compaction). */
  injIds: string[];
  skillId: string;
  name: string;
  use: LedgerUse;
  outcome: 'checked' | 'failed' | 'unchecked';
  /** The skill's state after recordUse (undefined when it has none, or the state was busy). */
  state: SkillState | undefined;
}

export interface SettleCtx {
  host: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /**
   * The ready probes that failed for a block (their forms go in the use line, never their text; they never count
   * against the skill). Default: the injection's own `readyFailed`.
   */
  readyFailed?: (inj: SkillInjection) => string[];
  /** 1b (4.19): an asks phrase was dropped at this flush (for the caller's skill_stale{unfollowed}). */
  cueDropped?: (skillId: string, name: string) => void;
  /** Phase 2 (4.9): a firing was written at this flush (for the retire proposal, which needs a not-followed one). */
  fired?: (f: Fired) => void;
  /** c8 (D137): the session whose gate file holds the gated steps handed to the person since the last settle. */
  sessionId?: string;
}

const HANDED_SLACK_MS = 5_000;

/** D137: the gate file's hand-offs onto their blocks and the blocks' runs, so credit counts each step as handed. */
function pullHanded(st: SkillSessionState, sessionId: string, env?: NodeJS.ProcessEnv): void {
  let marks: ReturnType<typeof readHanded>;
  try {
    marks = readHanded(sessionId, env);
  } catch {
    return;
  }
  for (const m of marks) {
    const inj = st.injected.find((i) => i.injId === m.injId);
    if (!inj || m.n > inj.steps.length || !inj.gated.some((g) => g.step === m.n)) continue;
    // A hand-off from before the block's window (a re-arm for a new run) is that earlier run's, never this one's.
    if (!(Date.parse(m.at) >= Date.parse(inj.at) - HANDED_SLACK_MS)) continue;
    const list = (inj.handed ??= []);
    if (!list.some((h) => h.n === m.n)) list.push({ n: m.n, at: m.at });
    const run = inj.runId ? st.runs.find((r) => r.id === inj.runId) : undefined;
    if (run && !(Date.parse(run.handedAt ?? '') >= Date.parse(m.at))) run.handedAt = m.at;
  }
}


/** An injection's failed probes as the session file holds them: a list of strings, else none. */
export function injReadyFailed(inj: SkillInjection): string[] {
  const r: unknown = inj.readyFailed;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
}

/** A run the session still holds, as a sheet, so g3's join can link it like any other part. */
function stateSheet(run: RunState, st: SkillSessionState): RunSheet {
  return {
    v: 1, id: run.id, session: st.sessionHash, repoKey: run.repoKey, branch: run.branch, host: st.host, tier: st.tier, epoch: run.epoch,
    startedAt: run.startedAt, endedAt: run.lastAt, job: run.job, jobWords: run.jobWords, sharedWords: run.sharedWords, promptParams: run.promptParams,
    calls: run.calls, checkIndex: null, checked: false, end: run.end,
    counts: { commands: run.commands, failed: run.failedCount, toolCalls: run.toolCalls, edits: run.edits }, helpers: [], skillId: run.skillId ?? null,
    ...(run.carriedFrom ? { carriedFrom: run.carriedFrom } : {}),
  };
}

/**
 * A run of this session as a sheet: from the state while it holds the calls (open, or just closed inside the
 * hook's fn), else its run sheet when the sheet is this session's, else (closed with no step call, so no sheet)
 * the state's empty run, whose `carriedFrom` still links the parts on either side. Null for anything else.
 */
function partOf(id: string, st: SkillSessionState, env?: NodeJS.ProcessEnv): RunSheet | null {
  const run = st.runs.find((r) => r.id === id);
  if (run && (run.calls.length || !run.closed)) return stateSheet(run, st);
  const sheet = readRunSheet(id, env);
  if (sheet && sheet.session === st.sessionHash) return sheet;
  return run ? stateSheet({ ...run, calls: [] }, st) : null;
}

/** A job across compactions (D59a): its parts joined oldest first, the ids of the parts, and whether the newest closed. */
interface Job { sheet: RunSheet; ids: string[]; closed: boolean }

function joined(tail: RunSheet, st: SkillSessionState, env?: NodeJS.ProcessEnv): Job {
  const sheet = joinCarriedSheet(tail, (id) => partOf(id, st, env));
  const run = st.runs.find((r) => r.id === tail.id);
  return { sheet, ids: [...(sheet.joined ?? []).map((j) => j.id), tail.id], closed: run ? run.closed : true };
}

/**
 * The job a run belongs to: forward to the newest run carried from it (the session's runs, same job, at most
 * MAX_CARRY_HOPS), then back through `joinCarriedSheet`, which checks each link (same session and job, the epoch
 * before or the same, ended before the next began). When the join from that newest run doesn't reach this one,
 * the links don't hold and the run is its own job (joined back from itself).
 */
function jobOf(runId: string, st: SkillSessionState, env?: NodeJS.ProcessEnv): Job | null {
  const start = partOf(runId, st, env);
  if (!start) return null;
  let tail = start;
  for (let hop = 0; hop < MAX_CARRY_HOPS; hop++) {
    const next = st.runs.find((r) => r.carriedFrom === tail.id && r.job === tail.job);
    const part = next ? partOf(next.id, st, env) : null;
    if (!part) break;
    tail = part;
  }
  const job = joined(tail, st, env);
  return job.ids.includes(runId) ? job : joined(start, st, env);
}

/** The skill's SKILL.md as it is now (its version is the ledger's `v`, '1' when it can't be read), or null. */
function skillOf(skillId: string, name: string, env?: NodeJS.ProcessEnv): ParsedSkill | null {
  const refs = listAllPersonal(env);
  const ref = refs.find((r) => r.id === skillId && r.name === name) ?? refs.find((r) => r.id === skillId);
  return ref ? readSkill(ref) : null;
}

/** The credit entry for this block and run, made when missing. */
function entryFor(st: SkillSessionState, inj: SkillInjection, useId: string): CreditState {
  let c = st.credit.find((x) => x.injId === inj.injId && x.runId === inj.runId);
  if (!c) {
    c = { useId, injId: inj.injId, skillId: inj.skillId, epoch: inj.epoch, runId: inj.runId, stepsRan: [], failedStep: null, check: 'none', calls: 0, failed: 0, flushed: false, promptsAfter: 0 };
    // 1b (R30): the asks phrase a job cue fired on, as its sha.
    if (typeof inj.phraseSha === 'string' && /^[0-9a-f]{8}$/.test(inj.phraseSha)) c.phraseSha = inj.phraseSha;
    st.credit.push(c);
  }
  return c;
}

/** At most 10 entries, newest last: settled ones go first. */
function trimCredit(st: SkillSessionState): void {
  while (st.credit.length > MAX_CREDIT) {
    const i = st.credit.findIndex((c) => c.flushed);
    st.credit.splice(i >= 0 ? i : 0, 1);
  }
}

/**
 * Credits every block with a run (any epoch: a compaction may have closed it), and flushes each use that is done.
 * Changes `st.credit` and, on a passed check, the blocks' `live`. Returns the uses flushed now, for telemetry
 * `skill_used{outcome}` and the Stop use line.
 */
export function settleCredit(st: SkillSessionState, ctx: SettleCtx): Settled[] {
  const now = ctx.now ?? new Date();
  if (ctx.sessionId) pullHanded(st, ctx.sessionId, ctx.env);
  const groups = new Map<string, { injs: SkillInjection[]; job: Job }>();
  for (const inj of st.injected) {
    if (inj.cue === 'check' || !inj.runId) continue;
    const job = jobOf(inj.runId, st, ctx.env);
    if (!job) continue;
    const key = `${inj.skillId}|${job.ids[0]}`;
    const g = groups.get(key) ?? { injs: [], job };
    g.injs.push(inj);
    groups.set(key, g);
  }
  const out: Settled[] = [];
  for (const { injs, job } of groups.values()) {
    injs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const known = injs.map((i) => st.credit.find((c) => c.injId === i.injId && c.runId === i.runId)).filter((c): c is CreditState => !!c);
    const done = known.find((c) => c.flushed);
    if (done) {
      for (const i of injs) Object.assign(entryFor(st, i, done.useId), { flushed: true, useId: done.useId });
      continue;
    }
    const useId = known[0]?.useId ?? newUseId();
    const oldest = injs[0]!;
    const newest = injs[injs.length - 1]!;
    // D137: every block's hand-offs count for the use (a re-armed block keeps its first block's window and marks).
    const handedAll = injs.flatMap((i) => i.handed ?? []).filter((h) => h.n <= newest.steps.length);
    const credit = creditRun({ ...newest, at: oldest.at, cue: newest.cue === 'check' ? 'job' : newest.cue, handed: handedAll }, job.sheet.calls);
    const handed = [...new Set(handedAll.map((h) => h.n))].sort((a, b) => a - b);
    const entries = injs.map((i) => Object.assign(entryFor(st, i, useId), credit, { useId }));
    if (st.cut === job.sheet.id || !(job.closed || credit.check === 'passed')) continue;
    for (const e of entries) Object.assign(e, { flushed: true, promptsAfter: 0 });
    if (credit.check === 'passed') for (const i of injs) i.live = false;
    // 1b (4.19): a job cue's block whose steps never ran is a miss for its phrase; two in a row drop it. A block whose
    // ready probes failed is neither a miss nor a follow: not running it was right (J14c, review).
    const sha = entries.find((e) => typeof e.phraseSha === 'string')?.phraseSha ?? null;
    const notReady = injs.some((i) => (ctx.readyFailed ?? injReadyFailed)(i).length > 0);
    // Phase 2 (R27): a skill retired or forgotten while its block was live: the ledger keeps the use, nothing else moves.
    const gone = getSkillState(newest.skillId, ctx.env)?.status === 'retired';
    if (sha && !notReady && !gone) {
      try {
        if (cueFlush(newest.skillId, sha, credit.stepsRan.length > 0, ctx.env, now).dropped) ctx.cueDropped?.(newest.skillId, newest.name);
      } catch { /* the use still counts */ }
    }
    // Phase 2 (4.9): a job or name cue's settled block is a firing, followed when a step ran (P46: learning half).
    const followed = credit.stepsRan.length > 0;
    if (!notReady && !gone && (newest.cue === 'job' || newest.cue === 'name') && noteFiring(newest.skillId, followed, ctx.env, now)) {
      ctx.fired?.({ skillId: newest.skillId, name: newest.name, followed, runId: job.sheet.id, at: now.toISOString() });
    }
    // Nothing of the skill ran: settled, but it was not used.
    if (!credit.stepsRan.length && credit.failedStep === null && credit.check === 'none') continue;
    const skill = skillOf(newest.skillId, newest.name, ctx.env);
    const use: LedgerUse = {
      at: now.toISOString(), event: 'use', useId, skill: newest.skillId, v: skill?.meta.version || '1', host: ctx.host,
      cue: oldest.cue === 'check' ? 'job' : oldest.cue, repo: job.sheet.repoKey, stepsRan: credit.stepsRan, failedStep: credit.failedStep,
      readyFailed: [...new Set(injs.flatMap((i) => (ctx.readyFailed ?? injReadyFailed)(i)).map(probeForm))], check: credit.check, calls: credit.calls, failed: credit.failed,
      // Phase 2 (4.1): next-run fidelity, counts and 8-hex keys only.
      ...useFacts(skill, { ...newest, at: oldest.at, handed: handedAll }, job.sheet, ctx.env ?? process.env),
      ...(handed.length ? { handed } : {}),
    };
    try { appendLedger(newest.skillId, use, ctx.env); } catch { /* the state below still counts it */ }
    const state = gone ? undefined : recordUse(newest.skillId, use, ctx.env);
    out.push({
      injIds: injs.map((i) => i.injId), skillId: newest.skillId, name: newest.name, use, state,
      outcome: credit.check === 'passed' ? 'checked' : credit.failedStep !== null ? 'failed' : 'unchecked',
    });
  }
  trimCredit(st);
  return out;
}

/**
 * The 2-prompt correction window (3.2 step 5): each settled use counts this typed prompt; a correction within the
 * window is one ledger `corrected` line for that use (`recordCorrected`, which makes two in a row needs-fix), and
 * closes its window. Returns the use ids marked corrected now.
 *
 * 1b (R10, P17, 4.14 step 1): `correction` is the typed line's sha (`typedSha`), or null for any other prompt. A
 * use marked now gets `corrected = { offset: null, sha }` on its credit (the fold fills the offset from the person's
 * own line, noteCorrectionLine) and becomes the session's `lessonWatch`. Only the sha is kept, never the words. A 1a
 * caller's `true` still marks the use, with nothing watched.
 */
export function creditWindow(st: SkillSessionState, correction: { sha: string } | null, ctx: { env?: NodeJS.ProcessEnv; now?: Date }): string[] {
  const isCorrection = !!correction;
  const sha = correction && typeof correction === 'object' && typeof correction.sha === 'string' && /^[0-9a-f]{64}$/.test(correction.sha) ? correction.sha : null;
  const now = ctx.now ?? new Date();
  const marked: string[] = [];
  const seen = new Set<string>();
  for (const c of st.credit) {
    if (!c.flushed || c.promptsAfter >= 2) continue;
    const first = !seen.has(c.useId);
    seen.add(c.useId);
    if (!isCorrection) {
      c.promptsAfter += 1;
      continue;
    }
    c.promptsAfter = 2;
    if (first && getSkillState(c.skillId, ctx.env) && recordCorrected(c.skillId, c.useId, ctx.env, now)) {
      marked.push(c.useId);
      if (sha) st.lessonWatch = { skillId: c.skillId, useId: c.useId, typedSha: sha, at: now.toISOString() };
    }
  }
  if (sha) for (const c of st.credit) if (marked.includes(c.useId)) c.corrected = { offset: null, sha };
  return marked;
}

/**
 * 4.14 step 1: once the fold meets the person's own typed line whose sha a correction recorded, its offset goes on
 * the credit (a filled offset stays). `typed` is the fold's typed events (person-typed only, `FoldResult.typed`).
 * The prompt hook calls it right after creditWindow with its own catch-up (Claude Code writes the line before the
 * hook runs, so that fold has already met it and no later fold will); Stop calls it too, for a line written late.
 */
export function noteCorrectionLine(st: SkillSessionState, typed: Array<{ offset: number; sha: string }>): void {
  for (const c of st.credit) {
    if (!c.corrected || c.corrected.offset !== null) continue;
    // The newest line with the sha: the one the hook that recorded it saw (an older identical line came before the use).
    const hit = typed.filter((t) => t.sha === c.corrected!.sha && Number.isInteger(t.offset) && t.offset >= 0).pop();
    if (hit) c.corrected = { offset: hit.offset, sha: c.corrected.sha };
  }
}
