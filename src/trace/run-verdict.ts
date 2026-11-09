/**
 * Whether a run worked (design 4.2) and which run "save this" means (4.7).
 * Re-exported from `runs.ts`, where the design names these functions.
 *
 * A run is a checked success when a check that fits its job passed, no step
 * came after it, nothing broke after it, and the turn ended done. A push that
 * moved the remote ref is a ship check (D56a), and a deploy seen still
 * building after it undoes it.
 */
import { callText, endsInFailure, endsInQuestion, fallbackOnly } from './checks.js';
import { OFFER_FAMILIES } from './jobs.js';
import { runHelpers } from './run-calls.js';
import { joinCarriedSheet } from './run-join.js';
import { readRunSheet, writeRunSheet } from './run-sheets.js';
import type { CheckedVerdict } from './runs.js';
import type { CheckFamily, CheckHit, RunCall, RunEnd, RunSheet, RunState, SkillSessionState } from './types.js';

/** A real check passed: one not behind a fallback (D101). */
const realPass = (c: RunCall) => c.check?.passed === true && !fallbackOnly(callText(c));

const SHIP_PROOF: ReadonlySet<CheckFamily> = new Set<CheckFamily>(['push', 'deploy', 'ls-remote']);

/**
 * The families whose later unpassed check undoes check `k` (D56a): a push, a deploy or ls-remote is undone by
 * a deploy or ls-remote after it that did not pass (still building, queued, not at the pushed commit).
 * Tests and queries are steps, so condition 3 already covers them; npm-view is left as 4.2 has it.
 */
function proofFamilies(k: CheckFamily, fits: CheckFamily[] | null): ReadonlySet<CheckFamily> {
  if (!SHIP_PROOF.has(k)) return new Set();
  return fits === null ? SHIP_PROOF : new Set(fits.filter((f) => SHIP_PROOF.has(f)));
}

/** The ship vocabulary's branch words (jobs.ts: production is canonical prod). */
const SHIP_BRANCH_WORDS: Readonly<Record<string, string[]>> = { beta: ['beta'], prod: ['prod', 'production'], staging: ['staging'] };

/**
 * D64: the branches a ship ask named: its beta, prod (prod or production) and staging words, and a branch
 * name typed in it (`promptParams.branch`, "push branch wa-cutover to beta"). Empty when it named none.
 */
export function shipBranches(run: Pick<RunState, 'jobWords' | 'promptParams'>): string[] {
  const out = run.jobWords.flatMap((w) => SHIP_BRANCH_WORDS[w] ?? []);
  const typed = run.promptParams.branch;
  if (typed && !out.includes(typed)) out.push(typed);
  return out;
}

/**
 * Whether a passing check proves the run's job (4.2 condition 2). D64: for ship, a push proves it only when
 * it moved a branch the ask named; a push of any other branch (a side branch after the prod push was
 * refused) is no ship check.
 */
function fitsJob(run: RunState, ch: CheckHit, fits: CheckFamily[] | null): boolean {
  if (fits === null) return true;
  if (!fits.includes(ch.family)) return false;
  if (run.job !== 'ship' || ch.family !== 'push') return true;
  const branch = ch.facts.branch;
  return branch !== undefined && shipBranches(run).includes(branch);
}

/**
 * The run's essential steps (D58a/b), which conditions 3 to 5 and leg A read: step calls in the checkout of
 * the run's own repo. A step in another repo or a scratch folder is left out of the skill, so it neither
 * covers, breaks nor ends the job. A run with no step in its repo (a session outside git) keeps every step.
 */
export function essentialSteps(calls: RunCall[], repoKey: string): RunCall[] {
  const steps = calls.filter((c) => c.kind === 'step');
  const inRepo = steps.filter((c) => c.key === repoKey && c.cwd !== null);
  return inRepo.length ? inRepo : steps;
}

/** 4.2. lastAssistant null: judge the end from run.end as the last Stop computed it. */
export function checkedSuccess(run: RunState, lastAssistant: string | null): CheckedVerdict {
  const calls = run.calls;
  const essential = essentialSteps(calls, run.repoKey);
  let end: RunEnd;
  if (essential[essential.length - 1]?.failed) end = 'failure';
  else if (lastAssistant === null) end = run.end;
  else if (endsInFailure(lastAssistant)) end = 'failure';
  else if (endsInQuestion(lastAssistant)) end = 'question';
  else end = 'done';

  if (run.job === 'pr-green' || run.job === 'sweep') return { checked: false, checkIndex: null, end, why: 'judgement' };
  if (run.job === 'run-local') return { checked: false, checkIndex: null, end, why: 'no-check-for-job' };
  const fits = run.job === null ? null : OFFER_FAMILIES[run.job] ?? [];
  let k = -1;
  for (let i = calls.length - 1; i >= 0; i--) {
    const ch = calls[i]!.check;
    // D101: a pass that may come only from an `|| echo` / `|| true` fallback (stored by an older fold) is no check.
    if (ch?.passed && fitsJob(run, ch, fits) && !fallbackOnly(callText(calls[i]!))) { k = i; break; }
  }
  if (k < 0) {
    const passed = calls.some(realPass);
    return { checked: false, checkIndex: null, end, why: passed ? 'check-misfit' : 'no-check' };
  }
  // D116 item 3: after a go-ahead to a turn that ended in failure, only a check from then on checks the run out.
  if (run.failedTurn !== undefined && k < run.failedTurn) return { checked: false, checkIndex: null, end, why: 'failed-turn' };
  const kept = new Set(essential);
  const after = calls.slice(k + 1).filter((c) => kept.has(c));
  if (after.some((c) => c.failed)) return { checked: false, checkIndex: null, end, why: 'failed-after-check' };
  if (after.length) return { checked: false, checkIndex: null, end, why: 'step-after-check' };
  // D56a: a later check of the same proof that did not pass (a deploy still building after the push) undoes it.
  const proof = proofFamilies(calls[k]!.check!.family, fits);
  if (calls.slice(k + 1).some((c) => c.check && !c.check.passed && proof.has(c.check.family))) {
    return { checked: false, checkIndex: null, end, why: 'unpassed-after-check' };
  }
  if (end !== 'done') return { checked: false, checkIndex: k, end, why: `end-${end}` };
  return { checked: true, checkIndex: k, end };
}

const ECHO_FALLBACK = /\|\|\s*[({]?\s*(?:echo|printf)(?![\w.-])/;

/**
 * D101 item 5: the run's success may come only from fallbacks. Its last essential step ends in an `|| echo` /
 * `|| printf` (that echo is usually the failure's own message: "docker not running"), or every essential step ends
 * in a fallback, and no real check passed. A cleanup's `|| true` after real work is fine.
 */
function unproven(calls: RunCall[], repoKey: string): boolean {
  if (calls.some(realPass)) return false;
  const steps = essentialSteps(calls, repoKey);
  const last = steps[steps.length - 1];
  if (!last) return false;
  const text = callText(last);
  if (fallbackOnly(text) && ECHO_FALLBACK.test(text)) return true;
  return steps.every((c) => fallbackOnly(callText(c)));
}

/** 4.7. */
export function lastGoodRun(st: SkillSessionState, env?: NodeJS.ProcessEnv): { run: RunState; sheet: RunSheet } | { none: 'nothing' | 'failed' | 'skill' | 'unproven'; skillName?: string } {
  let run: RunState | undefined;
  for (let i = st.runs.length - 1; i >= 0; i--) {
    const r = st.runs[i]!;
    if (r.epoch === st.epoch && r.stepCalls > 0) { run = r; break; }
  }
  if (!run) return { none: 'nothing' };
  if (run.skillId) {
    const name = [...st.injected].reverse().find((i) => i.skillId === run.skillId)?.name;
    return name ? { none: 'skill', skillName: name } : { none: 'skill' };
  }
  const meta = { host: st.host, tier: st.tier, sessionHash: st.sessionHash };
  let sheet: RunSheet | null = null;
  if (run.calls.length) {
    const steps = essentialSteps(run.calls, run.repoKey);
    if (steps[steps.length - 1]?.failed || run.end === 'failure') return { none: 'failed' };
    if (unproven(run.calls, run.repoKey)) return { none: 'unproven' };
    sheet = run.sheet !== 'none' && run.closed ? readRunSheet(run.id, env) : null;
    if (!sheet) sheet = writeRunSheet(run, checkedSuccess(run, null), { ...meta, helpers: runHelpers(run) }, env);
  } else {
    sheet = readRunSheet(run.id, env);
    if (!sheet) return { none: 'nothing' };
    const steps = essentialSteps(sheet.calls, sheet.repoKey);
    if (steps[steps.length - 1]?.failed || sheet.end === 'failure' || run.end === 'failure') return { none: 'failed' };
    if (unproven(sheet.calls, sheet.repoKey)) return { none: 'unproven' };
  }
  // A run a compaction cut (D59a): the draft and the save copy the whole job, its earlier parts first.
  return { run, sheet: joinCarriedSheet(sheet, (id) => readRunSheet(id, env)) };
}
