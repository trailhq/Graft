/**
 * What the prompt and SessionStart skills parts share: failing open with one
 * line in `state/hook-errors.log` (design 0 rule 5), telemetry sent after
 * the session lock is let go, whether the host can ask the person, the
 * session's scope, and the gate file kept in step with the live blocks.
 */
import type { Host } from '../trace/host.js';
import { readFileSync, statSync } from 'node:fs';
import { appendPrivateLine, trailPath, writePrivate } from '../util/private-fs.js';
import type { SkillSessionState } from '../trace/types.js';
import type { GateCtx } from '../trace/skill-session.js';
import { readGateFile, writeGateFile } from '../trace/gate-file.js';
import { hostFacts } from '../skills/host-facts.js';

const LOG_MAX = 100 * 1024;
const MAX_INJECTED = 20;

/** Telemetry collected inside the lock. */
export type Sent = Array<[string, Record<string, string>]>;

export function sendAll(sent: Sent, track: (event: string, props: Record<string, string>) => void): void {
  for (const [e, p] of sent) {
    try { track(e, p); } catch { /* telemetry never stops a hook */ }
  }
}

/**
 * One line per throw: the time, the hook, the error's name and where it was thrown. Never its message: a
 * message can carry the words of a prompt or a file, and nothing typed is kept (spec 11).
 */
export function hookError(hook: string, e: unknown, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const err = e instanceof Error ? e : new Error('not an Error');
    const where = (err.stack ?? '').split('\n').slice(1).map((l) => /\(?([^\s()]+:\d+):\d+\)?$/.exec(l.trim())?.[1]).find(Boolean) ?? '';
    // The file's own name only: a Windows frame's folders are joined by '\', and they would name the person.
    const file = (where.split(/[\\/]/).pop() ?? '').replace(/[^\w.:-]/g, '');
    const path = trailPath(env, 'state', 'hook-errors.log');
    appendPrivateLine(path, `${new Date().toISOString()} ${hook} ${err.name.replace(/[^\w]/g, '').slice(0, 40)}${file ? ` ${file}` : ''}`);
    if (statSync(path).size > LOG_MAX) {
      const text = readFileSync(path, 'utf8');
      const cut = text.slice(text.length - LOG_MAX);
      writePrivate(path, cut.slice(cut.indexOf('\n') + 1));
    }
  } catch {
    /* the log is best effort */
  }
}

/** 4.15 step 5: Claude Code's own prompt reaches the person. */
export function canAsk(ctx: Pick<GateCtx, 'entry' | 'host' | 'permissionMode' | 'env'>): boolean {
  return ctx.entry === 'interactive' && ctx.host === 'claude' && hostFacts(ctx.env, ctx.host as Host).askModes.includes(ctx.permissionMode ?? '');
}

export function scopeKeys(ctx: Pick<GateCtx, 'repoKey'>, st: SkillSessionState): string[] {
  return st.scopeKeys.length ? st.scopeKeys : ctx.repoKey ? [ctx.repoKey] : [];
}

/**
 * At most 20, newest last. Check lines go first (they earn nothing), then blocks that ended in an earlier epoch,
 * then any that ended, then the oldest: a block of this epoch is what keeps its skill to once per epoch, so it
 * stays the longest (a run of status questions can't push it out and bring the full block back).
 */
export function trimInjected(st: SkillSessionState): void {
  const order: Array<(x: SkillSessionState['injected'][number]) => boolean> = [
    (x) => x.cue === 'check', (x) => !x.live && x.epoch < st.epoch, (x) => !x.live,
  ];
  while (st.injected.length > MAX_INJECTED) {
    let i = -1;
    for (const f of order) if ((i = st.injected.findIndex(f)) >= 0) break;
    st.injected.splice(i >= 0 ? i : 0, 1);
  }
}

/**
 * 3.2 step 9: the gate file follows the live blocks, written only when they differ from it (this hook's
 * cue or liveness, or a compaction its catch-up folded).
 */
export function syncGate(ctx: Pick<GateCtx, 'sessionId' | 'env'>, st: SkillSessionState): void {
  const want = st.injected.filter((i) => i.live).map((i) => [i.injId, i.steps, i.params]);
  const have = (readGateFile(ctx.sessionId, ctx.env)?.live ?? []).map((l) => [l.injId, l.steps, l.params]);
  if (JSON.stringify(want) !== JSON.stringify(have)) writeGateFile(ctx.sessionId, st, ctx.env);
}
