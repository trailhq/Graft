/**
 * Phase 2's facts at the credit flush (design 4.1, P2, P3): next-run
 * fidelity of one use, as the use line keeps it (counts, the 8-hex keys of
 * passing steps the skill lacks, the steps that failed and were done another
 * way), and the one `where` every flush computes its keys with, so the same
 * extra step in two uses gives the same key (c1's R10 note). `replan`
 * (update-gate.ts) builds its fidelity with the same `fidelityWhere`.
 *
 * Fidelity never changes the use's outcome or the skill's status (P3), and a
 * throw writes the use line without it.
 */
import { homedir } from 'node:os';
import type { RunSheet, SkillInjection } from '../trace/types.js';
import type { LedgerUseFacts, ParsedSkill } from './types.js';
import { fidelityCounts, fidelityOf, type FidelityWhere } from './fidelity.js';
import { runCheckout } from './run-checkout.js';

/** The repo, the run's own checkout (D93) and the home, for fidelity and its keys. */
export function fidelityWhere(sheet: Pick<RunSheet, 'repoKey' | 'checkout'>, env: NodeJS.ProcessEnv = process.env): FidelityWhere {
  const root = runCheckout(sheet, env, '');
  return { repoKey: sheet.repoKey, ...(root ? { repoRoot: root } : {}), home: env.HOME || homedir() };
}

/** 4.1 step 5: the use line's `fid`, `extraShas` (first 4) and `changedSteps` (first 4). {} when the skill can't be read. */
export function useFacts(skill: ParsedSkill | null, inj: SkillInjection, sheet: Pick<RunSheet, 'repoKey' | 'checkout' | 'calls'>,
  env: NodeJS.ProcessEnv = process.env): LedgerUseFacts {
  if (!skill) return {};
  try {
    const f = fidelityOf(skill, inj, sheet.calls, fidelityWhere(sheet, env));
    return { fid: fidelityCounts(f), extraShas: f.extra.map((e) => e.sha).slice(0, 4), changedSteps: f.changed.map((c) => c.step).slice(0, 4) };
  } catch {
    return {};
  }
}
