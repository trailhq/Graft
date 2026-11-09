/**
 * The skills part of UserPromptSubmit (design 3.2, spec 11): an answer to a
 * pending offer, credit for the last block, a "save this" ask, and the one
 * skill a prompt brings back. `handlePrompt` calls it right after the
 * 3-character floor and before `graft ask`.
 *
 * Hard deadline 400 ms (3.6): past it before the cue, the prompt gets no
 * block (never half of one); the ready probes get what is left, at most
 * 300 ms. The lock waits 150 ms; a timeout is nothing at all. Every throw
 * fails open: nothing out, one line in `state/hook-errors.log`.
 *
 * Consent is g5's: `captureAnswer` and `noteSaveRequest` are called with the
 * fold from this hook's own catch-up and nothing here sets a yes or a save
 * request. The typed words are never written anywhere: only their shapes
 * (a version, a PR number) ride on an injection as values.
 *
 * SessionStart's part is in start-skills.ts.
 */
import type { Host } from '../trace/host.js';
import { homedir } from 'node:os';
import type { HookOut } from '../skills/types.js';
import type { RunState, SkillInjection, SkillSessionState } from '../trace/types.js';
import { askText, matchJob } from '../trace/jobs.js';
import { isCorrection, isSaveRequest, scopeWords, typedPrompt, typedSha } from '../trace/typed.js';
import { currentRun, injectedThisEpoch, skillsGate, withSkillSession, type GateCtx } from '../trace/skill-session.js';
import { lastGoodRun } from '../trace/run-verdict.js';
import { findPriorSheet, readRunSheet, type FoldResult } from '../trace/runs.js';
import { track } from '../telemetry/track.js';
import { creditWindow, noteCorrectionLine, settleCredit, type Fired } from '../skills/credit.js';
import { compileRun } from '../skills/compile.js';
import { refusalWords } from '../skills/compile-words.js';
import { hostFacts } from '../skills/host-facts.js';
import { resolveParams } from '../skills/params.js';
import { lastUsedIn } from '../skills/state.js';
import { nameTaken } from '../skills/store.js';
import { candidatesHere, matchCue, nameOf, normalizePrompt, refusedAtRecall, withRunParams, type Candidate, type CueResult, type NormPrompt } from '../skills/recall.js';
import { checkLine, injectionFor, readOnlyCheck, runBlock, runProbes, useNotice, withReadyFailed, PROBE_BUDGET_MS, type ProbeOpts } from '../skills/runblock.js';
import { flatLine } from '../notes/flatten.js';
import { directive } from '../skills/directive-words.js';
import { consent as g5consent, type Consent } from './prompt-consent.js';
import { canAsk, hookError, scopeKeys, sendAll, syncGate, trimInjected, type Sent } from './skills-hook-util.js';
import { runCheckout } from '../skills/run-checkout.js';
import { lastResult, lastResultLine } from '../skills/check-result.js';
import { noteCodexPrompt } from '../trace/codex.js';
import { useFor } from '../trace/dialect.js';
import { stopBlockReason } from '../skills/offer-words.js';
import { recallMarks, saidIn, shownFiles, stepLearnings, withFixes } from '../skills/follow-learnings.js';
import { readSession } from './state.js';
import { payloadSessionId } from './hook-io.js';

export { sessionStartSkills } from './start-skills.js';

export const PROMPT_DEADLINE_MS = 400;
const LOCK_WAIT_MS = 150;
const LIVE_MS = 2 * 60 * 60 * 1000;
const MAX_ASK_WORDS = 25;

/** What tests swap: g5's two calls, telemetry, the gate (a temp folder reads as scratch), the probes' git, the deadline's clock. */
export interface PromptDeps {
  consent: Consent;
  track: (event: string, props: Record<string, string>) => void;
  gate: (input: unknown, dir: string, env?: NodeJS.ProcessEnv) => ReturnType<typeof skillsGate>;
  probes: ProbeOpts;
  clock: () => number;
  /** Part 7: the file names of the learnings this session showed already (the prompt hook's and on-touch's one list). */
  shown: () => ReadonlySet<string>;
}

/** The telemetry answer for each class g5 reports (stale and not-shown were never answered: nothing is sent). */
const ANSWERED: Record<string, string> = { yes: 'yes', show: 'show', no: 'no', other: 'none', retire: 'retire' };

/** 3.2. */
export function promptSkills(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, deps: Partial<PromptDeps> = {}): HookOut {
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + PROMPT_DEADLINE_MS;
  const sent: Sent = [];
  try {
    const g = (deps.gate ?? skillsGate)(input, dir, env);
    if (!g.ok) return {};
    const ctx = g.ctx;
    const typed = typedPrompt(String(input?.prompt ?? ''));
    if (!typed) return {};
    const d: PromptDeps = {
      consent: deps.consent ?? g5consent,
      track: deps.track ?? ((e, p) => track(e, p, { env: ctx.env, ...(ctx.checkout ? { repo: ctx.checkout } : {}) })),
      gate: deps.gate ?? skillsGate,
      probes: deps.probes ?? {},
      clock,
      shown: deps.shown ?? (() => {
        try { return shownFiles(readSession(dir, payloadSessionId(input)).injectedNotes); } catch { return new Set<string>(); }
      }),
    };
    // Phase 2 (3.2 step 1, P30, R7): on Codex the prompt's keyed hash goes into the session first, before the catch-up
    // reads the rollout, so the typed line already there counts as the person's. A prompt that is Trail's own Stop
    // reason (a continuation, should Codex send one through UserPromptSubmit, HC3) is never the person's: nothing runs.
    let own = false;
    const prepare = ctx.host === 'codex' ? (st: SkillSessionState) => {
      own = isOwnBlockReason(st, String(input?.prompt ?? ''), ctx.transcriptPath);
      if (!own) noteCodexPrompt(st, String(input?.prompt ?? ''), env);
    } : undefined;
    const out = withSkillSession(ctx, { catchUp: ctx.fold, waitMs: LOCK_WAIT_MS, ...(prepare ? { prepare } : {}) },
      (st, fold) => (own ? {} : inside(ctx, st, fold, typed, d, deadline, sent)));
    sendAll(sent, d.track);
    return out ?? {};
  } catch (e) {
    hookError('prompt', e, env);
    return {};
  }
}

function inside(ctx: GateCtx, st: SkillSessionState, fold: FoldResult | null, typed: string, d: PromptDeps, deadline: number, sent: Sent): HookOut {
  const { env, now } = ctx;
  const context: string[] = [];

  // 4. An answer to a pending offer: g5 records it; yes, show me and no end the prompt here. Phase 2 (4.9, D72, R1): a
  // retire is checked against the reply before it in the transcript, so the hook passes where it is.
  const cap = d.consent.captureAnswer(st, typed, env, now, { transcriptPath: ctx.transcriptPath });
  if (cap.answer && ANSWERED[cap.answer]) sent.push(['skill_answer', { answer: ANSWERED[cap.answer]! }]);
  if (cap.changed === 'retire') sent.push(['skill_changed', { op: 'retire' }]);
  if (cap.out) return cap.out;
  if (cap.extra) context.push(cap.extra);

  // 5. Credit (D57): the run a block came in for may have closed with this catch-up; then the correction window.
  if (ctx.learn) {
    // 1b (4.19): a cue phrase dropped at the flush says so once.
    const cueDropped = () => sent.push(['skill_stale', { reason: 'unfollowed' }]);
    // c8 (4.9): a firing this settle writes is considered by the next Stop's retire proposal.
    const fired = (f: Fired) => { if (!f.followed) st.firedLater = [...(st.firedLater ?? []), f].slice(-4); };
    for (const s of settleCredit(st, { host: ctx.host, env, now, sessionId: ctx.sessionId, cueDropped, fired })) sent.push(['skill_used', { outcome: s.outcome }]);
    creditWindow(st, isCorrection(typed) ? { sha: typedSha(typed) } : null, { env, now });
    noteCorrectionLine(st, fold?.typed ?? []);
  }

  // 6. "Save this as a skill" (moment 1).
  if (ctx.fold && isSaveRequest(typed)) {
    context.push(saveAsk(ctx, st, fold, typed, d));
    syncGate(ctx, st);
    return { context: context.join('\n') };
  }

  const np = normalizePrompt(typed);
  let cached: Candidate[] | null = null;
  const cands = () => (cached ??= (() => {
    const r = candidatesHere({ repoKeys: scopeKeys(ctx, st), checkout: ctx.checkout, env });
    // Phase 2 (4.6): a proposal the person copied over their file is Trail's own again.
    for (const _ of r.adopted) sent.push(['skill_changed', { op: 'adopted' }]);
    return r.cands;
  })());

  // 7. Liveness, before the cue.
  endBlocks(st, typed, np, now, cands, askRun(st, fold, typed));

  // 8. The cue, while there is time for it.
  let notice: string | undefined;
  let said: string[] | undefined;
  if (d.clock() < deadline) {
    const mine = [...st.injected].reverse().find((i) => i.cue !== 'check');
    // A block this session counts as used just now; otherwise the newest use here, within 24 hours.
    const lastUsed = mine ? { id: mine.skillId, at: now.toISOString() } : lastUsedIn(scopeKeys(ctx, st), env);
    const cue = matchCue(np, cands(), lastUsed, now);
    // Reading a large store can use up the time: past the deadline, no block this prompt (never half of one).
    if (!cue || d.clock() >= deadline) { /* nothing */ } else if (cue.kind === 'check') {
      const values = checkValues(cue, np, mine && mine.skillId === cue.cand.ref.id ? mine : null);
      // D116 item 1: a check that changes things (the push that moved prod) is never one to run for a status
      // question; the last run's recorded result answers instead.
      const line = refusedAtRecall(cue.cand.skill, values) ? ''
        : readOnlyCheck(cue.cand.skill) ? checkLine(cue.cand, values)
        : lastResultLine(cue.cand, typed, lastResult(cue.cand, mine ?? null, st.runs, env));
      if (line) {
        context.push(line);
        st.injected.push(injectionFor(cue.cand, values, 'check', st.epoch, now));
      }
    } else {
      const run = askRun(st, fold, typed);
      // D118 b: what an earlier ask of this run named (the version) holds across its turns and re-sent blocks.
      const r = bring(ctx, st, run ? withRunParams(cue, run.promptParams, np) : cue, d, deadline, run);
      if (r) {
        context.push(r.context);
        notice = r.notice;
        if (r.said?.length) said = r.said;
      }
    }
  }
  trimInjected(st);
  syncGate(ctx, st);
  const out: HookOut = {};
  if (context.length) out.context = context.join('\n');
  if (notice) out.notice = notice;
  if (said) out.said = said;
  return out;
}

/** 4.16: the prompt is the Stop block reason Trail gave for the offer it holds (whitespace aside). */
function isOwnBlockReason(st: SkillSessionState, prompt: string, transcriptPath: string | null): boolean {
  const po = st.pendingOffer;
  if (!po || po.channel !== 'stop' || !po.shownAt) return false;
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
  const reason = flat(stopBlockReason(po, transcriptPath, useFor('codex', st)));
  return reason !== '' && flat(prompt) === reason;
}

/** 3.2 step 6. */
function saveAsk(ctx: GateCtx, st: SkillSessionState, fold: FoldResult | null, typed: string, d: PromptDeps): string {
  const env = ctx.env;
  const last = lastGoodRun(st, env);
  if ('none' in last) return directive(typed, nothingToKeep(last));
  const { run, sheet } = last;
  const scope = scopeWords(typed);
  const keys = st.scopeKeys.includes(run.repoKey) ? st.scopeKeys : [run.repoKey];
  // D93: the run's own checkout, as both halves of the save gate compile it.
  const root = runCheckout(sheet, env, ctx.repoKey === sheet.repoKey ? ctx.checkout : '');
  const compiled = compileRun(sheet, {
    repoRoot: root, home: env.HOME || homedir(), platform: process.platform,
    prior: findPriorSheet(sheet, env), moment: 'asked', applies: scope === 'every repo' ? 'every repo' : run.repoKey, now: ctx.now, askedWith: typed,
    readSheet: (id) => readRunSheet(id, env), taken: (n) => nameTaken(n, { repoKeys: keys, checkout: root || ctx.checkout, env }) !== null,
    learnings: stepLearnings({ repoKeys: [sheet.repoKey], checkout: root, env }),
  });
  if (!compiled.ok) {
    const words = refusalWords(compiled.reason, compiled.detail);
    return directive(typed, `Trail can't keep that job as a skill: ${words}. Let them know: "I can't keep that as a skill: ${words}."`);
  }
  d.consent.noteSaveRequest(st, fold, { runId: run.id, typed, scope, skill: compiled.skill }, env, ctx.now);
  return directive(typed, `The last job here worked, so to keep it as they asked, run: trail skills add ${compiled.skill.name} --run ${run.id}. `
    + 'Trail checks their words in this session before it keeps anything. Then tell them the line it prints.');
}

/** 3.2 step 6, no run to keep: Trail's reason, then the words for the person (D101). */
function nothingToKeep(last: { none: 'nothing' | 'failed' | 'skill' | 'unproven'; skillName?: string }): string {
  if (last.none === 'skill') {
    const name = flatLine(last.skillName ?? 'a skill', 60);
    return `That job already ran from the skill ${name}, so Trail has nothing new to keep. Let them know: "That job already ran from the skill ${name}, so there's nothing new to keep."`;
  }
  if (last.none === 'failed') {
    return `${ONLY_WORKED} and the last one didn't finish cleanly. Let them know: "There's nothing to keep yet: the last job didn't finish cleanly. Ask me again once it works."`;
  }
  if (last.none === 'unproven') {
    return `${ONLY_WORKED} and the last command passed only through its fallback (|| echo, || true or || :), so Trail can't tell it worked. `
      + 'Let them know: "There\'s nothing to keep yet: the last command only passed through its fallback, so I can\'t tell it worked. Ask me again once it works."';
  }
  return `${ONLY_WORKED} and no job has finished here since the conversation started or was last compacted. Let them know: "There's nothing to keep yet: no job has finished here since the conversation was last compacted. Ask me again once one works."`;
}

const ONLY_WORKED = 'Trail keeps only a job that worked,';

/**
 * 3.2 step 7: another job, over 25 words or 2 hours end a block; a status question or a short follow-up keeps it.
 * D116 item 3: a line the fold folded into the block's own run (a go-ahead, an answer to the agent's question) keeps
 * it at any length: the block lives as long as its run.
 */
function endBlocks(st: SkillSessionState, typed: string, np: NormPrompt, now: Date, cands: () => Candidate[], run: RunState | null): void {
  const live = st.injected.filter((i) => i.live);
  if (!live.length) return;
  const job = np.status ? null : matchJob(askText(typed))?.job ?? null;
  for (const inj of live) {
    const age = now.getTime() - Date.parse(inj.at);
    const skillJob = job === null ? null : cands().find((c) => c.ref.id === inj.skillId)?.skill.meta.job ?? null;
    const ownRun = run !== null && inj.runId === run.id;
    if (!(age < LIVE_MS) || (np.wordCount > MAX_ASK_WORDS && !ownRun) || (job !== null && job !== skillJob)) inj.live = false;
  }
}

/** 3.2 step 8, job or name cue: a block, or a re-arm of the one this epoch already has. Null: its filled steps are refused. */
/**
 * The run of this very prompt, when this hook's catch-up folded its typed line (Claude Code writes the line before
 * the hook runs): the block it brings belongs to that run, and no other ask typed a moment before or after it.
 * Null when the line isn't on disk yet (the next fold links the block) or it started no run.
 */
function askRun(st: SkillSessionState, fold: FoldResult | null, typed: string): RunState | null {
  const last = fold?.typed[fold.typed.length - 1];
  if (!last || last.sha !== typedSha(typed)) return null;
  const run = currentRun(st);
  return run && Date.parse(run.lastAt) >= Date.parse(last.at) ? run : null;
}

function bring(ctx: GateCtx, st: SkillSessionState, cue: CueResult, d: PromptDeps, deadline: number, run: RunState | null): { context: string; notice?: string; said?: string[] } | null {
  const { env, now } = ctx;
  const c = cue.cand;
  // The risk rules on the steps as the block would show them, values filled in (a default can be edited by hand).
  if (refusedAtRecall(c.skill, cue.values)) return null;
  const prior = [...injectedThisEpoch(st)].reverse().find((i) => i.skillId === c.ref.id && i.cue !== 'check');
  if (prior && sameValues(prior.params, cue.values)) {
    // D65: a re-armed block is for the next ask's run. D137: after a hand-off it continues that block's run and window,
    // but only while the fold continued that run (the 2-hour wait); a new run starts a new window with nothing handed.
    if (prior.handed?.length && (run === null || run.id === prior.runId)) Object.assign(prior, { live: true, runId: run?.id ?? prior.runId });
    else {
      delete prior.handed;
      Object.assign(prior, { live: true, at: now.toISOString(), runId: run?.id ?? null });
    }
    if (run) run.skillId = c.ref.id;
    return { context: `[trail] Same job as before: start from the steps of skill ${nameOf(c)} above.` };
  }
  // Part 7: what the person's live learnings say of these steps; the block says each once, and its steps are what credit reads.
  // Read before the probes, so their budget is what is left. Past the deadline the block goes without them, and the prompt's learnings lines still say them.
  const marks = d.clock() < deadline ? recallMarks(c.skill.steps, stepLearnings({ repoKeys: scopeKeys(ctx, st), checkout: ctx.checkout, env }), d.shown()) : [];
  const budgetMs = Math.max(0, Math.min(PROBE_BUDGET_MS, deadline - d.clock()));
  const probes = runProbes(c.skill, ctx.checkout, now, env, { ...d.probes, budgetMs });
  const lastFail = c.state?.lastFails?.length ? c.state.lastFails[c.state.lastFails.length - 1]! : null;
  // Phase 2 (3.2 step 5): the anchors' CLI scan gets only what the 400 ms leave after the probes (the hook's clock may be a test's).
  const anchorDeadline = Date.now() + Math.max(0, deadline - d.clock());
  const block = runBlock(c, { values: cue.values, notes: cue.notes, probes, canAsk: canAsk(ctx), header: 'job', lastFail, anchorDeadline, marks });
  const inj = withReadyFailed(injectionFor({ ...c, skill: withFixes(c.skill, marks) }, cue.values, cue.kind, st.epoch, now), probes);
  if (run) {
    inj.runId = run.id;
    run.skillId = c.ref.id;
  }
  // New values: the full block replaces that injection's values and steps (same injId, a fresh run).
  if (prior) st.injected[st.injected.indexOf(prior)] = { ...inj, injId: prior.injId };
  else st.injected.push(inj);
  const said = saidIn(block, marks);
  return { context: block, ...(hostFacts(env, ctx.host as Host).promptNotice ? { notice: useNotice(c) } : {}), ...(said.length ? { said } : {}) };
}

/** The check uses the values of the block it checks, and any the question itself names. */
function checkValues(cue: CueResult, np: NormPrompt, block: SkillInjection | null): Record<string, string> {
  const defs = cue.cand.skill.params;
  const plain = resolveParams(defs, {}).values;
  const asked = Object.fromEntries(Object.entries(cue.values).filter(([k, v]) => plain[k] !== v));
  return { ...cue.values, ...(block?.params ?? {}), ...asked };
}

const sameValues = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

