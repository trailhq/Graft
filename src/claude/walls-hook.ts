/**
 * The wall catalog and the sure-fail guardrail wired into the hooks (design
 * 3.1 step 9, 3.4, 3.5 steps 1, 2 and 5): the fix text a failed command gets
 * as context, the hits, repairs and lessons that worked Stop writes to
 * `walls.json` in one locked write, the guardrail's deny and avoided counts
 * Stop reads from `sessions/<id>.denied.jsonl`, and the wall fixes a
 * compaction brings back.
 *
 * Nothing here reads or writes a command's output text: a hit is a class
 * name (`RunCall.wall`), a repair its delta kinds and names, a deny a sha.
 * Every part fails open (0 rule 9).
 */
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { RunCall, RunState, SkillSessionState, WallClass } from '../trace/types.js';
import type { GateCtx } from '../trace/skill-session.js';
import { matchWall, sshRemoteFor, wallFixText, lastTimeText, type WallCtx } from '../trace/walls.js';
import { lessonWorkedEpochs, noteWalls, programKey, readWalls, type WallsFile } from '../trace/wall-state.js';
import { FIXED_DIRS, pathDirs, programFiles } from '../trace/guard-fast.js';
import { sessionPath } from '../trace/gate-file.js';
import { ignoredFailure, detectRepairs } from '../trace/repairs.js';
import { normalizeCommand, relativizePaths, stripTimeout } from '../trace/shell.js';
import { wallProgram } from '../init/miners.js';
import { gitOf } from '../skills/anchors-git.js';
import { wallLessons } from '../skills/lessons.js';
import { localDate } from '../skills/settings.js';
import type { Sent } from './skills-hook-util.js';
import type { Host } from '../trace/host.js';
import { hostFacts } from '../skills/host-facts.js';

/** How long after a deny a passing call of the same command counts as the deny avoided (3.5 step 5). */
export const AVOIDED_MS = 30 * 60 * 1000;
/** At most this many wall fixes after a compaction (3.1 step 9, R38). */
export const COMPACT_FIXES = 2;
const MAX_DENIED_LINES = 64;

/**
 * An executable `program` in the hook's PATH or 4.11's fixed folders (the hook's PATH can be narrower than the shell's).
 * On Windows PATH splits on ';', the program is git.exe or npm.cmd (PATHEXT), and any regular file counts: there is no exec bit.
 */
export function onPathHere(program: string, env: NodeJS.ProcessEnv): boolean {
  if (!/^[\w.+-]{1,40}$/.test(program)) return false;
  const home = env.HOME || homedir();
  let user = env.USER || env.LOGNAME || '';
  if (!user) try { user = userInfo().username; } catch { /* none */ }
  const dirs = pathDirs(env);
  for (const d of FIXED_DIRS) {
    if (d.startsWith('$HOME')) dirs.push(join(home, d.slice('$HOME'.length)));
    else if (d.includes('$USER')) { if (/^[\w.-]{1,64}$/.test(user) && user !== '.' && user !== '..') dirs.push(d.replace('$USER', user)); }
    else dirs.push(d);
  }
  const names = programFiles(program, env);
  const win = process.platform === 'win32';
  return [...new Set(dirs)].some((d) => names.some((n) => {
    try {
      const p = join(d, n);
      if (!statSync(p).isFile()) return false;
      if (!win) accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

/** The facts a fix line may use: which programs are here, and origin's SSH address when it is https (checked by sshRemoteFor). */
export function wallCtxFor(checkout: string, env: NodeJS.ProcessEnv): WallCtx {
  let remote: string | null = null;
  const ssh = () => {
    if (remote !== null) return remote || null;
    try { remote = sshRemoteFor(gitOf(checkout)?.remotes.get('origin') ?? '') ?? ''; } catch { remote = ''; }
    return remote || null;
  };
  return {
    hasProgram: (p: string) => onPathHere(p, env),
    get remoteSsh() { return ssh(); },
  };
}

/** The days a lesson worked on, from walls.json. */
function workedDays(w: WallsFile, cls: WallClass, lessonId: string): string[] {
  return (w.classes[cls]?.lessons[lessonId]?.worked ?? []).map((x) => x.d);
}

/**
 * 3.4 step 1: the fix line for `cls`, then "what fixed this here before" when a kept lesson for the wall applies
 * here and worked in 2 or more epochs (4.10). `hadLesson`: a live lesson for this wall applies here.
 */
export function wallContextText(cls: WallClass, place: { checkout: string; repoKey: string; env: NodeJS.ProcessEnv; now: Date }): { text: string; hadLesson: boolean } {
  const fix = wallFixText(cls, wallCtxFor(place.checkout, place.env));
  let lessons: ReturnType<typeof wallLessons> = [];
  try { lessons = wallLessons(cls, place.repoKey, place.env); } catch { /* none */ }
  let last = '';
  if (lessons.length) {
    try {
      const w = readWalls(place.env);
      const best = [...lessons].reverse().find((l) => lessonWorkedEpochs(w, cls, l.id, place.now) >= 2);
      if (best) last = lastTimeText(best.text, workedDays(w, cls, best.id).filter((d) => d <= localDate(place.now)));
    } catch { /* the fix alone */ }
  }
  return { text: [fix, last].filter(Boolean).join('\n'), hadLesson: lessons.length > 0 };
}

/** 3.4 step 1 on a hook payload: the class the result hits, or null. Exit 0 under P23's limits (matchWall's own). */
export function wallOfResult(result: string, command: string, failed: boolean): WallClass | null {
  return matchWall(result, command, failed);
}

/** The program a hit or repair is put down to: one word, as walls.json keys it (D98). */
const keyOf = (cls: WallClass, cmd: string | null) => programKey(wallProgram(cls, cmd)) || 'shell';

/** A run's wall hits that count: not a flake retried as is, not a dropped tail (b2: `ignoredFailure(call, next)`). */
export function countedHits(run: RunState): RunCall[] {
  const calls = run.calls;
  return calls.filter((c, i) => c.wall && !ignoredFailure(c, calls[i + 1] ?? null));
}

/** `timeout [-s SIG] [-k 5] [--foreground] 60 npm test` without its timeout part: `npm test`; null when there is none. */
export function withoutTimeout(cmd: string | null): string | null {
  const m = cmd ? /^\s*(?:\S*\/)?timeout(?:\s+(?:-[sk]\s+\S+|-(?![sk]\s)\S+))*\s+\d[\d.]*[smhd]?\s+(\S.*)$/s.exec(cmd) : null;
  return m ? m[1]! : null;
}

/** A lesson's delta texts: its text after the wall's fixed words, split where repairLessonText joined them. */
function deltaParts(text: string): string[] {
  const at = text.indexOf(': ');
  const rest = at >= 0 ? text.slice(at + 2) : text;
  return rest.split(', then ').map((t) => t.trim()).filter(Boolean);
}

/**
 * 3.5 steps 1 and 2 (`learn`): this session's wall hits (`seen`), repairs (`fixed`, an open run's read from its calls
 * now) and the kept lessons that worked again, in one locked write of walls.json, only when something is new.
 * Phase 2 (D129): returns how many new wall hits this Stop recorded whose fix reached the model: a failed call's where
 * the host reads PostToolUseFailure's context (Codex has none), any other's where it reads PostToolUse's.
 */
export function wallsAtStop(st: SkillSessionState, ctx: GateCtx): number {
  const home = ctx.env.HOME || homedir();
  const sh = ctx.sessionHash;
  const seen: NonNullable<Parameters<typeof noteWalls>[0]['seen']> = [];
  const reached = new WeakSet<object>();
  const facts = hostFacts(ctx.env, ctx.host as Host);
  const fixReached = (failed: boolean) => (failed && ctx.host !== 'codex' ? facts.failureContext : facts.postToolContext);
  const fixed: NonNullable<Parameters<typeof noteWalls>[0]['fixed']> = [];
  const worked: NonNullable<Parameters<typeof noteWalls>[0]['worked']> = [];
  for (const run of st.runs) {
    if (!run.repoKey) continue;
    const hits = countedHits(run);
    for (const c of hits) {
      const hit = { cls: c.wall!, d: localDate(c.at), sh, epoch: run.epoch, repo: run.repoKey, program: keyOf(c.wall!, c.cmd) };
      if (fixReached(c.failed)) reached.add(hit);
      seen.push(hit);
    }
    const reps = run.repairs ?? (!run.closed && run.calls.length ? detectRepairs(run, { home, root: ctx.checkout }) : []);
    for (const r of reps) {
      const program = programKey(r.program);
      if (!program) continue;
      fixed.push({ cls: r.cls, d: localDate(r.at), sh, epoch: r.epoch, repo: run.repoKey, program, delta: r.delta.map((x) => ({ kind: x.kind, name: x.name })) });
    }
    // 2. A kept lesson for the wall, and a later passing call of the same program that carries its fix.
    for (const c of hits) {
      const lessons = wallLessons(c.wall!, run.repoKey, ctx.env, { write: true });
      if (!lessons.length) continue;
      const program = keyOf(c.wall!, c.cmd);
      const after = run.calls.slice(run.calls.indexOf(c) + 1);
      if (c.wall === 'timeout-missing') {
        // D117 (5): the fix is the same command without timeout, so a lesson for it worked once the next run of that
        // program with no timeout passed (its words never match a delta: "timeout: command not found" holds a colon).
        const inner = keyOf(c.wall, withoutTimeout(c.cmd));
        const ok = after.find((x) => !x.failed && x.cmd && keyOf(c.wall!, x.cmd) !== 'timeout' && (inner === 'shell' || keyOf(c.wall!, x.cmd) === inner));
        if (ok) for (const l of lessons) worked.push({ cls: c.wall, lessonId: l.id, sh, epoch: run.epoch, d: localDate(ok.at) });
        continue;
      }
      const done = after.findIndex((x) => !x.failed && x.cmd && keyOf(c.wall!, x.cmd) === program);
      if (done < 0) continue;
      // The lesson's delta was kept with the repo as ./ and the home as $HOME (b2): the commands are read the same way.
      const ranText = after.slice(0, done + 1).filter((x) => !x.failed && x.cmd).map((x) => relativizePaths(x.cmd!, ctx.checkout, home)).join('\n');
      for (const l of lessons) {
        const parts = deltaParts(l.text);
        if (parts.length && parts.every((p) => ranText.includes(p))) worked.push({ cls: c.wall!, lessonId: l.id, sh, epoch: run.epoch, d: localDate(after[done]!.at) });
      }
    }
  }
  if (!seen.length && !fixed.length && !worked.length) return 0;
  const w = readWalls(ctx.env);
  const has = (cls: WallClass) => w.classes[cls];
  const newSeen = seen.filter((s) => !has(s.cls)?.seen.some((x) => x.sh === s.sh && x.epoch === s.epoch && x.program === s.program));
  const newFixed = fixed.filter((s) => !has(s.cls)?.fixed.some((x) => x.sh === s.sh && x.epoch === s.epoch && x.program === s.program));
  const newWorked = worked.filter((k) => !has(k.cls)?.lessons[k.lessonId]?.worked.some((x) => x.sh === k.sh && x.epoch === k.epoch));
  if (newSeen.length || newFixed.length || newWorked.length) noteWalls({ seen: newSeen, fixed: newFixed, worked: newWorked }, ctx.env);
  return newSeen.filter((h) => reached.has(h)).length;
}

const sha = (cmd: string) => `sha256:${createHash('sha256').update(normalizeCommand(stripTimeout(cmd))).digest('hex')}`;

/**
 * 3.5 step 5 (`fold`): one `guardrail{sure-fail}` per deny the fast path marked since the last Stop, and
 * `guardrail{avoided}` for each whose command, without timeout, then passed within 30 minutes. Moves `deniedSeen` on.
 */
export function guardrailCounts(st: SkillSessionState, ctx: GateCtx, sent: Sent): void {
  let lines: string[];
  try {
    const st0 = statSync(sessionPath(ctx.sessionId, '.denied.jsonl', ctx.env));
    if (!st0.isFile() || st0.size > 64 * 1024) return;
    lines = readFileSync(sessionPath(ctx.sessionId, '.denied.jsonl', ctx.env), 'utf8').split('\n').filter(Boolean).slice(0, MAX_DENIED_LINES);
  } catch {
    return;
  }
  const from = Math.max(0, Math.min(st.deniedSeen ?? 0, lines.length));
  if (from >= lines.length) return;
  const passed = st.runs.flatMap((r) => r.calls).filter((c) => !c.failed && c.cmd);
  for (const line of lines.slice(from)) {
    let d: { at?: unknown; restSha?: unknown };
    try { d = JSON.parse(line); } catch { continue; }
    sent.push(['guardrail', { class: 'no-timeout', outcome: 'sure-fail' }]);
    const at = typeof d.at === 'string' ? Date.parse(d.at) : NaN;
    if (Number.isNaN(at) || typeof d.restSha !== 'string') continue;
    const avoided = passed.some((c) => {
      const t = Date.parse(c.at);
      return t >= at && t - at <= AVOIDED_MS && sha(c.cmd!) === d.restSha;
    });
    if (avoided) sent.push(['guardrail', { class: 'no-timeout', outcome: 'avoided' }]);
  }
  st.deniedSeen = lines.length;
}

/**
 * 3.1 step 9 (R38): the fix lines for the walls hit in the epoch a compaction just closed, at most 2, read from the
 * calls still held and from walls.json's hits for this session and epoch.
 */
export function compactWallLines(st: SkillSessionState, ctx: GateCtx): string[] {
  const epoch = st.epoch - 1;
  const classes: WallClass[] = [];
  const add = (cls: WallClass) => { if (!classes.includes(cls)) classes.push(cls); };
  for (const r of st.runs) if (r.epoch === epoch) for (const c of countedHits(r)) add(c.wall!);
  try {
    const w = readWalls(ctx.env);
    for (const [cls, c] of Object.entries(w.classes)) {
      if (c?.seen.some((x) => x.sh === ctx.sessionHash && x.epoch === epoch)) add(cls as WallClass);
    }
  } catch { /* the calls alone */ }
  const place = { checkout: ctx.checkout, repoKey: ctx.repoKey, env: ctx.env, now: ctx.now };
  return classes.slice(0, COMPACT_FIXES).map((cls) => wallContextText(cls, place).text).filter(Boolean);
}
