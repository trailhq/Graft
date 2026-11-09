/**
 * The small files the PreToolUse fast path reads while a skill's run block is
 * live, kept beside phase 0's session state in `<trail home>/sessions/`:
 *
 *  - `<id>.gate.json`: the live run blocks' gated steps (a publish, a push to
 *    prod, a deploy, ...), grouped so one ask of the person covers a run of
 *    consecutive steps of one kind, and which asks were made and approved.
 *    It exists only while something is live.
 *  - `<id>.post.jsonl`: outcomes PostToolUse and PostToolUseFailure saw
 *    before the transcript had them, one line each, taken by the next
 *    catch-up. The transcript's result always wins when it arrives.
 *
 * An approval is the asked call's own PostToolUse: the person said yes and
 * the command ran. A failed asked call (PostToolUseFailure) never approves,
 * because a refused ask may arrive the same way.
 *
 * Every shell command passes through PreToolUse, so this file stays light:
 * static imports are node:path, node:os and the shell lexer; node:fs and
 * node:crypto come from `process.getBuiltinModule`, as pre-bash.ts does.
 * Writes are tmp-and-rename (or one O_APPEND write) at 0600 in a 0700 folder.
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type * as Fs from 'node:fs';
import type * as Crypto from 'node:crypto';
import { programOf } from './shell.js';
import type { GatedKind, SkillSessionState } from './types.js';

export interface GateGroup {
  kind: GatedKind;
  steps: Array<{ n: number; text: string; program: string | null }>;
  askedAt: string | null;
  askedToolUseId: string | null;
  approvedAt: string | null;    // the asked call's PostToolUse fired: the person said yes and it ran
  /** g7: the step the ask was for; a later step of the group is what that yes covers (3.3). */
  askedStep?: number | null;
}
export interface GateFile {
  v: 1;
  epoch: number;
  live: Array<{ injId: string; name: string; skillId: string; params: Record<string, string>;
                steps: string[]; check: string | null; groups: GateGroup[];
                /** D137: gated steps this session couldn't ask for, denied and handed to the person to run themselves. */
                handed?: Handed[] }>;
}
/** D137: a gated step handed to the person (denied and printed), and when. */
export interface Handed { n: number; at: string }
/** A result the hook saw before the transcript had it (3.4). tail: cleanLine of the last 200 chars, check-family calls only. */
export interface PostMark { id: string; at: string; failed: boolean; tail?: string }

/** A gate file bigger than this is not read: the fast path never parses much. */
const MAX_GATE_BYTES = 16 * 1024;
const MAX_TAIL = 200;
const MAX_MARKS = 2000;

const fs = (): typeof Fs => process.getBuiltinModule('node:fs') as typeof Fs;
const crypto = (): typeof Crypto => process.getBuiltinModule('node:crypto') as typeof Crypto;

/** The same answer as notes/home.ts trailHome(env); a test holds them equal. */
export function trailHomeFast(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAIL_HOME ? resolve(env.TRAIL_HOME) : join(homedir(), '.trail');
}

/** A session id as a file name, as phase 0's state.ts does it (a test holds them equal). */
function fileId(sessionId: string): string {
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return sessionId;
  return `h-${crypto().createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)}`;
}

/** `<home>/sessions/<id><suffix>`: the session's files (`.json`, `.gate.json`, `.post.jsonl`). */
export function sessionPath(sessionId: string, suffix: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHomeFast(env), 'sessions', `${fileId(String(sessionId))}${suffix}`);
}

export function gateFilePath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return sessionPath(sessionId, '.gate.json', env);
}

function postPath(sessionId: string, env: NodeJS.ProcessEnv): string {
  return sessionPath(sessionId, '.post.jsonl', env);
}

/**
 * A folder only its owner can open, made if missing and tightened if it was looser. A link is left alone: a chmod
 * would follow it and tighten what it points to. The mode is set through a descriptor that refuses a link (as
 * state.ts ensurePrivateDir, kept here so this file loads only node:path and node:os).
 */
function privateDir(dir: string): void {
  const f = fs();
  try {
    if (f.lstatSync(dir).isSymbolicLink()) return;
  } catch { /* missing: made below */ }
  f.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const k = f.constants;
  if (process.platform === 'win32' || k.O_NOFOLLOW === undefined) return;
  try {
    const fd = f.openSync(dir, k.O_RDONLY | (k.O_DIRECTORY ?? 0) | k.O_NOFOLLOW);
    try { f.fchmodSync(fd, 0o700); } finally { f.closeSync(fd); }
  } catch (e) {
    // A folder its owner can't read can't be opened, but can still be tightened.
    if ((e as NodeJS.ErrnoException).code !== 'EACCES') return;
    try { if (!f.lstatSync(dir).isSymbolicLink()) f.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  }
}

/** tmp file + rename at 0600. */
function writeWhole(path: string, data: string): void {
  const f = fs();
  privateDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    const fd = f.openSync(tmp, 'wx', 0o600);
    try {
      f.fchmodSync(fd, 0o600);
      f.writeSync(fd, data);
    } finally {
      f.closeSync(fd);
    }
    f.renameSync(tmp, path);
  } catch (e) {
    try { f.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw e;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown) => v === null || typeof v === 'string';

function validGroup(g: unknown): g is GateGroup {
  if (!g || typeof g !== 'object') return false;
  const x = g as GateGroup;
  return isStr(x.kind) && Array.isArray(x.steps) && x.steps.every((s) => s && typeof s.n === 'number' && isStr(s.text))
    && strOrNull(x.askedAt) && strOrNull(x.askedToolUseId) && strOrNull(x.approvedAt);
}

function validGate(v: unknown): v is GateFile {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const g = v as GateFile;
  if (g.v !== 1 || typeof g.epoch !== 'number' || !Array.isArray(g.live)) return false;
  return g.live.every((l) => l && isStr(l.injId) && isStr(l.name) && Array.isArray(l.steps) && Array.isArray(l.groups) && l.groups.every(validGroup));
}

/** No lock; a file over 16 KB or bad JSON reads as null. */
export function readGateFile(sessionId: string, env: NodeJS.ProcessEnv = process.env): GateFile | null {
  try {
    const f = fs();
    const path = gateFilePath(sessionId, env);
    const st = f.statSync(path);
    if (!st.isFile() || st.size > MAX_GATE_BYTES) return null;
    const v: unknown = JSON.parse(f.readFileSync(path, 'utf8'));
    return validGate(v) ? v : null;
  } catch {
    return null;
  }
}

/** Gated steps, consecutive ones of one kind together (one ask covers a group). */
function groupsOf(steps: string[], gated: Array<{ step: number; kind: GatedKind }>): GateGroup[] {
  const sorted = [...gated].filter((g) => g.step >= 1 && g.step <= steps.length).sort((a, b) => a.step - b.step);
  const out: GateGroup[] = [];
  for (const g of sorted) {
    const text = steps[g.step - 1]!;
    const step = { n: g.step, text, program: programOf(text) };
    const last = out[out.length - 1];
    const prev = last?.steps[last.steps.length - 1];
    if (last && prev && last.kind === g.kind && prev.n === g.step - 1) last.steps.push(step);
    else out.push({ kind: g.kind, steps: [step], askedAt: null, askedToolUseId: null, approvedAt: null });
  }
  return out;
}

const sameSteps = (a: GateGroup, b: GateGroup) =>
  a.kind === b.kind && a.steps.length === b.steps.length && a.steps.every((s, i) => s.n === b.steps[i]!.n && s.text === b.steps[i]!.text);

/** Rewrites `live` from st.injected (live ones), keeping asked/approved marks of injections that stay. Deletes the file when nothing is live. */
export function writeGateFile(sessionId: string, st: SkillSessionState, env: NodeJS.ProcessEnv = process.env): void {
  const path = gateFilePath(sessionId, env);
  const old = readGateFile(sessionId, env);
  const live: GateFile['live'] = st.injected.filter((i) => i.live).map((inj) => {
    const before = old?.live.find((l) => l.injId === inj.injId);
    const groups = groupsOf(inj.steps, inj.gated).map((g) => {
      const kept = before?.groups.find((b) => sameSteps(b, g));
      return kept ? { ...g, askedAt: kept.askedAt, askedToolUseId: kept.askedToolUseId, approvedAt: kept.approvedAt, askedStep: kept.askedStep ?? null } : g;
    });
    const handed = before?.steps.join('\n') === inj.steps.join('\n') ? validHanded(before?.handed) : [];
    return { injId: inj.injId, name: inj.name, skillId: inj.skillId, params: inj.params, steps: inj.steps, check: inj.check, groups, ...(handed.length ? { handed } : {}) };
  });
  if (!live.length) {
    try { fs().rmSync(path, { force: true }); } catch { /* gone already */ }
    return;
  }
  // Over the cap the file would read as nothing: keep the newest blocks that fit.
  let file: GateFile = { v: 1, epoch: st.epoch, live };
  let text = JSON.stringify(file);
  while (Buffer.byteLength(text) > MAX_GATE_BYTES && file.live.length > 1) {
    file = { ...file, live: file.live.slice(1) };
    text = JSON.stringify(file);
  }
  writeWhole(path, text);
}

function rewrite(sessionId: string, env: NodeJS.ProcessEnv, change: (g: GateFile) => boolean): boolean {
  const g = readGateFile(sessionId, env);
  if (!g || !change(g)) return false;
  writeWhole(gateFilePath(sessionId, env), JSON.stringify(g));
  return true;
}

export function markAsked(sessionId: string, injId: string, group: number, toolUseId: string, now: Date, env: NodeJS.ProcessEnv = process.env, step?: number): void {
  rewrite(sessionId, env, (g) => {
    const target = g.live.find((l) => l.injId === injId)?.groups[group];
    if (!target) return false;
    target.askedAt = now.toISOString();
    target.askedToolUseId = toolUseId;
    target.approvedAt = null;
    target.askedStep = typeof step === 'number' ? step : null;
    return true;
  });
}

const MAX_HANDED = 8;
const validHanded = (v: unknown): Handed[] =>
  (Array.isArray(v) ? v : []).filter((h): h is Handed => !!h && typeof h.n === 'number' && Number.isInteger(h.n) && h.n >= 1 && isStr(h.at)).slice(-MAX_HANDED);

/** D137: the gated step `step` of block `injId` was denied and printed for the person to run (no ask possible here). */
export function markHanded(sessionId: string, injId: string, step: number, now: Date, env: NodeJS.ProcessEnv = process.env): void {
  rewrite(sessionId, env, (g) => {
    const l = g.live.find((x) => x.injId === injId);
    if (!l || !Number.isInteger(step) || step < 1 || step > l.steps.length) return false;
    l.handed = [...validHanded(l.handed).filter((h) => h.n !== step), { n: step, at: now.toISOString() }].slice(-MAX_HANDED);
    return true;
  });
}

/** D137: every handed step the gate file holds, by block. */
export function readHanded(sessionId: string, env: NodeJS.ProcessEnv = process.env): Array<Handed & { injId: string }> {
  const g = readGateFile(sessionId, env);
  return g ? g.live.flatMap((l) => validHanded(l.handed).map((h) => ({ ...h, injId: l.injId }))) : [];
}

/** true when toolUseId was an asked call (sets approvedAt). PostToolUse only: a failed asked call (PostToolUseFailure) never
 *  approves its group, because a refused ask may arrive the same way; the next step in the group asks again (3.3). */
export function markApproved(sessionId: string, toolUseId: string, now: Date, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!toolUseId) return false;
  return rewrite(sessionId, env, (g) => {
    let hit = false;
    for (const l of g.live) for (const grp of l.groups) {
      if (grp.askedToolUseId === toolUseId) { grp.approvedAt = now.toISOString(); hit = true; }
    }
    return hit;
  });
}

/**
 * `<home>/sessions/<id>.post.jsonl`, one O_APPEND write at 0600. Opened without blocking and written only when it
 * is a regular file: a FIFO planted at the path would otherwise hold PostToolUse until its timeout (D100 18). A FIFO
 * or anything else that isn't a regular file is skipped, and the mark is lost (the fold reads the call anyway).
 */
export function appendPostMark(sessionId: string, mark: PostMark, env: NodeJS.ProcessEnv = process.env): void {
  const f = fs();
  const path = postPath(sessionId, env);
  const clean: PostMark = { id: String(mark.id), at: String(mark.at), failed: mark.failed === true };
  if (typeof mark.tail === 'string') clean.tail = mark.tail.slice(-MAX_TAIL);
  privateDir(dirname(path));
  // Never through a symlink: one planted at this path would have the hook append to, and chmod, its target.
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = f.constants;
  let fd: number;
  try {
    fd = f.openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | (O_NONBLOCK ?? 0), 0o600);
  } catch (e) {
    // A FIFO with no reader refuses a non-blocking open for writing.
    if ((e as NodeJS.ErrnoException).code === 'ENXIO') return;
    throw e;
  }
  try {
    if (!f.fstatSync(fd).isFile()) return;
    f.fchmodSync(fd, 0o600);
    f.writeSync(fd, `${JSON.stringify(clean)}\n`);
  } finally {
    f.closeSync(fd);
  }
}

function asMark(v: unknown): PostMark | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (!isStr(m.id) || !m.id || !isStr(m.at) || typeof m.failed !== 'boolean') return null;
  return isStr(m.tail) ? { id: m.id, at: m.at, failed: m.failed, tail: m.tail.slice(-MAX_TAIL) } : { id: m.id, at: m.at, failed: m.failed };
}

/** Read and truncate: the file is moved aside first, so a mark appended meanwhile waits for the next take. */
export function takePostMarks(sessionId: string, env: NodeJS.ProcessEnv = process.env): PostMark[] {
  const f = fs();
  const path = postPath(sessionId, env);
  const aside = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.take`;
  try {
    f.renameSync(path, aside);
  } catch {
    return [];
  }
  try {
    const out: PostMark[] = [];
    for (const line of f.readFileSync(aside, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = asMark(JSON.parse(line));
        if (m) out.push(m);
      } catch { /* a broken line is skipped */ }
    }
    return out.slice(-MAX_MARKS);
  } catch {
    return [];
  } finally {
    try { f.rmSync(aside, { force: true }); } catch { /* nothing more to do */ }
  }
}

/** Skills on, read from settings.json with fs only: on unless it says `skills: 'off'`, as `readSettings` reads it. */
export function skillsOnFast(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const v: unknown = JSON.parse(fs().readFileSync(join(trailHomeFast(env), 'settings.json'), 'utf8'));
    return !(!!v && typeof v === 'object' && !Array.isArray(v) && (v as { skills?: unknown }).skills === 'off');
  } catch {
    return true;
  }
}
