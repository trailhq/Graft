/**
 * The tamper check as init's look-back reads it (D135 (1)). Live, 1a's mark is session-wide: the first call that
 * writes Trail's or the host's files, or runs a Trail hook script by hand, marks the session and it can never save a
 * skill. Looking back, a hook script run by hand taints only its own turn, up to the next typed line: the review
 * screen still gates every look-back item, and the 1b lab lost 16 days of runs to two sessions that once ran a hook
 * to see what it said. A write still taints the rest of the session.
 *
 * Pure but for reading the transcript. Never throws: an unreadable file reads as tampered.
 */
import { homedir } from 'node:os';
import { trailHome } from '../notes/trail-home.js';
import { lineEvents, type TraceEvent } from '../trace/claude.js';
import { isHookScriptTamper, tamperOf, type TamperCtx } from '../trace/tamper.js';
import { eachLine } from './transcript.js';

/** A mark that taints only its own turn when looking back. */
export const turnOnly = (mark: string | null): boolean => mark !== null && isHookScriptTamper(mark);

function markOf(name: string, input: unknown, cwd: unknown, ctx: TamperCtx): string | null {
  const inp = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const raw = name === 'Bash' && typeof inp.command === 'string' ? inp.command : null;
  return tamperOf(name, inp, raw, { ...ctx, folder: typeof cwd === 'string' && cwd ? cwd : ctx.folder ?? null });
}

/**
 * The first mark in a turn's events that is not turn-only: the fold keeps only the session's first mark, so a write
 * after a hook run in the same turn would otherwise be lost when the turn's mark is cleared.
 */
export function writeMarkIn(chunk: TraceEvent[], ctx: { trailHome: string; transcriptPath: string; checkout?: string }): string | null {
  const c: TamperCtx = { trailHome: ctx.trailHome, transcriptPath: ctx.transcriptPath, home: homedir(), folder: ctx.checkout || null };
  for (const ev of chunk) {
    if (ev.kind !== 'tool_call') continue;
    const m = markOf(ev.name, ev.input, ev.cwd, c);
    if (m && !turnOnly(m)) return m;
  }
  return null;
}

/**
 * Whether the session was tampered with before `to` (a run's start), as the look-back reads it: any write before it,
 * or a hook script run by hand with no typed line between it and `to` (the line at `to` included).
 */
export function tamperedBefore(path: string, to: number, env: NodeJS.ProcessEnv): boolean {
  const ctx: TamperCtx = { trailHome: trailHome(env), transcriptPath: path, home: env.HOME || homedir() };
  const memo: Record<string, unknown> = {};
  let write = false;
  let hook = false;
  try {
    eachLine(path, (line, offset) => {
      if (write) return;
      const user = line.includes('"type":"user"');
      if (!user && !line.includes('"tool_use"')) return;
      let e: { type?: string; cwd?: unknown; isSidechain?: boolean; message?: { content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (!e || typeof e !== 'object') return;
      if (e.type === 'user') {
        if (lineEvents(e as Record<string, unknown>, memo, offset, env).some((ev) => ev.kind === 'typed')) hook = false;
        return;
      }
      if (offset >= to || e.type !== 'assistant' || e.isSidechain || !Array.isArray(e.message?.content)) return;
      for (const part of e.message!.content as Array<Record<string, unknown> | null>) {
        if (!part || part.type !== 'tool_use') continue;
        const m = markOf(String(part.name ?? ''), part.input, e.cwd, ctx);
        if (!m) continue;
        if (turnOnly(m)) hook = true;
        else write = true;
      }
    }, { from: 0, to: to + 1 });
  } catch {
    return true;
  }
  return write || hook;
}
