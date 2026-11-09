/**
 * A run a compaction cut carries its job into the next run (D59a), so the
 * carried run's sheet holds only the calls after the compaction; the job's
 * first part is on the sheet `carriedFrom` names, which may itself be
 * carried. `joinCarriedSheet` puts the parts back together, oldest first,
 * so compile and "save this" see the whole job. Re-exported from `runs.ts`.
 *
 * A part that can't be read (pruned after 7 days, or never written because
 * it had no step call) means there is nothing more to copy: the walk keeps
 * what it found, it never refuses.
 */
import { readRunSheet } from './run-sheets.js';
import type { RunCall, RunSheet } from './types.js';

/** At most this many sheets back. Real jobs were cut 2 to 4 times. */
export const MAX_CARRY_HOPS = 5;

/** The key most of the calls' steps ran in; a tie or none keeps `fallback`. */
export function majorityKey(run: { calls: RunCall[] }, fallback: string): string {
  const count = new Map<string, number>();
  for (const c of run.calls) if (c.kind === 'step' && c.key) count.set(c.key, (count.get(c.key) ?? 0) + 1);
  let best = fallback;
  let top = 0;
  let tie = false;
  for (const [k, n] of count) {
    if (n > top) { best = k; top = n; tie = false; } else if (n === top) tie = true;
  }
  return top === 0 || tie ? fallback : best;
}

const time = (iso: string) => Date.parse(iso);

/**
 * `prev` is the part before `next`: the same session and job, the epoch before (or the same one, when
 * SessionStart closed the run before the fold met the compaction line), and it ended before `next` began.
 */
function links(prev: RunSheet, next: RunSheet): boolean {
  if (prev.session !== next.session || prev.job !== next.job) return false;
  if (prev.epoch !== next.epoch - 1 && prev.epoch !== next.epoch) return false;
  return time(prev.endedAt) <= time(next.startedAt);
}

const union = (lists: string[][]) => [...new Set(lists.flat())];

/**
 * The whole job of a carried sheet: follow `carriedFrom` back at most `MAX_CARRY_HOPS` sheets, stop at a sheet
 * that can't be read or a link that doesn't hold, and join the parts oldest first. Calls are concatenated, so
 * `checkIndex` moves by the calls before the newest part. The verdict, the job and its words, the params and the
 * skill come from the newest part (the carry copies them forward, follow-ups only add to them). `branch` is the
 * first one any part saw, `startedAt` the oldest part's, `endedAt` the newest's; counts are summed, helpers and
 * shared words joined; the repo key is the one most joined steps ran in (a tie keeps the newest part's).
 * The result has no `carriedFrom` and lists the earlier parts (and their call counts) in `joined`, so joining it
 * again changes nothing.
 * A sheet with nothing to join is returned as it is.
 */
export function joinCarriedSheet(sheet: RunSheet, read: (id: string) => RunSheet | null = (id) => readRunSheet(id)): RunSheet {
  if (!sheet.carriedFrom || sheet.joined) return sheet;
  const parts: RunSheet[] = [sheet];
  for (let hop = 0; hop < MAX_CARRY_HOPS; hop++) {
    const next = parts[0]!;
    if (!next.carriedFrom) break;
    let prev: RunSheet | null;
    try {
      prev = read(next.carriedFrom);
    } catch {
      prev = null;
    }
    if (!prev || prev.id !== next.carriedFrom || parts.some((p) => p.id === prev!.id) || !links(prev, next)) break;
    parts.unshift(prev);
  }
  if (parts.length === 1) return sheet;

  const calls = parts.flatMap((p) => p.calls.map((c) => ({ ...c })));
  const before = calls.length - sheet.calls.length;
  const sum = (k: keyof RunSheet['counts']) => parts.reduce((n, p) => n + (p.counts?.[k] ?? 0), 0);
  const { carriedFrom: _carried, ...newest } = sheet;
  return {
    ...newest,
    repoKey: majorityKey({ calls }, sheet.repoKey),
    branch: parts.find((p) => p.branch)?.branch ?? null,
    startedAt: parts[0]!.startedAt,
    jobWords: [...sheet.jobWords],
    sharedWords: union(parts.map((p) => p.sharedWords ?? [])),
    promptParams: { ...sheet.promptParams },
    calls,
    checkIndex: sheet.checkIndex === null ? null : sheet.checkIndex + before,
    counts: { commands: sum('commands'), failed: sum('failed'), toolCalls: sum('toolCalls'), edits: sum('edits') },
    helpers: union(parts.map((p) => p.helpers ?? [])),
    joined: parts.slice(0, -1).map((p) => ({ id: p.id, calls: p.calls.length })),
  };
}
