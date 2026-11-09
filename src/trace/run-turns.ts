/**
 * Where one run ends and the next begins, beside the fold (runs.ts): the cut
 * a compaction makes (D59a), whether a run already moved on (D116 item 3),
 * and D120 (1): a typed line naming the same job as the open, not-yet-checked
 * run continues it at any length (the 25-word cap is for matching skills).
 */
import { matchJob } from './jobs.js';
import { noteRepairs, type RepairOpts } from './repairs.js';
import { checkedSuccess } from './run-verdict.js';
import type { JobMatch, RunState, SkillSessionState } from './types.js';

/** D59a: a run the compaction cut carries its job on when it had one and had not checked out (as its sheet will say). */
function carries(run: RunState): boolean {
  if (run.job === null || run.sheet === 'checked') return false;
  return !(run.calls.length > 0 && checkedSuccess(run, null).checked);
}

/**
 * Closes every open run at a compaction (4.1) and notes the one it cut mid-job (D59a): the next run the agent
 * starts with no typed ask continues that job. The fold calls it at a compaction line; SessionStart(compact)
 * calls it when it bumps the epoch before the fold meets that line. Returns the runs it closed.
 */
export function cutAtCompaction(st: SkillSessionState, fix: RepairOpts = {}): RunState[] {
  const closed: RunState[] = [];
  for (const r of st.runs) {
    if (r.closed) continue;
    r.closed = true;
    noteRepairs(r, fix); // b2: while the run still has its calls (4.12)
    closed.push(r);
  }
  const cut = closed[closed.length - 1];
  if (cut && carries(cut)) st.cut = cut.id;
  else if (cut) delete st.cut;
  return closed;
}

/**
 * D116 item 3: the run checked out and the reply then asked about more work ("Published. Want me to deploy the docs
 * too?"): a yes to that is the next job, not this one. A go-ahead after a plain reply ("ok") only acknowledges it.
 */
export function movedOn(run: RunState, replyEnd: SkillSessionState['replyEnd']): boolean {
  if (!run.calls.length || replyEnd !== 'question') return false;
  return checkedSuccess({ ...run, end: 'done' }, null).checked;
}

/**
 * D120 (1): the job a typed line over the matching cap names, when it is `open`'s own and `open` has not checked
 * out; null otherwise (a short line is matchJob's, another job or a checked run starts a new run as before).
 */
export function continuesOpenJob(text: string, open: RunState | null): JobMatch | null {
  if (!open || open.closed || open.job === null) return null;
  const m = matchJob(text, { anyLength: true });
  if (!m || m.job !== open.job) return null;
  return open.calls.length && checkedSuccess({ ...open, end: 'done' }, null).checked ? null : m;
}

/**
 * D137: an open run whose block handed a gated step to the person (denied here and printed for their own terminal)
 * waits 2 hours, past the 30-minute gap, for their next ask of the same job, which continues it.
 */
export function handedWait(run: RunState, at: string): boolean {
  const d = Date.parse(at) - Date.parse(run.handedAt ?? '');
  return d >= 0 && d <= HANDED_WAIT_MS;
}
const HANDED_WAIT_MS = 2 * 60 * 60 * 1000;
