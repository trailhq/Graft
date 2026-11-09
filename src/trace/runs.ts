/**
 * Runs (design 4.1): the tool work that serves one typed ask, the ask plus
 * its short follow-ups, in one context epoch. Folded incrementally from what
 * a session's transcript gained since the last hook, into the `skills` state
 * of `~/.trail/sessions/<id>.json`; judged for a checked success (4.2); and
 * written as run sheets (2.4) once closed.
 *
 * Typed text lives in local variables only and is gone when the fold
 * returns: the state keeps job words, parameter values of known shapes,
 * counts, hashes of typed lines and commands that ran (secret-checked).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { TraceEvent } from './claude.js';
import { callText, checkFamilyOf, classifyCheck, classifyToolCheck, endsInFailure, endsInQuestion, factsFromCalls, isDeployTool } from './checks.js';
import { errorLine } from './failure.js';
import { askText, isStatusOrHistory, matchJob, promptParams, wordCount, MAX_ASK_WORDS } from './jobs.js';
import { cleanLine } from './redact.js';
import { addSharedWords, cleanTail, EDIT_TOOLS, grepNoMatch, hostRefused, isPoll, keepsTail, makeCall, makeToolCall, setWall, wentToBackground, type PlaceOf } from './run-calls.js';
import { noteRepairs, type RepairOpts } from './repairs.js';
import { majorityKey } from './run-join.js';
import { checkedSuccess } from './run-verdict.js';
import { tamperOf } from './tamper.js';
import { branchTest } from '../skills/anchors-git.js';
import type { PostMark } from './gate-file.js';
import { normalizeCommand, onlyTrail } from './shell.js';
import { classifyAnswer, isGoAhead, isSaveRequest, typedSha } from './typed.js';
import { classifyFor } from '../skills/offer-answers.js';
import type { JobClass, PromptParams, RunCall, RunEnd, RunState, SkillSessionState, TypedAnswer } from './types.js';
import { keepSeen, takeSeenSet } from './seen-cache.js';

export { findPriorSheet, pruneRunSheets, readRunSheet, runSheetPath, writeRunSheet } from './run-sheets.js';
export { MAX_CARRY_HOPS, joinCarriedSheet } from './run-join.js';
export { runHelpers } from './run-calls.js';
export { cutAtCompaction } from './run-turns.js';
import { continuesOpenJob, cutAtCompaction, handedWait, movedOn } from './run-turns.js';
export { checkedSuccess, lastGoodRun } from './run-verdict.js';

export interface FoldContext {
  sessionHash: string;
  checkout: string;             // repo root of the session cwd ('' when not in git)
  /** Cached repoPlace(path).key for a folder inside git; null outside git. */
  repoKeyOf(path: string): string | null;
  /** Cached repoPlace(path).checkout for a folder inside git (the root `cwd` is relative to); null outside git. Defaults to `checkout` for its key. */
  rootOf?(path: string): string | null;
  /** The session's repo key (GateCtx.repoKey): a run with no step calls in git is put down to it. */
  repoKey?: string;
  trailHome: string;            // for the tamper check
  transcriptPath: string;       // its project folder is the host's, for the tamper check
  /** From takePostMarks: outcomes for calls whose result the transcript doesn't have yet (3.4). */
  marks: PostMark[];
  now: Date;
}
export interface FoldResult {
  closed: RunState[];           // runs closed by these events, calls still in memory
  lastAssistant: string;        // last 600 chars of the last assistant text (never stored)
  compactions: number;
  /** Every typed event folded, as hashes and labels only (never stored). The gate reads these. */
  typed: Array<{ offset: number; at: string; sha: string; answer: TypedAnswer; save: boolean }>;
}
export interface CheckedVerdict { checked: boolean; checkIndex: number | null; end: RunEnd; why?: string }

const GAP_MS = 30 * 60 * 1000;
const MAX_RUNS = 20;
const MAX_CALLS = 200;
const MAX_WORDS = 12;
const INSTALL_LINE = 'Install trail to get this on every task';
const TRAIL_TOOL = /^mcp__(?:trail|graft)__/;
/** Commands factsFromCalls can read a fact from (publish, version, push, rev-parse, commits/<sha>, gh pr). */
const FACT_CMD = /\b(?:publish|version|push|rev-parse|gh pr)\b|commits\//;

/** 'r-' + MMDD + '-' + 4 hex. */
export function newRunId(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `r-${two(now.getMonth() + 1)}${two(now.getDate())}-${randomBytes(2).toString('hex')}`;
}

/**
 * A run id no one holds: 4 hex a day is 65,536 ids shared by every session, so a new one is drawn until
 * `taken` (a run in this session, or a sheet on disk from any session) says it is free; after 64 tries, any.
 */
export function freshRunId(now: Date, taken: (id: string) => boolean): string {
  let id = newRunId(now);
  for (let i = 0; i < 64 && taken(id); i++) id = newRunId(now);
  return id;
}

/** What `st.seen` keeps (D56d): 10 hex of sha256 per key, the newest 6,000. */
const SEEN_HEX = 10;
const SEEN_MAX = 6000;
const seenHash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, SEEN_HEX);

/** toolCalls >= 5 or failedCount >= 1. */
export function costly(run: RunState): boolean {
  return run.toolCalls >= 5 || run.failedCount >= 1;
}

/** A later of two timestamps: a queued prompt or a repeated line never moves `lastAt` back. */
const later = (a: string, b: string) => (!b || (a && Date.parse(a) >= Date.parse(b)) ? a || b : b);

const within = (from: string, to: string) => {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isNaN(a) || Number.isNaN(b) || b - a <= GAP_MS;
};
const mergeWords = (into: string[], more: string[]) => {
  for (const w of more) if (into.length < MAX_WORDS && !into.includes(w)) into.push(w);
};

/** A look call fails by its exit or the host's flag only (D56c), and a grep that found nothing has not failed (D59d). */
const lookFailed = (raw: string, isError: boolean, text: string) => isError && !grepNoMatch(raw, text);

/** Folds new events into the session's runs (4.1). Mutates st. */
export function foldEvents(st: SkillSessionState, events: TraceEvent[], ctx: FoldContext): FoldResult {
  const res: FoldResult = { closed: [], lastAssistant: '', compactions: 0, typed: [] };
  const home = homedir();
  const fix: RepairOpts = { home, root: ctx.checkout };
  const raws = new Map<string, string>();           // tool_use id -> raw command, this fold only
  const others = new Map<string, { run: RunState; edit: boolean }>(); // non-Bash calls, this fold only
  const startText = new Map<RunState, string>();     // the typed text that started a run, this fold only
  const typedRuns: Array<{ at: string; run: RunState | null; carried?: true }> = [];
  const touched = new Set<RunState>();
  const sessionKey = ctx.repoKey ?? (ctx.checkout ? ctx.repoKeyOf(ctx.checkout) : null) ?? '';
  // D93: the top of each checkout a call ran in, by key, so a run keeps the checkout its key names.
  const roots = new Map<string, string>();
  const placeOf: PlaceOf = (folder) => {
    const key = ctx.repoKeyOf(folder);
    const root = key === null ? null : ctx.rootOf ? ctx.rootOf(folder) : ctx.checkout || null;
    if (key !== null && root) roots.set(key, root);
    return { key, root };
  };
  const rawOf = (c: RunCall) => raws.get(c.id) ?? callText(c);
  const norms = new Map<string, string>();          // tool_use id -> normalizeCommand, this fold only
  const normOf = (c: RunCall) => {
    let n = norms.get(c.id);
    if (n === undefined) norms.set(c.id, (n = normalizeCommand(rawOf(c))));
    return n;
  };
  /** Run facts from the calls before `i` that can hold any (factsFromCalls reads only these). */
  const factsBefore = (run: RunState, i: number) =>
    factsFromCalls(run.calls.slice(0, i).filter((c) => FACT_CMD.test(callText(c)) || (c.tail !== undefined && /^\+ /m.test(c.tail))), run.promptParams);

  // D56d: what earlier folds already saw (a repeated block of history, or a transcript read again from the top).
  let seenSet: Set<string> | null = null;
  const fresh: string[] = [];
  const seenBefore = (key: string): boolean => {
    seenSet ??= takeSeenSet(st, SEEN_HEX);   // kept across folds of one state (init's replay)
    const h = seenHash(key);
    if (seenSet.has(h)) return true;
    seenSet.add(h);
    fresh.push(h);
    return false;
  };
  const runsDir = join(ctx.trailHome, 'runs');
  const idTaken = (id: string) => st.runs.some((r) => r.id === id) || existsSync(join(runsDir, `${id}.json`));

  const open = (): RunState | null => {
    const last = st.runs[st.runs.length - 1];
    return last && !last.closed ? last : null;
  };
  const close = (run: RunState | null) => {
    if (!run || run.closed) return;
    run.closed = true;
    touched.add(run);
    res.closed.push(run);
  };
  const start = (at: string, job: JobClass | null, words: string[], params: PromptParams, typedCount: number): RunState => {
    const id = freshRunId(Number.isNaN(Date.parse(at)) ? ctx.now : new Date(at), idTaken);
    const run: RunState = {
      id, epoch: st.pendingBoundary ? Math.max(0, st.epoch - 1) : st.epoch, startedAt: at || ctx.now.toISOString(), lastAt: at || ctx.now.toISOString(),
      repoKey: sessionKey, branch: null, job, jobWords: words.slice(0, MAX_WORDS), promptParams: { ...params }, sharedWords: [], typedCount,
      toolCalls: 0, edits: 0, commands: 0, failedCount: 0, stepCalls: 0, calls: [], closed: false, end: 'open', sheet: 'none', checkIndex: null, poolNoted: false,
    };
    st.runs.push(run);
    while (st.runs.length > MAX_RUNS) {
      const i = st.runs.findIndex((r) => r.closed);
      if (i < 0) break;
      st.runs.splice(i, 1);
    }
    touched.add(run);
    return run;
  };
  /** A run the agent starts with no typed ask: it continues the job a compaction cut, within 30 minutes (D59a). */
  const startUntyped = (at: string): RunState => {
    const from = st.cut === undefined ? undefined : st.runs.find((r) => r.id === st.cut);
    delete st.cut;
    if (!from || !within(from.lastAt, at)) return start(at, null, [], {}, 0);
    const run = start(at, from.job, from.jobWords, from.promptParams, 0);
    run.carriedFrom = from.id;
    typedRuns.push({ at, run, carried: true });
    return run;
  };
  const tamper = (what: string | null) => {
    if (what && st.tampered === null) st.tampered = what;
  };
  const findCall = (id: string): { run: RunState; i: number } | null => {
    for (let r = st.runs.length - 1; r >= 0; r--) {
      const run = st.runs[r]!;
      const i = run.calls.findIndex((c) => c.id === id);
      if (i >= 0) return { run, i };
    }
    return null;
  };

  // Inside a repeated block, lines with no key of their own (assistant text, notices) are old too, until one
  // is newer than anything folded so far.
  let repeating = false;
  let newest = st.runs.reduce((m, r) => later(r.lastAt, m), '');
  for (const ev of events) {
    const key = ev.kind === 'tool_call' ? `c:${ev.id}` : (ev.kind === 'typed' || ev.kind === 'compaction') && ev.uuid ? `u:${ev.uuid}` : null;
    if (key !== null) repeating = seenBefore(key);
    else if (repeating && ev.at && newest && Date.parse(ev.at) > Date.parse(newest)) repeating = false;
    if (repeating && ev.kind !== 'tool_result') continue;
    if (ev.at) newest = later(ev.at, newest);
    switch (ev.kind) {
      case 'compaction': {
        for (const r of cutAtCompaction(st, fix)) {
          touched.add(r);
          res.closed.push(r);
        }
        delete st.replyEnd;
        if (st.pendingBoundary) st.pendingBoundary = false;
        else st.epoch += 1;
        for (const inj of st.injected) if (inj.epoch < st.epoch) inj.live = false;
        res.compactions += 1;
        break;
      }
      case 'injected': {
        if (!st.offerUsed && ev.text.includes(INSTALL_LINE)) {
          st.offerUsed = true;
          st.offerUsedBy = 'install-line';
        }
        break;
      }
      case 'assistant': {
        res.lastAssistant = ev.text.slice(-600);
        // D116 item 3: how this reply ends, for the typed line after it (4.3's order: failure, then a question).
        st.replyEnd = endsInFailure(ev.text) ? 'failure' : endsInQuestion(ev.text) ? 'question' : 'done';
        break;
      }
      case 'typed': {
        const text = ev.text;
        const offset = ev.offset ?? -1;
        delete st.cut; // the person spoke: runs start from their words again
        const replyEnd = st.replyEnd;
        delete st.replyEnd;
        const sha = typedSha(text);
        const answer = classifyAnswer(text, false);
        const save = isSaveRequest(text);
        res.typed.push({ offset, at: ev.at, sha, answer, save });
        const po = st.pendingOffer;
        const afterOffer = !!(po && po.shownAt && Date.parse(ev.at) > Date.parse(po.shownAt));
        if (po && afterOffer) {
          const ta = po.typedAfter;
          // Phase 2 (4.10): by the offer's own words (drift's replace is its yes, retire is retire).
          if (ta.length === 0) ta.push({ offset, sha, answer: classifyFor(po.moment, text, false) });
          else if (ta.length === 1 && ta[0]!.answer === 'show') ta.push({ offset, sha, answer: classifyFor(po.moment, text, true) });
        }
        const sr = st.saveRequest;
        if (sr && sr.typed === null && sha === sr.typedSha && Date.parse(ev.at) >= Date.parse(sr.at) - 5000) sr.typed = { offset, sha };

        const cur = open();
        const near = cur !== null && within(cur.lastAt, ev.at);
        const waits = near || (cur !== null && handedWait(cur, ev.at)); // D137: the same job's next ask, after a hand-off
        const follow = (run: RunState) => {
          run.typedCount += 1;
          run.lastAt = later(ev.at, run.lastAt);
          touched.add(run);
          typedRuns.push({ at: ev.at, run });
        };
        const fresh = (job: JobClass | null, words: string[]) => {
          close(cur);
          const run = start(ev.at, job, words, promptParams(text), 1);
          startText.set(run, text);
          typedRuns.push({ at: ev.at, run });
        };
        if ((afterOffer && (answer === 'yes' || answer === 'no' || answer === 'show')) || save) {
          close(cur);
          typedRuns.push({ at: ev.at, run: null });
        } else if (isStatusOrHistory(text)) {
          // A follow-up question; after a long gap the old run is over, and the question starts nothing.
          if (cur && near) follow(cur);
          else {
            close(cur);
            typedRuns.push({ at: ev.at, run: null });
          }
        } else {
          // D136 (3): "deploy it to <branch>" for a branch this checkout has. D120 (1): the open run's own job, any length.
          const m = matchJob(text, { hasBranch: branchTest(ctx.checkout) }) ?? continuesOpenJob(text, cur && near ? cur : null);
          // D116 item 3: a go-ahead, or an answer to the question the reply ended with, spans turns, unless it
          // names another job or the run already checked out (the next job's steps are a run of their own). A run a
          // compaction closed stays closed: after one, the person's words start runs again (D59a).
          const goOn = isGoAhead(text) || replyEnd === 'question';
          const sameJob = m === null || (cur !== null && cur.job === m.job);
          if (goOn && sameJob && cur && waits && !movedOn(cur, replyEnd)) {
            follow(cur);
            if (m) mergeWords(cur.jobWords, m.words);
            Object.assign(cur.promptParams, promptParams(text));
            if (replyEnd === 'failure') cur.failedTurn = cur.calls.length;
          } else if (goOn && m === null && cur && near) {
            fresh(null, []);
          } else if (m) {
            if (cur && waits && cur.job === m.job) {
              follow(cur);
              mergeWords(cur.jobWords, m.words);
              Object.assign(cur.promptParams, promptParams(text));
            } else fresh(m.job, m.words);
          } else if (wordCount(askText(text)) <= MAX_ASK_WORDS && cur && near) {
            follow(cur);
            Object.assign(cur.promptParams, promptParams(text));
          } else fresh(null, []);
        }
        break;
      }
      case 'tool_call': {
        delete st.replyEnd; // a reply ends with its last text: words before a call are not its end
        const input = ev.input && typeof ev.input === 'object' ? (ev.input as Record<string, unknown>) : {};
        const raw = ev.name === 'Bash' && typeof input.command === 'string' ? input.command : null;
        if (raw !== null && onlyTrail(raw)) {
          tamper(tamperOf('Bash', input, raw, { ...ctx, home }));
          break;
        }
        if (TRAIL_TOOL.test(ev.name)) break;
        const run = open() ?? startUntyped(ev.at);
        run.toolCalls += 1;
        run.lastAt = later(ev.at, run.lastAt);
        touched.add(run);
        if (EDIT_TOOLS.has(ev.name)) {
          run.edits += 1;
          tamper(tamperOf(ev.name, input, null, { ...ctx, home }));
        }
        if (raw === null && isDeployTool(ev.name)) {
          // D59b: check evidence, never a step or a command.
          run.calls.push(makeToolCall(ev, ev.name));
          if (run.calls.length > MAX_CALLS) run.calls.splice(0, run.calls.length - MAX_CALLS);
          break;
        }
        if (raw === null) {
          // A tool that writes as a command does (Codex's keys fed to a running shell) is checked as one (review).
          if (!EDIT_TOOLS.has(ev.name)) tamper(tamperOf(ev.name, input, null, { ...ctx, home, folder: ev.cwd || ctx.checkout || null }));
          others.set(ev.id, { run, edit: EDIT_TOOLS.has(ev.name) });
          break;
        }
        run.commands += 1;
        const call = makeCall(ev, raw, run.job, placeOf, ctx.checkout || null, home);
        if (run.edits > 0) call.editsBefore = run.edits; // b2 review: an edit between a failure and its retry
        tamper(tamperOf('Bash', input, raw, { ...ctx, home, folder: ev.cwd || ctx.checkout || null }));
        raws.set(ev.id, raw);
        run.calls.push(call);
        if (run.calls.length > MAX_CALLS) run.calls.splice(0, run.calls.length - MAX_CALLS);
        if (call.kind === 'step') {
          run.stepCalls += 1;
          if (run.branch === null && ev.branch) run.branch = ev.branch;
        }
        const asked = startText.get(run);
        if (asked !== undefined) addSharedWords(run.sharedWords, asked, raw);
        break;
      }
      case 'tool_result': {
        const found = findCall(ev.id);
        if (!found) {
          const other = others.get(ev.id);
          if (other && ev.isError && hostRefused(ev.text)) {
            other.run.toolCalls = Math.max(0, other.run.toolCalls - 1);
            if (other.edit) other.run.edits = Math.max(0, other.run.edits - 1);
          }
          if (other && ev.at) other.run.lastAt = later(ev.at, other.run.lastAt);
          break;
        }
        const { run, i } = found;
        const call = run.calls[i]!;
        // A call has one result; a second one is a repeated line of history.
        if (call.src.result !== null && !call.fromMark) break;
        touched.add(run);
        if (call.tool) {
          if (ev.isError && hostRefused(ev.text)) {
            run.calls.splice(i, 1);
            run.toolCalls = Math.max(0, run.toolCalls - 1);
            break;
          }
          call.failed = ev.isError === true;
          call.isError = ev.isError === true;
          call.src.result = ev.offset ?? -1;
          const check = classifyToolCheck(call.tool, ev.text, { failed: call.failed, isError: call.isError }, factsBefore(run, i));
          if (check) call.check = check;
          else delete call.check;
          if (ev.at) run.lastAt = later(ev.at, run.lastAt);
          break;
        }
        if (call.failed) run.failedCount = Math.max(0, run.failedCount - 1); // a mark or an earlier result, replaced
        if (ev.isError && hostRefused(ev.text)) {
          // Never ran (D51): not a command, not a failure.
          run.calls.splice(i, 1);
          run.commands = Math.max(0, run.commands - 1);
          run.toolCalls = Math.max(0, run.toolCalls - 1);
          if (call.kind === 'step') run.stepCalls = Math.max(0, run.stepCalls - 1);
          break;
        }
        const raw = rawOf(call);
        // D56c: a look (or plumbing) call fails by its exit or the host's flag only, never by the text it read.
        const failed = call.kind === 'look' || call.kind === 'plumbing' ? lookFailed(raw, ev.isError === true, ev.text) : !ev.ok;
        call.failed = failed;
        call.isError = ev.isError === true;
        if (failed) run.failedCount += 1;
        delete call.fromMark;
        delete call.errorLine;
        delete call.tail;
        delete call.check;
        if (failed) {
          const line = errorLine(ev.text);
          const clean = line === null ? undefined : cleanLine(line, 160);
          if (clean) call.errorLine = clean;
        }
        setWall(call, raw, ev.text);
        call.src.result = ev.offset ?? -1;
        const family = checkFamilyOf(raw, run.job);
        if (keepsTail(raw, family !== null, isPoll(normOf(call), run.calls.slice(0, i), normOf))) {
          const tail = cleanTail(ev.text);
          if (tail) call.tail = tail;
        }
        const check = family === null ? null : classifyCheck(raw, ev.text, { failed, isError: call.isError }, factsBefore(run, i), run.job);
        // A background call's result says only that it started: never a passing check. So does a call Claude Code moved
        // to the background after its timeout (fix-lab5).
        if (check) call.check = call.bg || wentToBackground(ev.text) ? { ...check, passed: false } : check;
        if (ev.at) run.lastAt = later(ev.at, run.lastAt);
        break;
      }
    }
  }

  // Outcomes PostToolUse saw before the transcript had them (3.4): the open run's calls with no result yet.
  const cur = open();
  if (cur && ctx.marks.length) {
    for (let i = 0; i < cur.calls.length; i++) {
      const call = cur.calls[i]!;
      if (call.src.result !== null || call.fromMark) continue;
      const mark = ctx.marks.find((m) => m.id === call.id);
      if (!mark) continue;
      call.failed = call.kind === 'look' || call.kind === 'plumbing' ? lookFailed(rawOf(call), mark.failed, mark.tail ?? '') : mark.failed;
      if (call.failed) cur.failedCount += 1;
      if (mark.tail) call.tail = mark.tail;
      const check = checkFamilyOf(rawOf(call), cur.job) === null ? null
        : classifyCheck(rawOf(call), mark.tail ?? '', { failed: call.failed, isError: false }, factsBefore(cur, i), cur.job);
      if (check) call.check = call.bg || wentToBackground(mark.tail ?? '') ? { ...check, passed: false } : check;
      call.fromMark = true;
      touched.add(cur);
    }
  }

  // A run block's injection belongs to the run of the first typed ask at or after it (5 s of slack). When the
  // prompt hook's own catch-up already folded the ask, the hook links the block itself (prompt-skills askRun, g7).
  for (const inj of st.injected) {
    if (inj.runId !== null) continue;
    // A carried run (D59a) has no typed ask: only a compaction re-inject belongs to it.
    const t = typedRuns.find((x) => (!x.carried || inj.cue === 'compact') && Date.parse(x.at) >= Date.parse(inj.at) - 5000);
    if (!t?.run) continue;
    inj.runId = t.run.id;
    if (inj.cue !== 'check') t.run.skillId = inj.skillId;
  }

  // A carried run ran from the skill that drove the run it continues (after the injections found their runs).
  for (const run of touched) {
    if (!run.carriedFrom || run.skillId) continue;
    const from = st.runs.find((r) => r.id === run.carriedFrom);
    if (from?.skillId) run.skillId = from.skillId;
  }
  for (const run of touched) if (run.closed) noteRepairs(run, fix); // b2: also when a result lands after the close
  for (const run of touched) {
    run.repoKey = majorityKey(run, sessionKey);
    const root = roots.get(run.repoKey) ?? (run.repoKey === sessionKey && ctx.checkout ? ctx.checkout : undefined);
    if (root) run.checkout = root;
  }
  keepSeen(st, seenSet, fresh, SEEN_HEX, SEEN_MAX);
  if (events.length) st.updatedAt = ctx.now.toISOString();
  return res;
}
