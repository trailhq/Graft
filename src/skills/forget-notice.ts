/**
 * D117 (2): `trail forget` stays open to agents (1a: turning things off is open
 * to anyone; the harm is bounded, it only removes). So the person still hears
 * of it: when an agent runs it, the CLI notes what was dropped and how to bring
 * it back in `~/.trail/state/forgot.jsonl`, and the next Stop, in any session,
 * tells the person once, in one line. A Stop that already blocks (an offer), or
 * a turn a block continued, leaves it for the next one.
 *
 * The person's own forget at their terminal (or from their own script) notes
 * nothing: they know what they did. Never "memory", no em dashes.
 */
import type { Host } from '../trace/host.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { flatLine } from '../notes/flatten.js';
import { appendPrivateLine, trailPath } from '../util/private-fs.js';
import { FROM_TRAIL } from './directive-words.js';
import type { HookOut } from './types.js';
import { hostFacts } from './host-facts.js';
import { trailNow } from './settings.js';

export type DroppedKind = 'skill' | 'lesson' | 'learning' | 'guardrail';
export interface Dropped { at: string; what: DroppedKind; name: string; back: string }

const KINDS: ReadonlySet<string> = new Set(['skill', 'lesson', 'learning', 'guardrail']);
/** A note older than a day is dropped unsaid: the person has moved on, and a stale line would only confuse. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SHOWN = 3;
/** The file is never read past this, and no note is added once it is this big. */
const MAX_BYTES = 16 * 1024;

export const forgotPath = (env: NodeJS.ProcessEnv): string => trailPath(env, 'state', 'forgot.jsonl');

/** The CLI half: an agent's forget that worked. Never throws (the forget itself already happened). */
export function noteAgentForget(d: Omit<Dropped, 'at'>, env: NodeJS.ProcessEnv, now: Date): void {
  try {
    const path = forgotPath(env);
    try {
      if (lstatSync(path).size >= MAX_BYTES) return;
    } catch { /* not there yet */ }
    const entry: Dropped = { at: now.toISOString(), what: d.what, name: flatLine(d.name, 60), back: flatLine(d.back, 200) };
    appendPrivateLine(path, JSON.stringify(entry));
  } catch { /* the line is a courtesy; the forget stands */ }
}

function valid(v: unknown, now: Date): v is Dropped {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  if (typeof d.what !== 'string' || !KINDS.has(d.what) || typeof d.name !== 'string' || !d.name || typeof d.back !== 'string' || !d.back) return false;
  const t = typeof d.at === 'string' ? Date.parse(d.at) : Number.NaN;
  return Number.isFinite(t) && now.getTime() - t <= MAX_AGE_MS && t - now.getTime() <= 60_000;
}

/** Reads at most MAX_BYTES of a regular file, never through a link or into a FIFO. */
function readSmall(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_BYTES);
    const n = readSync(fd, buf, 0, MAX_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The Stop half: the notes, taken once. The file is renamed first, so two Stops at the same instant can't both say
 * it; a link in its place is removed, never followed.
 */
export function takeForgets(env: NodeJS.ProcessEnv, now: Date): Dropped[] {
  const path = forgotPath(env);
  try {
    if (lstatSync(path).isSymbolicLink()) {
      rmSync(path, { force: true });
      return [];
    }
  } catch {
    return [];
  }
  const claimed = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.taken`;
  try {
    renameSync(path, claimed);
  } catch {
    return [];
  }
  const text = readSmall(claimed);
  try { rmSync(claimed, { force: true }); } catch { /* left for housekeeping */ }
  if (text === null) return [];
  const out: Dropped[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (valid(v, now)) out.push(v);
    } catch { /* a broken line */ }
  }
  return out;
}

const WHAT: Record<DroppedKind, string> = { skill: 'the skill', lesson: 'the learning', learning: 'the learning', guardrail: 'the always-follow learning' };

/** One line for the person: `trail: an agent ran trail forget: the skill x (bring it back: ...); ...`. */
export function forgetLine(ds: Dropped[]): string {
  const shown = ds.slice(-MAX_SHOWN).map((d) => `${WHAT[d.what] ?? 'the item'} ${flatLine(d.name, 60)} (bring it back: ${flatLine(d.back, 200)})`);
  const more = ds.length > MAX_SHOWN ? ` and ${ds.length - MAX_SHOWN} more` : '';
  return flatLine(`trail: an agent ran trail forget: ${shown.join('; ')}${more}`, 900);
}

/**
 * The Stop's answer with the notes added: a notice where the host shows one (joined to the skills part's), else a
 * block whose reason asks the agent to tell the person once. `out` is the skills part's answer; a block there, or a
 * continued turn, leaves the notes for the next Stop.
 */
export function withForgetNotice(out: HookOut, opts: { env: NodeJS.ProcessEnv; now: Date; active: boolean; stopNotice: boolean }): HookOut {
  if (out.block || opts.active) return out;
  const ds = takeForgets(opts.env, opts.now);
  if (!ds.length) return out;
  const line = forgetLine(ds);
  if (opts.stopNotice) return { ...out, notice: out.notice ? `${out.notice}\n${line}` : line };
  const block = `[trail] ${FROM_TRAIL} An agent ran trail forget, which only removes, so Trail tells the person what went and how to bring it back. `
    + `So they know, tell them once: "${line.replace(/^trail: /, '').replace(/"/g, "'")}"`;
  return { block };
}

/** The Stop handler's call (skills on or off): Trail's clock and the host's facts for this env. */
export function forgetNoticeAtStop(out: HookOut, env: NodeJS.ProcessEnv, host?: Host): HookOut {
  return withForgetNotice(out, { env, now: trailNow(env), active: false, stopNotice: hostFacts(env, host).stopNotice });
}
