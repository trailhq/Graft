/**
 * The change a moment 5 or 6 offer shows, worked out again from disk
 * (phase 2 design 4.11, R14): the run sheet, the skill file as it is now, its
 * unfolded lessons, and the ledger uses from before that run started (never
 * later ones, so a use another session flushed since can't move the plan).
 * One builder (`foldInputFor`) and one plan (`replan`) serve the offer at
 * Stop (c3, through `OfferInput.plan`), both halves of the update gate and
 * `trail skills draft --print`, so they can't disagree: the offer pins the
 * `proposalSha` and `baseHash` this returns, and the gate writes only when
 * they come out the same again.
 *
 * Re-exported from `update-gate.ts`, where the design names `replan`.
 * Loaded only on the update paths, never on the PreToolUse fast path.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompiledSkill, FoldOp, LedgerUse, SkillRef, SkillState } from './types.js';
import type { RunSheet, SkillInjection, SkillSessionState } from '../trace/types.js';
import { joinCarriedSheet, readRunSheet } from '../trace/runs.js';
import { readJsonSafe, trailPath } from '../util/private-fs.js';
import { compileRun, proposeName } from './compile.js';
import { fidelityOf } from './fidelity.js';
import { fidelityWhere } from './credit-facts.js';
import { applyFold, planFold, replaceWith, type FoldInput, type FoldPlan } from './fold.js';
import { readLedger } from './ledger.js';
import { readLessons } from './lessons.js';
import { runCheckout } from './run-checkout.js';
import { rebuildCompiled, rebuildLoose } from './skill-rebuild.js';
import { parseSkillMd, renderSkillMd, skillHash } from './skillmd.js';
import { getSkillState } from './state.js';
import { listAllPersonal, nameTaken } from './store.js';
import { MAX_SKILL_BYTES } from './store-fs.js';
import { nextVersion } from './versions.js';
import { fillParams } from './params.js';
import { recallMarks, stepLearnings, whose } from './follow-learnings.js';

export type PlanInj = Pick<SkillInjection, 'params' | 'steps' | 'at' | 'check'>;
/** `inj`: the block's injection (Stop passes the live one); else it is found in `st`, else in the run's session file. */
export interface PlanOpts { inj?: PlanInj; st?: SkillSessionState | null; now?: Date }

export interface Replanned {
  next: CompiledSkill;
  text: string;
  /** 16 hex of sha256 of `text` (4.7). */
  proposalSha: string;
  /** `skillHash` of the file the plan was computed from. */
  baseHash: string;
  /** That file's text, for the printed diff (`draft --print`). */
  current: string;
  /** The file isn't what Trail last wrote: the change goes beside it (4.6). */
  handEdited: boolean;
  /** The fold plan; null for drift's replace. */
  plan: Extract<FoldPlan, { op: 'update' | 'extend' }> | null;
  base: CompiledSkill;
  fresh: CompiledSkill | null;
}

interface Gathered { input: FoldInput; ref: SkillRef; state: SkillState | null; text: string; sheet: RunSheet; handEdited: boolean }

const MAX_EARLIER = 4;
const SESSION_FILES = 64;
const SESSION_MAX_BYTES = 8 * 1024 * 1024;

/** The file's text when it is a regular file of at most 64 KB and neither it nor its folder is a link. */
function ownText(ref: SkillRef): string | null {
  try {
    if (lstatSync(ref.dir).isSymbolicLink()) return null;
    const s = lstatSync(ref.file);
    if (!s.isFile() || s.size > MAX_SKILL_BYTES) return null;
    return readFileSync(ref.file, 'utf8');
  } catch {
    return null;
  }
}

/** The helper file names in scripts/ (a rebuilt skill names them; a fold never writes them). */
function scriptNames(dir: string): string[] {
  try {
    if (!lstatSync(join(dir, 'scripts')).isDirectory()) return [];
    return readdirSync(join(dir, 'scripts')).filter((n) => !n.startsWith('.') && lstatSync(join(dir, 'scripts', n)).isFile()).sort();
  } catch {
    return [];
  }
}

/**
 * The block as credit read it (`settleCredit`, and c3's offer at Stop): the newest injection of this skill for the
 * job's runs (the run and the parts a compaction joined into it) gives the params, steps and check, the oldest its
 * `at`, so the fidelity window and so the plan come out the same at Stop, in PreToolUse and in the CLI.
 */
function injIn(st: SkillSessionState | null | undefined, skillId: string, runIds: string[]): PlanInj | null {
  const all = Array.isArray(st?.injected) ? st!.injected : [];
  const mine = all.filter((i) => i && i.skillId === skillId && i.runId !== null && runIds.includes(i.runId) && i.cue !== 'check')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!mine.length) return null;
  const newest = mine[mine.length - 1]!;
  return { params: newest.params, steps: newest.steps, check: newest.check, at: mine[0]!.at };
}

/** The run's own session file (its `skills.sessionHash` is the sheet's), among the 64 newest: for draft, which has no session. */
export function sessionOf(sheet: RunSheet, env: NodeJS.ProcessEnv): SkillSessionState | null {
  const dir = trailPath(env, 'sessions');
  let names: Array<{ n: string; t: number }>;
  try {
    names = readdirSync(dir).filter((n) => /^[\w.-]+\.json$/.test(n) && !/\.(?:hooks|gate|lesson|update)\.json$/.test(n)).flatMap((n) => {
      const s = lstatSync(join(dir, n));
      return s.isFile() && s.size <= SESSION_MAX_BYTES ? [{ n, t: s.mtimeMs }] : [];
    });
  } catch {
    return null;
  }
  for (const { n } of names.sort((a, b) => b.t - a.t).slice(0, SESSION_FILES)) {
    const st = readJsonSafe<{ skills?: SkillSessionState }>(join(dir, n))?.skills;
    if (st && typeof st === 'object' && st.sessionHash === sheet.session) return st;
  }
  return null;
}

function gather(skillId: string, runId: string, env: NodeJS.ProcessEnv, o: PlanOpts, needInj: boolean): Gathered | null {
  const ref = listAllPersonal(env).find((r) => r.id === skillId);
  if (!ref || ref.scope !== 'personal') return null;
  const text = ownText(ref);
  const skill = text === null ? null : parseSkillMd(text, ref.name);
  if (text === null || !skill || skill.meta.trail !== skillId) return null;
  const sheet = readRunSheet(runId, env);
  if (!sheet) return null;
  const read = (id: string) => readRunSheet(id, env);
  const joined = joinCarriedSheet(sheet, read);
  const ids = [...new Set([runId, ...(joined.joined ?? []).map((j) => j.id)])];
  const inj = o.inj ?? injIn(o.st, skillId, ids) ?? (needInj ? injIn(sessionOf(sheet, env), skillId, ids) : null);
  if (needInj && !inj) return null;
  const home = env.HOME || homedir();
  const repoRoot = runCheckout(joined, env, '');
  // c3's credit flush keys extraShas with the same `where` (one function for both), or two-uses never matches (R10).
  const fid = fidelityOf(skill, inj ?? { params: {}, steps: [] }, joined.calls, fidelityWhere(joined, env));
  const scope = { repoKeys: [sheet.repoKey], checkout: repoRoot, env };
  const c = compileRun(sheet, {
    repoRoot, home, platform: process.platform, prior: null, name: ref.name, moment: 'repeated',
    applies: skill.meta.applies ?? sheet.repoKey, taken: () => false, id: skillId, readSheet: read,
  });
  const fresh = c.ok ? c.skill : null;
  // R14: the uses before this run started, newest last.
  const started = Date.parse(sheet.startedAt);
  const earlier = readLedger(skillId, env).filter((l): l is LedgerUse => l.event === 'use' && Date.parse(l.at) < started).slice(-MAX_EARLIER);
  const state = getSkillState(skillId, env);
  const hash = skillHash(text);
  const handEdited = !state || (hash !== state.hash && hash !== state.pendingWrite?.hash);
  const base = handEdited ? rebuildLoose(text, skill)
    : rebuildCompiled(text, skill, { source: state.source, helpers: scriptNames(ref.dir), runId: state.runId });
  let splitName: string | undefined;
  try {
    if (fresh) splitName = proposeName(sheet, fresh.steps, (n) => nameTaken(n, scope) !== null);
  } catch { /* no split name: no split */ }
  // Part 7: the steps the block showed the way a live learning says, as it showed them (the injection's steps).
  const preferred = inj ? recallMarks(skill.steps, stepLearnings({ repoKeys: [sheet.repoKey], checkout: repoRoot, env })).flatMap((m) =>
    [...m.fixes].flatMap(([step, cmd]) => (cmd && inj.steps?.[step - 1] === fillParams(cmd, inj.params ?? {}) ? [{ step, cmd, follows: whose(m.l) }] : []))) : [];
  const input: FoldInput = {
    skill, text, fresh, fid, inj: { params: inj?.params ?? {} }, taken: (n) => nameTaken(n, scope) !== null, ...(preferred.length ? { preferred } : {}),
    earlierExtraShas: earlier.map((u) => u.extraShas ?? []), lessons: readLessons(ref.dir),
    earlierRan: earlier.map((u) => u.stepsRan), earlierChecks: earlier.map((u) => u.check), base, ...(splitName ? { splitName } : {}),
  };
  return { input, ref, state, text, sheet, handEdited };
}

/** The fold input for one checked use of the skill (4.2), from disk; null when the skill, the run or its block is gone. */
export function foldInputFor(skillId: string, runId: string, env: NodeJS.ProcessEnv = process.env, o: PlanOpts = {}): FoldInput | null {
  try {
    return gather(skillId, runId, env, o, true)?.input ?? null;
  } catch {
    return null;
  }
}

export const proposalShaOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/**
 * The change again, from the run sheet and the file as they are now (4.11 step 6). Update and extend: `planFold`
 * must give that same op. Replace (drift): the fresh compile as the next version, keeping the skill's id, name and
 * asks. The next version is numbered past every kept one, as the write numbers it. null: nothing to change.
 */
export function replan(skillId: string, runId: string, op: FoldOp | 'replace', env: NodeJS.ProcessEnv = process.env, o: PlanOpts = {}): Replanned | null {
  try {
    if (op === 'split') return null;
    const g = gather(skillId, runId, env, o, op !== 'replace');
    const base = g?.input.base ?? null;
    if (!g || !base || !/^[1-9]\d{0,5}$/.test(String(base.meta.version))) return null;
    let next: CompiledSkill | null;
    let plan: Replanned['plan'] = null;
    if (op === 'replace') {
      if (!g.input.fresh) return null;
      next = replaceWith(base, g.input.fresh);
    } else {
      const p = planFold(g.input);
      if (p.op !== op) return null;
      plan = p as Replanned['plan'];
      next = applyFold(base, plan!);
    }
    if (!next) return null;
    const version = String(nextVersion(g.ref, Number(base.meta.version)));
    next = { ...next, meta: { ...next.meta, version } };
    const text = renderSkillMd(next);
    return { next, text, proposalSha: proposalShaOf(text), baseHash: skillHash(g.text), current: g.text, handEdited: g.handEdited, plan, base, fresh: g.input.fresh };
  } catch {
    return null;
  }
}
