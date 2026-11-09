/**
 * The fold plan (phase 2 design 4.2, spec 9 and 13, P1 to P11): moment 5's
 * one change to a skill, worked out from the skill as it is and the run that
 * just checked out. Update a step that failed and was done another way,
 * extend with at most 2 steps a lesson or 2 uses in a row back, split a
 * subset two uses ran into a skill of its own, or nothing.
 *
 * New step text only ever comes from a fresh compile of the run (P4): every
 * copy rule, the secret and risk checks and the 12-line cap stay in one
 * place. A fold can't add a param (P6) or a step that can't be undone (P7),
 * goes through the renderer on an exact round trip (P11), and passes the
 * size gate (4.3). Drift's replace (4.8) is a whole new version, not a fold.
 *
 * Pure: no disk, no clock. Phase 3 (N4) reads the change as text and a diff
 * through `foldDiff` and `driftDiff`.
 */
import { createHash } from 'node:crypto';
import type { CompiledSkill, FoldOp, ParsedSkill, SkillStep } from './types.js';
import type { SkillInjection } from '../trace/types.js';
import type { Lesson } from './lessons.js';
import type { Fidelity } from './fidelity.js';
import { programVerb } from './fidelity.js';
import { ranAs } from './ledger.js';
import { fillParams } from './params.js';
import { MAX_RUN_LINES, MAX_STEP_CHARS, gatedKind } from './risk.js';
import { parseSkillMd, renderSkillMd } from './skillmd.js';
import { refusedAtRecall } from './recall.js';
import { rebuildCompiled } from './skill-rebuild.js';
import { FOLD_MAX_CHARS, printDiff, sizeGate } from './skill-diff.js';
import { goodName } from './compile-words.js';
import { bareCommand, simpleCommands } from '../trace/shell.js';
import { sameGatedCommand } from './fold-gated.js';

export type FoldPlan =
  | { op: 'update'; step: number; cmd: SkillStep; why: 'failed-then-worked' }
  /**
   * Part 7: the block showed step `step` the way a live learning says (`follows`: whose, "your preference"), and it
   * worked; `more`: the other steps the same learning changed that ran that way too, changed with it.
   */
  | { op: 'update'; step: number; cmd: SkillStep; why: 'preference'; follows: string; more?: SkillStep[] }
  | { op: 'extend'; at: number; cmds: SkillStep[]; why: 'lesson' | 'two-uses'; lessonIds: string[] }
  | { op: 'split'; from: number; to: number; name: string }
  | { op: 'none'; why: FoldNone };
export type FoldNone = 'no-change' | 'compile' | 'too-big' | 'too-long' | 'risk' | 'new-param' | 'layout' | 'gated-new' | 'guardrail-lesson';

export interface FoldInput {
  skill: ParsedSkill; text: string;                 // the current file and its parse
  /** compileRun of this run's sheet (4.2 step 1); null when compile refused it. */
  fresh: CompiledSkill | null;
  fid: Fidelity; inj: Pick<SkillInjection, 'params'>;
  earlierExtraShas: string[][];                      // extraShas of the earlier uses in the ledger, newest last (at most 4 uses)
  lessons: Lesson[];                                 // unfolded lessons on the skill
  earlierRan: number[][];                            // stepsRan of the earlier uses, for split
  /** The earlier uses' checks, newest last, beside earlierRan: split needs the use before to have passed. Absent: no split. */
  earlierChecks?: Array<'passed' | 'failed' | 'none'>;
  /** The skill to fold: rebuildLoose of a hand-edited file (4.6). Absent: rebuildCompiled of `text`, or none 'layout'. */
  base?: CompiledSkill | null;
  /** Split's name, compile's proposeName for the fresh run made free (the caller has the sheet and the store). */
  splitName?: string;
  /** Whether a skill name is taken (the store's nameTaken): the split's name is never one (review). */
  taken?: (name: string) => boolean;
  /**
   * Part 7: steps the block showed the way a live learning says rather than as the skill has them (`cmd` with the
   * skill's params, `follows` whose learning it was). An update to that way is offered once it ran and checked out.
   */
  preferred?: Array<{ step: number; cmd: string; follows: string }>;
}

const MAX_EXTEND = 2;
const none = (why: FoldNone): FoldPlan => ({ op: 'none', why });
const intVersion = (c: CompiledSkill): number | null => (/^[1-9]\d{0,5}$/.test(String(c.meta.version ?? '')) ? Number(c.meta.version) : null);

/** A fresh step's values: its params as this run filled them (findParams keeps this run's value first). */
const freshValues = (fresh: CompiledSkill) => Object.fromEntries(fresh.params.filter((p) => p.seen[0] !== undefined).map((p) => [p.name, p.seen[0]!]));

/**
 * The fresh step in the skill's own params (P6): each `{p}` becomes the skill param with the same filled value, or keeps
 * its name when the skill has it and its value is a command (`$(git rev-parse HEAD)`) or unknown. null: a new param.
 */
function inSkillTerms(cmd: string, fresh: CompiledSkill, base: CompiledSkill, vals: Record<string, string>): string | null {
  const fv = freshValues(fresh);
  const names = new Set(base.params.map((p) => p.name));
  let bad = false;
  const out = cmd.replace(/\{([A-Za-z_]\w*)\}/g, (m, p: string) => {
    const v = fv[p];
    const same = v === undefined ? undefined : [...names].find((q) => vals[q] === v);
    if (same) return `{${same}}`;
    if (names.has(p) && (vals[p] === undefined || v === undefined || vals[p]!.startsWith('$('))) return m;
    bad = true;
    return m;
  });
  return bad ? null : out;
}

interface Cand { j: number; step: SkillStep; filled: string }

/** The candidate's source call is one this use ran and passed in its checkout: an extra or a changed step of fidelity. */
const passedHere = (c: Cand, fid: Fidelity) => [...fid.extra, ...fid.changed].some((x) => c.step.from?.includes(x.id));

/** 4.2 step 2: fresh steps that ran as no skill step (nor the skill's check) are the candidates. */
function candidates(base: CompiledSkill, fresh: CompiledSkill, vals: Record<string, string>): { cands: Cand[]; matched: number[] } {
  const fv = freshValues(fresh);
  const matched = fresh.steps.map((s) => {
    const filled = fillParams(s.cmd, fv);
    const k = base.steps.findIndex((b) => ranAs(b.cmd, filled, vals));
    return k + 1;
  });
  const cands = fresh.steps.flatMap((step, j) => {
    const filled = fillParams(step.cmd, fv);
    if (matched[j]! > 0 || (base.check && ranAs(base.check, filled, vals))) return [];
    return [{ j, step, filled }];
  });
  return { cands, matched };
}

/** The skill step a candidate goes after: from fidelity's extra step for its source call, else the steps matched before it. */
function afterOf(c: Cand, fid: Fidelity, matched: number[]): number {
  const e = fid.extra.find((x) => c.step.from?.includes(x.id));
  if (e) return e.after;
  return Math.max(0, ...matched.slice(0, c.j));
}

const lessonCommand = (l: Lesson) => {
  const at = String(l.text ?? '').indexOf(': ');
  return at < 0 ? '' : l.text.slice(at + 2).trim();
};

function planOf(i: FoldInput, base: CompiledSkill): FoldPlan {
  const fresh = i.fresh!;
  const vals = i.inj?.params ?? {};
  // P4, spec 13: a new step is one this use ran and passed, so only candidates fidelity counted (review).
  const { cands: all, matched } = candidates(base, fresh, vals);
  const cands = all.filter((c) => passedHere(c, i.fid));

  // Part 7: steps the block showed the person's way, that ran that way: the change is from the fresh compile (P4).
  const fv = freshValues(fresh);
  const changes: Array<{ cmd: SkillStep; follows: string }> = [];
  for (const p of i.preferred ?? []) {
    const old = base.steps[p.step - 1];
    if (!old || old.gated || !i.fid.ran.includes(p.step) || (changes.length && changes[0]!.follows !== p.follows)) continue;
    const hit = fresh.steps.find((s) => !s.gated && ranAs(fillParams(p.cmd, vals), fillParams(s.cmd, fv), vals));
    if (!hit) continue;
    const cmd = inSkillTerms(hit.cmd, fresh, base, vals);
    if (cmd === null) return none('new-param');
    if (cmd !== old.cmd) changes.push({ cmd: { ...old, cmd, n: p.step }, follows: p.follows });
  }
  if (changes.length) {
    const [first, ...rest] = changes.sort((a, b) => a.cmd.n - b.cmd.n);
    return { op: 'update', step: first!.cmd.n, cmd: first!.cmd, why: 'preference', follows: first!.follows, ...(rest.length ? { more: rest.map((c) => c.cmd) } : {}) };
  }

  // 3. update: a step that failed and was done another way, the same program and verb.
  for (const c of [...i.fid.changed].sort((a, b) => a.step - b.step)) {
    const old = base.steps[c.step - 1];
    if (!old) continue;
    const verb = programVerb(fillParams(old.cmd, vals));
    const hit = cands.find((x) => x.step.from?.includes(c.id)) ?? cands.find((x) => verb !== null && programVerb(x.filled) === verb);
    if (!hit) continue;
    const cmd = inSkillTerms(hit.step.cmd, fresh, base, vals);
    if (cmd === null) return none('new-param');
    if ((hit.step.gated ?? null) !== (old.gated ?? null)) return none('gated-new');
    // D138 (1): a gated step keeps its command; only its arguments may change (no force flag, no new shared branch).
    if (old.gated && !sameGatedCommand(fillParams(old.cmd, vals), hit.filled)) return none('gated-new');
    return { op: 'update', step: c.step, cmd: { ...hit.step, n: c.step, cmd }, why: 'failed-then-worked' };
  }

  // 4. extend: from a lesson the person kept on this skill, else the same extra step in the use before.
  const lessonIds = new Map<number, string[]>();
  for (const l of i.lessons ?? []) {
    const part = lessonCommand(l);
    if (!part) continue;
    for (const c of cands) {
      if (!ranAs(part, c.filled, vals)) continue;
      if (l.kind === 'guardrail') return none('guardrail-lesson');
      lessonIds.set(c.j, [...(lessonIds.get(c.j) ?? []), l.id]);
    }
  }
  let why: 'lesson' | 'two-uses' = 'lesson';
  let picked = cands.filter((c) => lessonIds.has(c.j));
  if (!picked.length) {
    const before = new Set(i.earlierExtraShas?.at(-1) ?? []);
    why = 'two-uses';
    picked = cands.filter((c) => i.fid.extra.some((e) => before.has(e.sha) && c.step.from?.includes(e.id)));
  }
  if (picked.length) {
    const at = afterOf(picked[0]!, i.fid, matched);
    const group = picked.filter((c) => afterOf(c, i.fid, matched) === at).slice(0, MAX_EXTEND);
    const cmds: SkillStep[] = [];
    for (const [k, c] of group.entries()) {
      if (c.step.gated || gatedKind(c.filled)) return none('gated-new');
      const cmd = inSkillTerms(c.step.cmd, fresh, base, vals);
      if (cmd === null) return none('new-param');
      cmds.push({ ...c.step, n: at + k + 1, cmd });
    }
    const ids = why === 'lesson' ? [...new Set(group.flatMap((c) => lessonIds.get(c.j) ?? []))] : [];
    return { op: 'extend', at, cmds, why, lessonIds: ids };
  }

  // 5. split: this use and the one before ran the same contiguous steps, 2 or more and fewer than all, both checked, no extras.
  const prevRan = i.earlierRan?.at(-1);
  if (prevRan && i.earlierChecks?.at(-1) === 'passed' && !i.fid.extra.length && !i.fid.changed.length && !(i.earlierExtraShas?.at(-1) ?? []).length) {
    const now = [...new Set(i.fid.ran)].sort((a, b) => a - b);
    const prev = [...new Set(prevRan)].sort((a, b) => a - b);
    const contiguous = now.every((n, k) => k === 0 || n === now[k - 1]! + 1);
    if (now.length >= 2 && now.length < base.steps.length && contiguous && now.join() === prev.join()) {
      const name = splitNameFor(i, base);
      if (name) return { op: 'split', from: now[0]!, to: now.at(-1)!, name };
    }
  }
  return none('no-change');
}

/** A good name no other skill has; null when none is found (review: a hand-edited name is no base for a folder). */
function splitNameFor(i: FoldInput, base: CompiledSkill): string | null {
  const free = (n: string) => goodName(n) && n !== base.name && !(i.taken?.(n) ?? false);
  if (i.splitName && free(i.splitName)) return i.splitName;
  const stem = goodName(base.name) ? base.name : i.fresh && goodName(i.fresh.name) ? i.fresh.name : 'split';
  for (let n = 2; n < 100; n++) {
    const name = `${stem.slice(0, 44).replace(/-+$/, '')}-${n}`;
    if (free(name) && name !== i.fresh?.name) return name;
  }
  return null;
}

/** The base to fold: the caller's, else the file rebuilt on an exact round trip. */
const baseFor = (i: FoldInput) => i.base ?? rebuildCompiled(i.text, i.skill, { source: null, helpers: [] });

/** 4.2: the plan, its result checked (4.2 step 7) and through the size gate (4.3). Never throws. */
export function planFold(i: FoldInput): FoldPlan {
  try {
    if (!i.fresh || !i.fresh.steps?.length) return none('compile');
    const base = baseFor(i);
    if (!base || intVersion(base) === null) return none('layout');
    const plan = planOf(i, base);
    if (plan.op !== 'update' && plan.op !== 'extend') return plan;
    const next = applyWhy(base, plan);
    if ('why' in next) return none(next.why);
    // Part 7: a change to follow a learning swaps a program in the steps it names and nothing else, so on a small skill
    // it can touch most of the file; only the size in characters holds it back.
    const size = sizeGate(renderSkillMd(base), renderSkillMd(next.skill));
    if (!(plan.op === 'update' && plan.why === 'preference' ? size.chars <= FOLD_MAX_CHARS : size.ok)) return none('too-big');
    return plan;
  } catch {
    return none('no-change');
  }
}

/* -------------------------------------------------------------- applying */

/** Words compile never lists as a need (compile.ts NOT_NEEDS), plus a wait loop's own words. */
const NOT_NEEDS = new Set(['cd', 'export', 'source', 'echo', 'printf', 'sleep', 'true', 'false', 'pwd', 'set', 'unset', 'alias', 'wait', 'exit', 'return', 'test', 'until', 'while', 'if', 'for', 'do', 'done', 'then', 'fi', 'eval', 'exec', 'read', 'local', 'shift', 'trap', 'cat', 'ls', 'head', 'tail', 'grep', 'break']);
const MAX_NEEDS = 6;

/** The programs a step needs, as compile reads them (its folder taken off). */
function needsOf(cmd: string): string[] {
  const core = /^\(cd \S+ && (.*)\)$/.exec(cmd)?.[1] ?? cmd;
  const out: string[] = [];
  for (const simple of simpleCommands(core)) {
    const w = bareCommand(simple).split(/\s+/)[0] ?? '';
    if (/^[A-Za-z][\w.+-]*$/.test(w) && !NOT_NEEDS.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** `needs` after a change: what a removed step alone needed goes, what a new step needs is added, at most 6. */
function needsAfter(base: CompiledSkill, steps: SkillStep[], check: string): string | undefined {
  const had = String(base.meta.needs ?? '').split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  const used = new Set([...steps.map((s) => s.cmd), ...(check ? [check] : [])].flatMap(needsOf));
  const before = new Set([...base.steps.map((s) => s.cmd), ...(base.check ? [base.check] : [])].flatMap(needsOf));
  const kept = had.filter((p) => used.has(p) || !before.has(p));
  for (const p of used) if (!kept.includes(p) && !before.has(p)) kept.push(p);
  return kept.length ? kept.slice(0, MAX_NEEDS).join(', ') : undefined;
}

type Applied = { skill: CompiledSkill } | { why: FoldNone };

function applyWhy(base: CompiledSkill, plan: Exclude<FoldPlan, { op: 'none' | 'split' }>): Applied {
  const v = intVersion(base);
  if (v === null) return { why: 'layout' };
  let steps = base.steps.map((s) => ({ ...s }));
  let check = base.check;
  if (plan.op === 'update') {
    const old = steps[plan.step - 1];
    if (!old || !plan.cmd?.cmd) return { why: 'layout' };
    for (const next of [plan.cmd, ...(plan.why === 'preference' ? plan.more ?? [] : [])]) {
      const was = steps[next.n - 1];
      if (!was) return { why: 'layout' };
      if (base.checkIsStep && was.cmd === base.check) check = next.cmd;
      steps[next.n - 1] = { ...next };
    }
  } else {
    if (!Number.isInteger(plan.at) || plan.at < 0 || plan.at > steps.length || !plan.cmds?.length) return { why: 'layout' };
    steps.splice(plan.at, 0, ...plan.cmds.map((s) => ({ ...s })));
  }
  steps = steps.map((s, k) => ({ ...s, n: k + 1 }));
  if (steps.length > MAX_RUN_LINES || steps.some((s) => s.cmd.length > MAX_STEP_CHARS)) return { why: 'too-long' };
  if (steps.some((s) => !s.gated && gatedKind(s.cmd) !== null)) return { why: 'risk' };

  const meta = { ...base.meta, version: String(v + 1) };
  const gated = steps.filter((s) => s.gated).map((s) => s.cmd);
  if (gated.length) meta['confirm-before'] = gated.join(' ; ');
  else delete meta['confirm-before'];
  const needs = needsAfter(base, steps, check);
  if (needs) meta.needs = needs;
  else delete meta.needs;
  if (check !== base.check && meta.check !== undefined) meta.check = check;
  // Compile's "what worked was step N." ends the line and names a step by its number: it follows the renumber. Only
  // the one at the end: the quoted error before it is a command's output and may say anything (review).
  const [at, shift] = plan.op === 'extend' ? [plan.at, plan.cmds.length] : [0, 0];
  const ifFails = base.ifFails.map((l) => l.replace(/\bwhat worked was step (\d+)\.$/, (m, n: string) => (shift && Number(n) > at ? `what worked was step ${Number(n) + shift}.` : m)));
  const skill: CompiledSkill = { ...base, meta, steps, check, ifFails };

  const parsed = parseSkillMd(renderSkillMd(skill), skill.name);
  if (!parsed || parsed.steps.length !== steps.length) return { why: 'layout' };
  if (refusedAtRecall(parsed) !== null) return { why: 'risk' };
  return { skill };
}

/** The plan applied: the new CompiledSkill (version bumped), or null when a check after the edit refuses it. */
export function applyFold(base: CompiledSkill, plan: Exclude<FoldPlan, { op: 'none' | 'split' }>): CompiledSkill | null {
  try {
    const r = applyWhy(base, plan);
    return 'skill' in r ? r.skill : null;
  } catch {
    return null;
  }
}

/** Drift (4.8, P17): the new version from the run, keeping the skill's id, name, scope, applies, job and asks. */
export function replaceWith(base: CompiledSkill, fresh: CompiledSkill): CompiledSkill {
  const v = intVersion(base) ?? 1;
  const meta = { ...fresh.meta, trail: base.meta.trail, scope: base.meta.scope, asks: base.meta.asks, version: String(v + 1) };
  for (const k of ['applies', 'job', 'status-asks'] as const) {
    if (base.meta[k] === undefined) delete meta[k];
    else (meta as Record<string, unknown>)[k] = base.meta[k];
  }
  return { ...fresh, name: base.name, meta };
}

/* -------------------------------------------------------------- phase 3 (N4) */

const labels = (base: CompiledSkill, to: number): [string, string] => [`${base.name}/SKILL.md v${base.meta.version}`, `${base.name}/SKILL.md v${to}`];

/** The fresh compile as the split's own skill: its name, an id of its own, version 1. */
function splitSkill(base: CompiledSkill, fresh: CompiledSkill, name: string): CompiledSkill {
  const id = `s-${createHash('sha256').update(`${base.meta.trail}|${name}`).digest('hex').slice(0, 6)}`;
  return { ...fresh, name, meta: { ...fresh.meta, trail: id, version: '1' } };
}

/** Phase 3's N4: the change as text and a printed diff, from inputs only (no disk). `op: 'none'` gives text equal to the input. */
export function foldDiff(i: FoldInput, base: CompiledSkill): { text: string; diff: string; op: FoldOp | 'none'; why?: FoldNone } {
  const plan = planFold({ ...i, base });
  if (plan.op === 'none') return { text: i.text, diff: '', op: 'none', why: plan.why };
  if (plan.op === 'split') {
    const text = renderSkillMd(splitSkill(base, i.fresh!, plan.name));
    return { text, diff: printDiff('', text, ['/dev/null', `${plan.name}/SKILL.md v1`]), op: 'split' };
  }
  const next = applyFold(base, plan);
  if (!next) return { text: i.text, diff: '', op: 'none', why: 'layout' };
  const text = renderSkillMd(next);
  return { text, diff: printDiff(i.text, text, labels(base, Number(next.meta.version))), op: plan.op };
}

/** Phase 3's N4 for drift: the whole new version and its diff against the skill as Trail reads it. */
export function driftDiff(base: CompiledSkill, fresh: CompiledSkill): { text: string; diff: string; op: 'replace' } {
  const next = replaceWith(base, fresh);
  const text = renderSkillMd(next);
  return { text, diff: printDiff(renderSkillMd(base), text, labels(base, Number(next.meta.version))), op: 'replace' };
}
