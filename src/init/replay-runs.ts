/**
 * Init's replay of past sessions (design 4.2): a transcript's stretch goes
 * through 1a's own transcript reader (`lineEvents`) and fold (`foldEvents`),
 * turn by turn, with the Stop hook's end-of-turn judgement in between, so a
 * run's verdict here is the verdict the live hooks reach on the same lines.
 *
 * Everything stays in memory: no run sheet, cursor or session file is
 * written. Closed runs drop their calls as live (only wall hits stay); a run
 * sheet is built only for a checked run of a moment-2 job, and only the
 * newest 3 per job are held as the read goes, so a 200 MB transcript is read
 * with bounded memory (R36). Typed lines stay as text in memory with a
 * pointer (transcript, offset, sha of the line) that finds them again; the
 * text goes when the worker returns (0 rule 6).
 */
import { createHash } from 'node:crypto';
import { closeSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { repoPlace, type RepoPlace } from '../notes/home.js';
import { trailHome } from '../notes/trail-home.js';
import { compileRun } from '../skills/compile.js';
import { skillSha } from '../skills/offer-moment.js';
import { isKeepLine } from '../skills/offer-words.js';
import { renderSkillMd } from '../skills/skillmd.js';
import { nameTaken } from '../skills/store.js';
import type { CompiledSkill } from '../skills/types.js';
import { labInteractive } from '../skills/host-facts.js';
import { skillProblems } from '../skills/validate.js';
import { lineEvents, typedText, type TraceEvent } from '../trace/claude.js';
import { noteRepairs } from '../trace/repairs.js';
import { programOf } from '../trace/shell.js';
import { askText, MAX_ASK_WORDS, OFFER_FAMILIES, wordCount } from '../trace/jobs.js';
import { checkedSuccess, foldEvents, joinCarriedSheet, runHelpers, type FoldContext } from '../trace/runs.js';
import type { RunSheet, RunState, SkillSessionState } from '../trace/types.js';
import { claudeTranscript, openPlain } from './plain-file.js';
import { tamperedBefore, turnOnly, writeMarkIn } from './replay-tamper.js';
import { dayOf, eachLine } from './transcript.js';
import type { SkillSource, TypedRef } from './types.js';
import { stepLearnings } from '../skills/follow-learnings.js';

/** A session's replay stops at this many runs (4.2 cost control). */
export const MAX_REPLAY_RUNS = 200;
/** ... or after this long. */
export const MAX_REPLAY_MS = 60_000;
/** Sheets held per job as the read goes (R36). */
const SHEETS_PER_JOB = 3;
/** Draft sheets held for a compaction's carried run to join (D59a). */
const MAX_DRAFTS = 6;
/** Typed text held per line: a preference is 25 words or fewer (4.4). */
const TYPED_CHARS = 600;

export interface ReplayOpts {
  /** Resolves the Trail home (the tamper check) and repo keys (its index). Default process.env. */
  env?: NodeJS.ProcessEnv;
  maxRuns?: number;
  maxMs?: number;
  /** Closed runs keep their calls (the parity test reads them). Off by default: memory. */
  keepCalls?: boolean;
  /**
   * The byte range of one run to find (D112): a checked sheet whose range is exactly this, closed by the line that
   * ends it (never by the end of a stretch the replay was cut to), comes back as `wanted`. The replay stops once no
   * later run can end there.
   */
  want?: { from: number; to: number };
}

export interface ReplaySheet {
  sheet: RunSheet;
  /** The run's byte range: its first typed line (or first call) to the line that closed it. */
  src: { from: number; to: number };
  /** The checkout the run's own repo was in when it ran, for relativizing its paths. '' when unknown. */
  root: string;
}

export interface Replay {
  runs: RunState[];
  sheets: ReplaySheet[];
  /** `at`: the line's own time, for the 8 h sitting rule (4.4 step 4). */
  typed: Array<{ ref: TypedRef; day: string; text: string; at: string }>;
  headless: boolean;
  /** 1a's session hash of the transcript's session id (its file name). */
  sh: string;
  /** The repo the replay was for: runs whose own key differs are another repo's work. */
  repoKey: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** The programs the session's commands ran (first words, at most 200): the repo's own names (4.4 step 7). */
  programs: string[];
  /** Set when the replay stopped early: at the run cap, or out of time. */
  stopped?: 'runs' | 'time';
  /** The byte range replayed: the whole file, or one repo's stretch of it. */
  stretch?: { from: number; to: number };
  /** With `opts.want`: the whole run with exactly that range, when there is one. */
  wanted?: ReplaySheet;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 1a's session hash: sha256 of the session id, 12 hex. Claude Code names a transcript after its session id. */
export function sessionHashOf(path: string): string {
  return sha256(basename(path, '.jsonl')).slice(0, 12);
}

function newState(sh: string, repoKey: string, now: Date): SkillSessionState {
  return {
    v: 1, sessionHash: sh, host: 'claude', tier: 'A', learn: true, scopeKeys: repoKey ? [repoKey] : [], epoch: 0, pendingBoundary: false,
    runs: [], pendingOffer: null, offerUsed: false, offerUsedBy: null, saveRequest: null, injected: [], credit: [], tampered: null,
    updatedAt: now.toISOString(),
  };
}

/** The run sheet 1a would have written (1a §2.4), built in memory: `writeRunSheet`'s shape, nothing on disk. */
export function sheetFromRun(run: RunState, sessionHash: string): RunSheet {
  const v = checkedSuccess(run, null);
  const checked = v.checked && v.checkIndex !== null;
  return {
    v: 1, id: run.id, session: sessionHash, repoKey: run.repoKey, branch: run.branch, host: 'claude', tier: 'A', epoch: run.epoch,
    startedAt: run.startedAt, endedAt: run.lastAt, job: run.job, jobWords: [...run.jobWords], sharedWords: [...run.sharedWords],
    promptParams: { ...run.promptParams },
    calls: run.calls.map((c) => (c.key === run.repoKey ? { ...c } : { ...c, cwd: null })),
    checkIndex: checked ? v.checkIndex : null, checked, end: v.end,
    counts: { commands: run.commands, failed: run.failedCount, toolCalls: run.toolCalls, edits: run.edits },
    helpers: runHelpers(run), skillId: run.skillId ?? null, ...(run.carriedFrom ? { carriedFrom: run.carriedFrom } : {}),
  };
}

class Stop extends Error {}

/** What a reply may dress a line in (a fence, a quote, bold, end space), as the live Stop reads the offer (`withoutOffer`). */
const core = (t: string) => t.replace(/[*_`"'>\u2018\u2019\u201c\u201d]/gu, '').replace(/\s+/g, ' ').trim();
/** The offer's line 1 (4.12): "<what the check showed> That's the 3rd day I've worked out this release from scratch (…)." */
const OFFER_LINE_1 = /That['\u2019]?s the \S+ (?:day|time) I['\u2019]?ve worked out this .{1,60} from scratch \(/;

/**
 * A reply without Trail's moment-2 offer lines at its end. The live Stop judged the run before the agent said them
 * (the block continues the turn, and that Stop, `stop_hook_active`, judges nothing), so the replay reads the reply
 * as live did: line 2 "Keep the n that worked as a skill …? (yes / show me / no)" read as a question would make
 * the run a question, and line 1's "1 failed" a failure. '' when the reply was only the offer (b5 review).
 */
export function withoutOfferLines(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/);
  const trim = () => {
    while (lines.length && !core(lines[lines.length - 1]!)) lines.pop();
  };
  trim();
  if (!lines.length || !isKeepLine(core(lines[lines.length - 1]!).replace(/[.\s]+$/u, ''))) return text;
  lines.pop();
  trim();
  if (lines.length && OFFER_LINE_1.test(lines[lines.length - 1]!.replace(/\s+/g, ' '))) lines.pop();
  trim();
  return lines.join('\n');
}

/** Claude Code's marker for a turn the person stopped: no Stop hook runs for it, so no end is judged. */
const INTERRUPTED = /^\[Request interrupted by user/;

/**
 * One past session's stretch through 1a's parser and fold, in memory; nothing written. Run sheets are built only
 * for checked runs of an OFFER_FAMILIES job, and only the newest 3 per job are kept as the read goes (R36).
 * Never throws: an unreadable file replays to nothing.
 */
export function replaySession(path: string, stretch: { from: number; to: number }, repoKey: string, now: Date = new Date(),
  opts: ReplayOpts = {}): Replay {
  const env = opts.env ?? process.env;
  const sh = sessionHashOf(path);
  const out: Replay = { runs: [], sheets: [], typed: [], headless: false, sh, repoKey, path, size: 0, mtimeMs: 0, programs: [], stretch: { ...stretch } };
  const programs = new Set<string>();
  try {
    const st0 = statSync(path);
    out.size = st0.size;
    out.mtimeMs = st0.mtimeMs;
  } catch {
    return out;
  }
  const maxRuns = opts.maxRuns ?? MAX_REPLAY_RUNS;
  const deadline = Date.now() + (opts.maxMs ?? MAX_REPLAY_MS);
  const st = newState(sh, repoKey, now);

  const places = new Map<string, RepoPlace>();
  const place = (p: string) => {
    let v = places.get(p);
    if (!v) places.set(p, (v = repoPlace(p, env)));
    return v;
  };
  /** Repo key -> the checkout it was first seen in. */
  const roots = new Map<string, string>();
  const keyOf = (p: string) => {
    const v = place(p);
    if (!v.git) return null;
    if (!roots.has(v.key)) roots.set(v.key, v.checkout);
    return v.key;
  };
  let ctx: FoldContext | null = null;
  const ctxFor = (cwd: string): FoldContext => {
    const p = cwd ? place(cwd) : null;
    return {
      sessionHash: sh, checkout: p?.git ? p.checkout : '', repoKey, repoKeyOf: keyOf, rootOf: (q) => (place(q).git ? place(q).checkout : null),
      trailHome: trailHome(env), transcriptPath: path, marks: [], now,
    };
  };

  const runStart = new Map<string, number>();
  const drafts: RunSheet[] = [];
  const byId = (id: string) => drafts.find((d) => d.id === id) ?? out.sheets.find((s) => s.sheet.id === id)?.sheet ?? null;
  const draftFrom = new Map<string, number>();
  let started = 0;

  const want = opts.want;
  /** The replay stopped early: the wanted run was found, or no run can end at its end any more. */
  let early = false;
  /** `tampered`: the session had written Trail's or the host's files by the time the run closed, or the run was open
   *  in a turn that ran a hook script by hand. `whole`: closed by
   *  the line that ends it, or by the end of the file, not by a cut. */
  const closeRun = (run: RunState, to: number, tampered: boolean, whole = true) => {
    const from = runStart.get(run.id) ?? to;
    if (run.stepCalls > 0 && run.calls.length) {
      const sheet = sheetFromRun(run, sh);
      run.sheet = sheet.checked ? 'checked' : 'draft';
      run.checkIndex = sheet.checkIndex;
      if (sheet.checked && run.job && OFFER_FAMILIES[run.job] && !tampered) {
        const joined = joinCarriedSheet(sheet, byId);
        const first = joined.joined?.[0]?.id;
        const src = { from: first !== undefined ? draftFrom.get(first) ?? from : from, to };
        out.sheets.push({ sheet: joined, src, root: roots.get(joined.repoKey) ?? '' });
        if (want && whole && !out.wanted && src.from === want.from && src.to === want.to) out.wanted = out.sheets[out.sheets.length - 1];
        const same = out.sheets.filter((s) => s.sheet.job === run.job);
        if (same.length > SHEETS_PER_JOB) out.sheets.splice(out.sheets.indexOf(same[0]!), 1);
      } else if (!sheet.checked && run.job) {
        // A part a later carried run may join (D59a).
        drafts.push(sheet);
        draftFrom.set(sheet.id, from);
        if (drafts.length > MAX_DRAFTS) draftFrom.delete(drafts.shift()!.id);
      }
    }
    for (const c of run.calls) {
      const p = c.cmd ? programOf(c.cmd)?.split(' ')[0] : null;
      if (p && programs.size < 200 && /^[\w.+-]{1,40}$/.test(p)) programs.add(p);
    }
    if (!opts.keepCalls) run.calls = run.calls.filter((c) => c.wall !== undefined);
    out.runs.push(run);
  };

  const memo: Record<string, unknown> = {};
  /** Runs that were open in a turn that ran a hook script by hand (D135 (1)). */
  const turnTainted = new Set<string>();
  let chunk: TraceEvent[] = [];
  let chunkAt = stretch.from;
  let turnLast = '';
  /** The person interrupted this turn: Claude Code runs no Stop for it (b5 review). */
  let turnCut = false;
  const fold = (endsTurn: boolean) => {
    if (chunk.length) {
      ctx ??= ctxFor('');
      // The turn's last words as the live Stop judged them: before Trail's offer lines, which a block made the agent say.
      for (const ev of chunk) {
        if (ev.kind === 'assistant') {
          const t = withoutOfferLines(ev.text);
          if (t.trim()) turnLast = t.slice(-600);
        } else if (ev.kind === 'injected' && INTERRUPTED.test(ev.text)) turnCut = true;
      }
      const known = new Set(st.runs.map((r) => r.id));
      // Closes happen at the chunk's first event, before any call in it: what the session had done by then.
      const tampered = st.tampered !== null;
      const res = foldEvents(st, chunk, ctx);
      // A run starts at the typed line that opened it, or at its first call.
      let first = chunk[0]!.kind === 'typed';
      for (const r of st.runs) {
        if (known.has(r.id) || runStart.has(r.id)) continue;
        started += 1;
        runStart.set(r.id, first && r.typedCount > 0 && !r.carriedFrom ? chunkAt : r.calls[0]?.src.use ?? chunkAt);
        first = false;
      }
      // Runs close only at the chunk's first event: a typed line or a compaction.
      for (const r of res.closed) closeRun(r, chunkAt, tampered || turnTainted.has(r.id));
      // D135 (1): a hook script run by hand taints only the runs open in its turn; a write still marks the session.
      if (turnOnly(st.tampered)) {
        for (const r of st.runs) if (!r.closed) turnTainted.add(r.id);
        st.tampered = writeMarkIn(chunk, ctx);
      }
      chunk = [];
      // Closes happen at chunk starts, which only grow: past the wanted end, no run can end there any more.
      if (want && (out.wanted || chunkAt >= want.to)) {
        early = true;
        throw new Stop();
      }
    }
    if (endsTurn) {
      // The Stop hook at the end of the turn (3.5 step 4): the open run's end, from the turn's last words. A turn the
      // person interrupted had no Stop.
      const open = st.runs[st.runs.length - 1];
      if (open && !open.closed && !turnCut) open.end = checkedSuccess(open, turnLast || null).end;
      turnLast = '';
      turnCut = false;
    }
    if (started >= maxRuns) {
      out.stopped = 'runs';
      throw new Stop();
    }
    if (Date.now() > deadline) {
      out.stopped = 'time';
      throw new Stop();
    }
  };

  try {
    eachLine(path, (line, offset) => {
      if (!(line.includes('"type":"user"') || line.includes('"type":"assistant"') || line.includes('"type":"attachment"') || line.includes('compact_boundary'))) return;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      // A script's run is headless, unless a lab home has the switch (D99, D136 (2)).
      if (typeof entry.entrypoint === 'string' && entry.entrypoint.startsWith('sdk') && !labInteractive(env)) {
        out.headless = true;
        throw new Stop();
      }
      if (ctx === null && typeof entry.cwd === 'string' && entry.cwd) ctx = ctxFor(entry.cwd);
      for (const ev of lineEvents(entry, memo, offset, env)) {
        if (ev.kind === 'typed' || ev.kind === 'compaction') {
          fold(ev.kind === 'typed');
          chunkAt = offset;
        }
        if (ev.kind === 'typed' && wordCount(askText(ev.text)) <= MAX_ASK_WORDS) {
          out.typed.push({ ref: { t: path, o: offset, s: sha256(line) }, day: dayOf(ev.at), text: ev.text.slice(0, TYPED_CHARS), at: ev.at });
        }
        chunk.push(ev);
      }
    }, stretch);
    fold(true);
  } catch (e) {
    if (!(e instanceof Stop)) return { ...out, runs: [], sheets: [], typed: [] };
  }
  if (out.headless) return { ...out, runs: [], sheets: [], typed: [] };
  const finish = () => {
    out.programs = [...programs];
    return out;
  };
  if (early) return finish();
  // The end of the stretch closes what is still open (4.2: "or the end").
  for (const r of st.runs) {
    if (r.closed) continue;
    r.closed = true;
    // As the fold does for a run it closes (b2): its repairs, while it still has its calls.
    noteRepairs(r, { home: homedir(), root: (ctx as FoldContext | null)?.checkout ?? '' });
    // A run closed by the stretch's end is whole only when the stretch is the rest of the file and was read to it.
    closeRun(r, out.stopped ? chunkAt : stretch.to, st.tampered !== null || turnTainted.has(r.id), !out.stopped && stretch.to >= out.size);
  }
  return finish();
}

export type InitCompile =
  | { ok: true; compiled: CompiledSkill; skillSha: string }
  | { ok: false; why: string; detail?: string };

/**
 * 1a's compile of one replayed sheet as moment 2 would offer it (4.5): `moment: 'repeated'`, its prior from
 * memory, paths relativized against the run's own checkout, 2+ steps (D70) and no validator problem. The look-back
 * and `recompileInitSkill` both call this, so the same range gives the same `skillSha`.
 */
export function compileInitSkill(entry: ReplaySheet, prior: ReplaySheet | null, repoKey: string, env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()): InitCompile {
  const scope = { repoKeys: [...new Set([repoKey, entry.sheet.repoKey])], checkout: entry.root, env };
  const r = compileRun(entry.sheet, {
    repoRoot: entry.root, home: env.HOME || homedir(), platform: process.platform, prior: prior?.sheet ?? null, moment: 'repeated',
    applies: repoKey, now, readSheet: () => null, taken: (n) => nameTaken(n, scope) !== null,
    learnings: stepLearnings({ repoKeys: [...new Set([repoKey, entry.sheet.repoKey])], checkout: entry.root, env }),
  });
  if (!r.ok) return { ok: false, why: r.reason, detail: r.detail };
  if (r.skill.steps.length < 2) return { ok: false, why: 'one-step' };
  const problems = skillProblems(renderSkillMd(r.skill), r.skill.name);
  if (problems.length) return { ok: false, why: 'invalid', detail: problems[0] };
  return { ok: true, compiled: r.skill, skillSha: skillSha(r.skill) };
}

/**
 * The run whose byte range is exactly `range`, found by replaying the whole transcript (D112): a range that is not one
 * whole run there (cut short of its end, starting mid-run, or two runs glued together) is null, so an edited record
 * can't make a skill of a run the session never checked. No run cap: the replay stops at the range's end.
 */
function wholeRun(t: string, range: { from: number; to: number }, repoKey: string, env: NodeJS.ProcessEnv, now: Date): ReplaySheet | null {
  let size: number;
  try {
    size = statSync(t).size;
  } catch {
    return null;
  }
  if (!(Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to) && range.from >= 0 && range.from < range.to && range.to <= size)) return null;
  const r = replaySession(t, { from: 0, to: size }, repoKey, now, { env, want: range, maxRuns: Number.POSITIVE_INFINITY });
  return r.headless || r.stopped ? null : r.wanted ?? null;
}

/**
 * Compile one init skill again from its source (keep and `draft init-<n>`, R24): replay the whole source session and
 * take the run whose range is exactly `src.run` (and `src.prior`'s), compile with the prior served from memory
 * (findPriorSheet reads disk, R21). The file must be the one init read (size and mtime), nothing before the run may
 * have written Trail's files, each range must be one whole run of its session (D112), and the compile must give the
 * same `skillSha`.
 */
export function recompileInitSkill(src: SkillSource, repoKey: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()):
  { ok: true; compiled: CompiledSkill } | { ok: false; why: 'gone' | 'changed' | 'refused' } {
  try {
    let st;
    try {
      st = statSync(src.t);
    } catch {
      return { ok: false, why: 'gone' };
    }
    if (!st.isFile()) return { ok: false, why: 'gone' };
    // Only a transcript where Claude Code keeps them, reached with no link: the record is editable, and a file the
    // agent wrote anywhere else could hold any steps it likes (R24, b5 review).
    if (!claudeTranscript(src.t, env) || (src.prior && !claudeTranscript(src.prior.t, env))) return { ok: false, why: 'refused' };
    if (st.size !== src.size || st.mtimeMs !== src.mtimeMs) return { ok: false, why: 'changed' };
    const range = src.run;
    if (!(Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to) && range.from >= 0 && range.from < range.to && range.to <= st.size)) {
      return { ok: false, why: 'changed' };
    }
    if (tamperedBefore(src.t, range.from, env)) return { ok: false, why: 'refused' };
    const entry = wholeRun(src.t, range, repoKey, env, now);
    if (!entry) return { ok: false, why: 'changed' };
    let prior: ReplaySheet | null = null;
    if (src.prior) {
      prior = wholeRun(src.prior.t, { from: src.prior.from, to: src.prior.to }, repoKey, env, now);
      if (!prior) return { ok: false, why: 'changed' };
    }
    const c = compileInitSkill(entry, prior, repoKey, env, now);
    if (!c.ok) return { ok: false, why: 'refused' };
    return c.skillSha === src.skillSha ? { ok: true, compiled: c.compiled } : { ok: false, why: 'changed' };
  } catch {
    return { ok: false, why: 'changed' };
  }
}

const MAX_LINE = 2 * 1024 * 1024;

/**
 * The person's typed words a pointer names, read again now: the line at `ref.o` in `ref.t`, only when its sha is
 * still `ref.s`, it is still a line the person typed, and `ref.t` is a transcript in Claude Code's projects folder
 * (`env`'s HOME), reached with no link: the pointer sits in an editable record, and a line in a file the agent wrote
 * is not the person's. Null otherwise; never waits on a FIFO. The words are shown, never stored.
 */
export function typedAt(ref: TypedRef, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (!Number.isSafeInteger(ref.o) || ref.o < 0 || !/^[0-9a-f]{64}$/.test(ref.s)) return null;
    if (!claudeTranscript(ref.t, env)) return null;
    const fd = openPlain(ref.t);
    let line: string;
    try {
      if (ref.o > 0) {
        const b = Buffer.alloc(1);
        if (readSync(fd, b, 0, 1, ref.o - 1) !== 1 || b[0] !== 0x0a) return null;
      }
      const parts: Buffer[] = [];
      let size = 0;
      const buf = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const got = readSync(fd, buf, 0, buf.length, ref.o + size);
        if (got <= 0) break;
        const nl = buf.subarray(0, got).indexOf(0x0a);
        const piece = Buffer.from(buf.subarray(0, nl < 0 ? got : nl));
        parts.push(piece);
        size += piece.length;
        if (nl >= 0 || size > MAX_LINE) break;
      }
      if (size > MAX_LINE) return null;
      line = Buffer.concat(parts).toString('utf8');
    } finally {
      closeSync(fd);
    }
    if (sha256(line) !== ref.s) return null;
    return typedText(JSON.parse(line), env) || null;
  } catch {
    return null;
  }
}
