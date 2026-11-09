/**
 * The skills part of SessionStart (design 3.1): the epoch a compaction or a
 * clear starts, the scope this session's skills come from, the lines on
 * what Trail keeps (D101), the index line (4.7), the held-item notice, and
 * the block a compaction cut short.
 *
 * A compaction is seen twice: by this hook, and by the fold when it meets
 * the compaction line in the transcript. Whichever comes first bumps the
 * epoch; `pendingBoundary` tells the fold this hook already did (4.1).
 *
 * The re-inject brings back only a block the person was still in the middle
 * of: the newest of the epoch just closed, live at the boundary, its run
 * still open there, and its check not passed. Fails open like the prompt
 * part (one line in `state/hook-errors.log`).
 *
 * 1b (3.1 steps 8 to 10): the index says `(may be out of date)` for a skill
 * with a gone anchor and leaves out one unused for 60 days (`skill_stale`
 * once each); a compaction brings back the fixes of the walls hit in the
 * epoch it closed (R38); and an init list waiting for the person's answer
 * is handed over once (J02 leg C). Each part fails open on its own.
 */
import type { Host } from '../trace/host.js';
import { readJsonSafe } from '../util/private-fs.js';
import type { HookOut } from '../skills/types.js';
import type { RunState, SkillInjection, SkillSessionState } from '../trace/types.js';
import { housekeeping, skillsGate, withSkillSession, type GateCtx } from '../trace/skill-session.js';
import { checkedSuccess, cutAtCompaction, runHelpers, writeRunSheet, type FoldResult } from '../trace/runs.js';
import { sessionPath } from '../trace/gate-file.js';
import { childCheckouts, repoPlace } from '../notes/home.js';
import { hostFacts } from '../skills/host-facts.js';
import { creditCalls, creditRun } from '../skills/ledger.js';
import { listHeld, markHeldShown, type HeldItem } from '../skills/store-held.js';
import { candidatesHere, indexLine, refusedAtRecall, type Candidate } from '../skills/recall.js';
import { injectionFor, runBlock, runProbes, withReadyFailed, type ProbeOpts } from '../skills/runblock.js';
import { recallMarks, stepLearnings, withFixes } from '../skills/follow-learnings.js';
import { flatLine } from '../notes/flatten.js';
import { FROM_TRAIL } from '../skills/directive-words.js';
import { canAsk, hookError, syncGate, trimInjected, type Sent } from './skills-hook-util.js';
import { goneAnchors } from '../skills/anchors.js';
import { markMissingSaid, markUnusedSaid, unusedSince } from '../skills/staleness.js';
import { initHandover } from '../init/handover.js';
import { compactWallLines, wallsAtStop } from './walls-hook.js';
import { refreshLessonIndex } from '../notes/lesson-index.js';
import { startValue } from '../skills/value-line.js';
import { CODEX_COPY } from '../hosts/codex-trust.js';

const MAX_CHILD_KEYS = 8;
const MAX_HELD_SHOWN = 2;
const HOSTS: Record<string, string> = { claude: 'Claude Code', cursor: 'Cursor', copilot: 'Copilot', codex: 'Codex', gemini: 'Gemini' };

/**
 * D101: with skills on, the session's first words about skills, so a later `trail skills add` directive is not the
 * first the agent hears of them (an agent refused one as injection when the session had only described learnings).
 * D117 (1): the third line names the other commands Trail may ask for (a lesson at moments 3 and 4, init's relay);
 * phase 2 (1.8), the fourth (c8; each line stays at most 320 characters): a change to a skill at moments 5 and 6, the
 * draft a "show me" prints, and the person-only restore.
 */
export const SKILLS_INTRO: readonly [string, string, string, string] = [
  '[trail] Trail, the tool this person installed, keeps commands that worked here as skills, and keeps one only after the person says yes.',
  '[trail] So Trail may ask you to run trail skills add <name> --run <id>, but only after the person typed yes to its offer or asked to save a job; that message quotes what they typed.',
  "[trail] Trail may also ask you to run trail skills lesson [<skill>] --offer <id> after the person typed yes to keeping what it offered, or to run trail keep <numbers> with the numbers they typed after trail init's list. Trail checks their answer in this session before it keeps anything.",
  "[trail] Trail may also ask you to run trail skills update <name> --offer <id> after the person typed yes to a change it showed, or trail skills draft <id> --print to show it first. It checks their answer before it changes a skill. An older version (trail skills restore <name> --version <n>) is theirs to bring back.",
];

export interface StartDeps {
  gate: (input: unknown, dir: string, env?: NodeJS.ProcessEnv) => ReturnType<typeof skillsGate>;
  probes: ProbeOpts;
}

/** 3.1. */
export function sessionStartSkills(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, deps: Partial<StartDeps> = {}): HookOut {
  return sessionStartSkillsRun(input, dir, env, deps).out;
}

/** 3.1, with the telemetry it collected (1b's `skill_stale`), for the caller to send after it. */
export function sessionStartSkillsRun(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, deps: Partial<StartDeps> = {}): { out: HookOut; sent: Sent } {
  const sent: Sent = [];
  try {
    const g = (deps.gate ?? skillsGate)(input, dir, env);
    if (!g.ok || g.ctx.subagent) return { out: {}, sent };
    const ctx = g.ctx;
    const source = typeof input?.source === 'string' && input.source ? input.source : 'startup';
    const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : dir;
    const out = withSkillSession(ctx, { catchUp: ctx.fold && source === 'compact' }, (st, fold) => inside(ctx, st, fold, source, cwd, deps.probes ?? {}, sent));
    if (!out) return { out: {}, sent };
    try { housekeeping(ctx.now, env); } catch { /* next hour */ }
    return { out, sent };
  } catch (e) {
    hookError('session-start', e, env);
    return { out: {}, sent: [] };
  }
}

/** 3.1 step 8 (4.18, 4.19): the index's gone-anchor check, and `skill_stale` once per skill for missing (a day) and unused. */
function staleChecks(ctx: GateCtx, cands: Candidate[], sent: Sent): (c: Candidate) => boolean {
  const { env, now } = ctx;
  for (const c of cands) {
    try {
      if (c.state && unusedSince(c.state, now) && markUnusedSaid(c.ref.id, env, now)) sent.push(['skill_stale', { reason: 'unused' }]);
    } catch { /* said next time */ }
  }
  return (c: Candidate) => {
    if (!ctx.checkout) return false;
    const gone = goneAnchors(c.skill, ctx.checkout, env).length > 0;
    try {
      if (gone && markMissingSaid(c.ref.id, env, now)) sent.push(['skill_stale', { reason: 'missing' }]);
    } catch { /* said next time */ }
    return gone;
  };
}

function inside(ctx: GateCtx, st: SkillSessionState, fold: FoldResult | null, source: string, cwd: string, probes: ProbeOpts, sent: Sent): HookOut {
  const { env, now } = ctx;
  // 3. The epoch. Read before anything is written: the stored file still has what came before this hook.
  const had = readJsonSafe<{ skills?: unknown }>(sessionPath(ctx.sessionId, '.json', env))?.skills != null;
  let openAtBoundary: string[] = [];
  let liveBefore: Set<string> | null = null;
  const closedNow: RunState[] = [...(fold?.closed ?? [])];
  if (source === 'compact' || (source === 'clear' && had)) {
    if (fold && fold.compactions > 0) {
      // The fold met the compaction line and bumped the epoch: the runs it cut are the closed epoch's last open ones.
      const last = [...st.runs].reverse().find((r) => r.epoch === st.epoch - 1);
      if (last && fold.closed.includes(last)) openAtBoundary = [last.id];
    } else {
      liveBefore = new Set(st.injected.filter((i) => i.live).map((i) => i.injId));
      // b2: repairs in the runs it closes read repo paths as ./ and the home as $HOME.
      const closed = cutAtCompaction(st, { home: env.HOME || undefined, root: ctx.checkout || undefined });
      closedNow.push(...closed);
      writeSheets(ctx, closed);
      openAtBoundary = closed.map((r) => r.id);
      st.epoch += 1;
      // A clear writes no compaction line, so the fold has nothing to skip (g3 open issue 4).
      st.pendingBoundary = source === 'compact';
    }
    if (st.pendingOffer && st.pendingOffer.shownAt === null) st.pendingOffer = null;
    for (const inj of st.injected) if (inj.epoch < st.epoch) inj.live = false;
  }
  // b7 review: an auto-compaction mid-turn closes the runs, and their calls go when this state is written, before any
  // Stop: the walls they hit are noted now, as Stop notes them (3.5 step 1; idempotent with the Stop that follows).
  if (ctx.learn && closedNow.some((r) => r.calls.some((c) => c.wall))) {
    try { wallsAtStop(st, ctx); } catch (e) { hookError('session-start', e, env); }
  }

  // D117 (4): the lesson index the wall fix reads, warm from the session's first command.
  refreshLessonIndex(ctx.repoKey, env);

  // 5. Scope keys: this repo, or the checkouts inside a folder that isn't one.
  const keys = ctx.repoKey ? [ctx.repoKey] : [];
  if (!ctx.checkout) {
    for (const p of childCheckouts(cwd).slice(0, MAX_CHILD_KEYS)) {
      const k = repoPlace(p, env).key;
      if (k && !keys.includes(k)) keys.push(k);
    }
  }
  st.scopeKeys = keys;

  // 6. The index line.
  const { cands, needsFix, adopted } = candidatesHere({ repoKeys: keys, checkout: ctx.checkout, env });
  // Phase 2 (4.6): a proposal the person copied over their file is Trail's own again.
  for (const _ of adopted) sent.push(['skill_changed', { op: 'adopted' }]);
  const context: string[] = [...SKILLS_INTRO];
  let gone: ((c: Candidate) => boolean) | undefined;
  try { gone = staleChecks(ctx, cands, sent); } catch (e) { hookError('session-start', e, env); }
  const index = indexLine(cands, needsFix, { now, gone });
  if (index) context.push(index);

  // Phase 2 (D137, 4.17): on Codex, why Trail only brings skills back here, once, in the intro (never after a compaction).
  if (ctx.host === 'codex' && source !== 'compact') {
    const why = ctx.learnOff === 'ephemeral' ? CODEX_COPY.ephemeral : ctx.learnOff === 'host' ? CODEX_COPY.notTierA : null;
    if (why) context.push(`[trail] ${why}`);
  }

  // 7. Held items, once each (interactive only), at a startup or resume of another session than the one that held
  // them (D93): a compaction or a clear of the holding session never spends the notice.
  let notice: string | undefined;
  if (ctx.entry === 'interactive' && (source === 'startup' || source === 'resume')) {
    const lines = heldLines(env, now, ctx.sessionHash);
    if (lines.length && hostFacts(env, ctx.host as Host).startNotice) notice = lines.join('\n');
    else for (const l of lines) context.push(heldContext(l));
  }

  // Phase 2 (3.1 step 3, 4.14, D134): the weekly value line, at a startup or resume only. `startValue` claims the week
  // under the lock, so two sessions that start together say it once (c5 review R1).
  try {
    const v = startValue({ source, learn: ctx.learn, subagent: ctx.subagent, host: ctx.host as Host, repoKey: ctx.repoKey }, env, now);
    if (v?.context) context.push(v.context);
    if (v?.notice) notice = notice ? `${notice}\n${v.notice}` : v.notice;
    if (v) sent.push(['skill_value', { channel: v.channel }]);
  } catch (e) { hookError('session-start', e, env); }

  // 8. The block a compaction cut short.
  if (source === 'compact') {
    const block = reinject(ctx, st, openAtBoundary, liveBefore, cands, probes);
    if (block) context.push(block);
    // 1b (3.1 step 9, R38): the fixes of the walls hit in the epoch just closed, at most 2.
    try { context.push(...compactWallLines(st, ctx)); } catch (e) { hookError('session-start', e, env); }
  }

  // 1b (3.1 step 10, J02 leg C): an init list still waiting for the person, handed over once.
  if (ctx.learn && ctx.repoKey) {
    const handover = initHandover(ctx.repoKey, { id: ctx.sessionId, transcriptPath: ctx.transcriptPath }, env, now);
    if (handover) context.push(handover);
  }

  trimInjected(st);
  syncGate(ctx, st);
  const out: HookOut = {};
  if (context.length) out.context = context.join('\n');
  if (notice) out.notice = notice;
  return out;
}

/** As the catch-up does for the runs it closes: a sheet for each with steps. */
function writeSheets(ctx: GateCtx, closed: RunState[]): void {
  for (const run of closed) {
    if (run.stepCalls <= 0 || !run.calls.length || run.sheet !== 'none') continue;
    try {
      writeRunSheet(run, checkedSuccess(run, null), { host: ctx.host, tier: ctx.tier, sessionHash: ctx.sessionHash, helpers: runHelpers(run) }, ctx.env);
    } catch {
      /* the calls stay, so the next catch-up writes it */
    }
  }
}

function heldLines(env: NodeJS.ProcessEnv, now: Date, sessionHash: string): string[] {
  const items = listHeld(env, now).filter((h) => h.shownAt === null && h.session !== sessionHash).slice(0, MAX_HELD_SHOWN);
  return items.map((h) => {
    markHeldShown(h.name, env, now);
    return heldLine(h);
  });
}

export function heldLine(h: Pick<HeldItem, 'name' | 'why' | 'host'>): string {
  const host = HOSTS[h.host] ?? 'Another agent';
  const name = flatLine(h.name, 60);
  return h.why === 'host'
    ? `trail: ${host} started a skill ${name} in your last session. Trail can't check which steps ran there, so it wasn't kept. Keep it: trail skills keep ${name}`
    : `trail: ${host} started a skill ${name} in your last session without your yes, so it wasn't kept. Keep it: trail skills keep ${name}`;
}

/**
 * A held item where the host shows no start notice (D101): from Trail, why the agent is the one to say it, and the
 * line for the person. No words of theirs to quote: nobody asked; the reason is Trail's own.
 */
export function heldContext(line: string): string {
  return `[trail] ${FROM_TRAIL} Trail held a skill from their last session instead of keeping it, and it can't show them a message in this app itself. `
    + `So they know, tell them once, at the start of your first reply: "${flatLine(line, 400).replace(/^trail: /, '')}"`;
}

const BLOCK_CUES = new Set<SkillInjection['cue']>(['job', 'name', 'compact']);

/** 3.1 step 8. */
function reinject(ctx: GateCtx, st: SkillSessionState, openAtBoundary: string[], liveBefore: Set<string> | null, cands: Candidate[], probes: ProbeOpts): string | null {
  const inj = [...st.injected].reverse().find((i) => i.epoch === st.epoch - 1 && BLOCK_CUES.has(i.cue));
  if (!inj || !inj.runId || !openAtBoundary.includes(inj.runId)) return null;
  if (liveBefore && !liveBefore.has(inj.injId)) return null;
  // Its check passed: by the credit already settled, or by the calls the boundary cut (no Stop may have run since).
  if (st.credit.some((c) => c.injId === inj.injId && c.check === 'passed')) return null;
  if (creditRun(inj, creditCalls(inj, st.runs, ctx.env)).check === 'passed') return null;
  const c = cands.find((x) => x.ref.id === inj.skillId);
  if (!c || refusedAtRecall(c.skill, inj.params)) return null;
  const results = runProbes(c.skill, ctx.checkout, ctx.now, ctx.env, probes);
  // Part 7: the same say of the person's learnings as the block it re-sends.
  const marks = recallMarks(c.skill.steps, stepLearnings({ repoKeys: st.scopeKeys, checkout: ctx.checkout, env: ctx.env }));
  const block = runBlock(c, { values: inj.params, notes: [], probes: results, canAsk: canAsk(ctx), header: 'compact', lastFail: null, marks });
  st.injected.push(withReadyFailed(injectionFor({ ...c, skill: withFixes(c.skill, marks) }, inj.params, 'compact', st.epoch, ctx.now), results));
  return block;
}
