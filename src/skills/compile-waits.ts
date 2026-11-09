/**
 * 4.5 step 5, split from compile.ts: which calls of a run fold into one wait
 * (the same command polled until it read differently), and which earlier
 * polls each wait swallows.
 */
import type { RunCall, RunSheet } from '../trace/types.js';
import { normalizeCommand } from '../trace/shell.js';
import { READ_ONLY_FAMILIES, checkFamilyOf } from '../trace/checks.js';

const LEADING_SLEEP = /^\s*sleep\s+\d+(?:\.\d+)?[smh]?\s*(?:;|&&)/;
const SLEEP_ONLY = /^\s*sleep\s+\d+(?:\.\d+)?[smh]?\s*$/;

/** 4.5 step 5: which calls fold into a wait, and which earlier polls they swallow. */
export function findWaits(calls: RunCall[], ci: number | null, job: RunSheet['job']): Map<number, { token: string | null; polls: number[] }> {
  const key = calls.map((c) => (c.cmd === null || c.cwd === null ? null : `${c.cwd}\u0000${normalizeCommand(c.cmd)}`));
  const steps = [0];
  for (const c of calls) steps.push(steps[steps.length - 1]! + (c.kind === 'step' ? 1 : 0));
  const link = calls.map(() => -1);
  const last = new Map<string, number>();
  key.forEach((k, i) => {
    if (k === null) return;
    const j = last.get(k);
    // Adjacent: only looks, plumbing and work of other commands in between.
    if (j !== undefined && steps[i]! - steps[j + 1]! === 0) link[i] = j;
    last.set(k, i);
  });
  const isPrev = new Set(link.filter((j) => j >= 0));
  const out = new Map<number, { token: string | null; polls: number[] }>();
  for (let L = 0; L < calls.length; L++) {
    if (link[L]! < 0 || isPrev.has(L)) continue;
    const group: number[] = [];
    for (let g = L; g >= 0; g = link[g]!) group.unshift(g);
    const lastCall = calls[L]!;
    const earlier = group.slice(0, -1);
    if (lastCall.failed) continue;
    if (!earlier.every((e) => calls[e]!.failed || (calls[e]!.tail ?? '') !== (lastCall.tail ?? ''))) continue;
    const fam = checkFamilyOf(lastCall.cmd!, job);
    let poll = false;
    if (lastCall.kind === 'look') poll = fam !== null && READ_ONLY_FAMILIES.has(fam);
    else if (lastCall.kind === 'step') {
      // A step that ran again is a retry unless the run was polling: a leading sleep, or a sleep call in between.
      const between = calls.slice(group[0]! + 1, L).some((c) => c.cmd !== null && SLEEP_ONLY.test(c.cmd));
      poll = between || group.slice(1).some((g) => LEADING_SLEEP.test(calls[g]!.cmd ?? ''));
    }
    if (!poll) continue;
    const t = (lastCall.tail ?? '').trim();
    out.set(L, { token: L === ci ? null : /^[\w.-]{1,24}$/.test(t) ? t : null, polls: earlier });
  }
  return out;
}
