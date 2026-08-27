/**
 * Rolling a finished agent session up into one `session_summary` event.
 *
 * This is the event that justifies the whole exercise. Everything else here
 * counts commands; this one answers the question the product actually rests on —
 * when an agent had both graft and grep available, which did it reach for, and
 * how many tokens did that save? The counters already exist: the Claude Code
 * hooks have been writing `graftReads`, `sourceReads` and `savedTokens` per
 * session into `graft/.cache/session/` since well before telemetry did. Nothing
 * new is measured here; a closed session is simply bucketed and queued.
 *
 * "Closed" is inferred from mtime rather than observed, because there is no
 * reliable end-of-session hook — `Stop` fires per turn, and an editor that
 * crashes fires nothing at all. A session untouched for two hours is over.
 *
 * Called from the session-start hook, which is the one place guaranteed to run
 * again after a session ends. A hook must never touch the network (see the note
 * atop upkeep.ts) and this doesn't: it only appends to the local queue.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir } from '../util/state.js';
import { readSession, writeSession } from '../claude/state.js';
import { countBucket, savedTokensBucket } from './contract.js';
import { track } from './track.js';
import { telemetryOn } from './gate.js';

/** Untouched for this long and the session is treated as over. */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

/** Never roll up more than this in one hook run — a repo with a huge backlog of
 *  session files must not slow down a session start. The rest wait for the next. */
const MAX_PER_RUN = 20;

/**
 * Queue a `session_summary` for every closed, not-yet-summarised session in this
 * repo. Returns how many were queued (for tests). Never throws.
 */
export function flushClosedSessions(
  repo: string,
  now = Date.now(),
  home?: string,
  env?: NodeJS.ProcessEnv,
): number {
  try {
    if (!telemetryOn(home, env)) return 0;
    const dir = join(cacheDir(repo), 'session');
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return 0; }

    let queued = 0;
    for (const file of files.sort()) {
      if (queued >= MAX_PER_RUN) break;
      let mtime: number;
      try { mtime = statSync(join(dir, file)).mtimeMs; } catch { continue; }
      if (now - mtime < SESSION_IDLE_MS) continue;

      const id = file.slice(0, -'.json'.length);
      const s = readSession(repo, id);
      if (s.summarized) continue;

      // An empty session — opened, nothing asked — is still a fact worth having:
      // it is the difference between "graft is installed" and "graft is used".
      track(
        'session_summary',
        {
          graft_reads_bucket: countBucket(s.graftReads ?? 0),
          source_reads_bucket: countBucket(s.sourceReads ?? 0),
          saved_tokens_bucket: savedTokensBucket(s.savedTokens ?? 0),
          // Saved vs *said*: the gap between these two is value the user never
          // heard about. Only turns whose reply was actually readable are in
          // either count (claude/tally.ts), so a host that exposes no transcript
          // reports 0/0 rather than a misleading 0-out-of-many.
          graft_turns_bucket: countBucket(s.graftTurns ?? 0),
          reported_turns_bucket: countBucket(s.reportedTurns ?? 0),
        },
        { repo, host: 'claude-code', home, env },
      );
      writeSession(repo, id, { ...s, summarized: true });
      queued++;
    }
    return queued;
  } catch {
    return 0; // a session start is never worth failing over a metric
  }
}
