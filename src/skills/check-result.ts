/**
 * D116 item 1: what a status question gets for a skill with no check that
 * only reads (its check is the push that moved prod). Instead of a command
 * to run, the last run's recorded result: this session's block of the skill
 * when there is one, credited from the commands that ran after it, else the
 * newest `use` line of the skill's ledger, else the day it was saved.
 *
 * The line is a directive like the others (D101, D107): Trail's opening, the
 * person's typed question quoted, the reason, and no words for the agent to
 * recite. It never names the changing step's command.
 */
import type { RunState, SkillInjection } from '../trace/types.js';
import type { Candidate } from './recall.js';
import { nameOf } from './recall.js';
import { creditCalls, creditRun, readLedger } from './ledger.js';
import { directive } from './directive-words.js';
import { dayWords } from './runblock.js';
import type { LedgerUse } from './types.js';

export interface CheckResult {
  where: 'session' | 'ledger' | 'saved';
  /** When: the use's time, or the day the skill was saved. */
  at: string | null;
  stepsRan: number[];
  failedStep: number | null;
  check: 'passed' | 'failed' | 'none';
}

/** The skill's last recorded result: this session's block of it first, else its ledger, else its save. */
export function lastResult(c: Candidate, block: SkillInjection | null, runs: RunState[], env?: NodeJS.ProcessEnv): CheckResult {
  const id = c.ref.id || c.skill.meta.trail;
  if (block && block.cue !== 'check' && block.skillId === id) {
    const cr = creditRun(block, creditCalls(block, runs, env));
    return { where: 'session', at: block.at, stepsRan: cr.stepsRan, failedStep: cr.failedStep, check: cr.check };
  }
  let use: LedgerUse | undefined;
  for (const l of readLedger(id, env)) if (l.event === 'use' && (!use || Date.parse(l.at) >= Date.parse(use.at))) use = l;
  if (use) return { where: 'ledger', at: use.at, stepsRan: use.stepsRan, failedStep: use.failedStep, check: use.check };
  return { where: 'saved', at: c.state?.addedAt ?? null, stepsRan: [], failedStep: null, check: 'none' };
}

const listWords = (ns: number[]) => (ns.length === 1 ? `step ${ns[0]}` : `steps ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

function resultWords(r: CheckResult, checkStep: number | null): string {
  const which = checkStep === null ? '' : ` (step ${checkStep})`;
  if (r.where === 'saved') return `Trail has no run of it here since it was saved on ${dayWords(r.at)}.`;
  const lead = r.where === 'session' ? 'In this session' : `Its last run here, on ${dayWords(r.at)},`;
  if (r.check === 'passed') return r.where === 'session' ? `${lead} its check passed${which}.` : `${lead} passed its check${which}.`;
  if (r.failedStep !== null) return `${lead} step ${r.failedStep} failed, so Trail can't say it went out.`;
  if (r.check === 'failed') return `${lead} its check ran and didn't pass.`;
  const ran = r.stepsRan.filter((n) => n !== checkStep);
  if (!ran.length) return `${lead} none of its steps ran, so Trail can't say it went out.`;
  const didnt = checkStep === null ? 'its check didn\'t' : `step ${checkStep} didn't`;
  return `${lead} ${listWords(ran)} ran and ${didnt}, so Trail can't say it went out; the person may have run it themselves.`;
}

/** The status question's line for a skill whose only check changes things. */
export function lastResultLine(c: Candidate, typed: unknown, r: CheckResult): string {
  const s = c.skill;
  const step = s.steps.find((x) => x.cmd === s.check)?.n ?? null;
  const what = step === null ? 'its only check changes things' : `its check is step ${step}, which changes things`;
  return directive(typed, `Skill ${nameOf(c)} has no check that only reads: ${what}, so it isn't one to run for a status question. `
    + `${resultWords(r, step)} Answer from that and what this session already shows; don't run its steps to find out.`);
}
