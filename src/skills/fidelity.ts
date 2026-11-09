/**
 * Next-run fidelity (phase 2 design 4.1, spec 24, P2, P3): what a run a
 * skill's block drove did against the skill's steps. Which steps ran (the
 * same set credit gives), which failed and were then done another way that
 * passed, which passing steps of the job the skill lacks, and which steps
 * neither ran nor failed.
 *
 * Computed at each credit flush from the calls and filled params credit uses,
 * so a use and its fidelity agree. Counts, step numbers and 8-hex shas of a
 * compiled command only reach the use line: never a command or a prompt.
 * Fidelity never changes a use's outcome or a skill's status (P3).
 *
 * Pure: no disk, no clock.
 */
import { createHash } from 'node:crypto';
import type { RunCall, SkillInjection } from '../trace/types.js';
import type { FidelityCounts, ParsedSkill } from './types.js';
import { callText } from '../trace/checks.js';
import { envPrefix, normalizeCommand, programOf, relativizePaths } from '../trace/shell.js';
import { ranAs } from './ledger.js';
import { fillParams } from './params.js';
import { doesLess, onlyRehearsed } from './ran-less.js';

/** after: the last skill step matched by a call before it (0: before step 1). id: the call's tool_use id. */
export interface ExtraStep { callIx: number; after: number; sha: string; id: string }
/** callIx and id: the passing call that did step `step` another way. */
export interface ChangedStep { step: number; callIx: number; id: string }
export interface Fidelity { ran: number[]; missing: number[]; extra: ExtraStep[]; changed: ChangedStep[] }

/** Where the run was: the checkout's key (else the key of the calls that ran its steps), and the paths extraKey puts back. */
export interface FidelityWhere { repoKey?: string | null; repoRoot?: string; home?: string }

/** Credit's slack before a block's `at` (ledger.ts SLACK_MS): the same calls count for both. */
const SLACK_MS = 5000;

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Filled values of 2+ characters back to `{name}`, longest first, never inside a longer word or number. */
function putBack(text: string, params: Record<string, string>): string {
  const pairs = Object.entries(params ?? {})
    .filter(([, v]) => typeof v === 'string' && v.length >= 2 && !v.startsWith('$('))
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, v] of pairs) out = out.replace(new RegExp(`(?<![0-9A-Za-z_.])v?${escapeRe(v)}(?![0-9A-Za-z_])`, 'g'), (m) => (m.startsWith('v') && !v.startsWith('v') ? `v{${name}}` : `{${name}}`));
  return out;
}

/**
 * R10: the one key for an extra step, at the flush and in planFold. 8 hex of sha256 of the call's stored text with repo
 * and home paths put back (`where`), the filled values put back as `{name}`, normalised: the same command in two
 * releases of two versions gives one key.
 */
export function extraKey(call: RunCall, params: Record<string, string>, where?: { repoRoot?: string; home?: string }): string {
  const rel = relativizePaths(callText(call), where?.repoRoot ?? '', where?.home ?? '');
  return createHash('sha256').update(normalizeCommand(putBack(rel, params))).digest('hex').slice(0, 8);
}

/** A command's program key and verb: `npm publish`, `git push` (the first word after the program that isn't a flag). */
export function programVerb(cmd: string): string | null {
  const prog = programOf(cmd);
  if (!prog) return null;
  const words = envPrefix(normalizeCommand(cmd).replace(/^\(+/, '')).rest.split(/\s+/);
  const at = words.findIndex((w) => w === prog || w.endsWith(`/${prog}`));
  if (at < 0) return prog.toLowerCase();
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i]!;
    if (prog === 'git' && /^-[Cc]$/.test(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    return `${prog.toLowerCase()} ${w}`;
  }
  return prog.toLowerCase();
}

const steps1 = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** 4.1. `inj` gives the filled params (and `at`, as credit reads it); `calls` are the use's run sheet calls. Never throws. */
export function fidelityOf(
  skill: Pick<ParsedSkill, 'steps' | 'check' | 'params'>,
  inj: Pick<SkillInjection, 'params' | 'steps'> & Partial<Pick<SkillInjection, 'at' | 'check' | 'handed'>>,
  calls: RunCall[],
  where: FidelityWhere = {},
): Fidelity {
  const count = Array.isArray(skill?.steps) ? skill.steps.length : 0;
  try {
    const params = inj.params ?? {};
    const steps = Array.isArray(inj.steps) && inj.steps.length === count ? inj.steps : skill.steps.map((s) => fillParams(s.cmd, params));
    const check = inj.check ?? (skill.check ? fillParams(skill.check, params) : null);
    const from = inj.at ? Date.parse(inj.at) : NaN;
    const list = calls
      .map((c, ix) => ({ c, ix }))
      .filter(({ c }) => typeof c.tool !== 'string' && (Number.isNaN(from) || Date.parse(c.at) >= from - SLACK_MS));

    // Credit's own reading: each call goes to the first step it matches; a step's last outcome wins.
    const text = list.map(({ c }) => callText(c));
    const match = text.map((t) => (t ? steps.findIndex((s) => ranAs(s, t, params)) : -1));
    const last = new Map<number, boolean>();
    const firstFail = new Map<number, number>();
    // D137: as credit reads it, a gated step handed to the person ran (theirs to run), and its denied call is no failure.
    const handed = new Set((inj.handed ?? []).map((h) => h.n).filter((n) => Number.isInteger(n) && n >= 1 && n <= count));
    for (const n of handed) last.set(n, true);
    match.forEach((i, p) => {
      if (i < 0) return;
      const ok = !list[p]!.c.failed || handed.has(i + 1);
      last.set(i + 1, ok);
      if (!ok && !firstFail.has(i + 1)) firstFail.set(i + 1, p);
    });
    const ran = [...last].filter(([, ok]) => ok).map(([n]) => n).sort((a, b) => a - b);

    const key = where.repoKey ?? list.find((_, p) => match[p]! >= 0)?.c.key ?? null;
    const inside = (c: RunCall) => c.cwd !== null && (key === null || c.key === key);
    const isCheck = (t: string) => !!check && ranAs(check, t, params);
    // Passed: not failed, and a result came (its line, or a PostToolUse mark). A call whose result never came
    // (killed, still running, a host that never wrote it) never passed, whatever `failed` starts as (review).
    const passed = (c: RunCall) => !c.failed && (c.src?.result != null || c.fromMark === true);
    const loose = (p: number) => {
      const c = list[p]!.c;
      return passed(c) && c.kind === 'step' && match[p]! < 0 && !!text[p] && inside(c) && !isCheck(text[p]!) && !onlyRehearsed(text[p]!);
    };

    // A step that failed, then a passing call of the same program and verb that is no step: done another way.
    const used = new Set<number>();
    const changed: ChangedStep[] = [];
    for (const [n, f] of [...firstFail].sort((a, b) => a[0] - b[0])) {
      const verb = programVerb(steps[n - 1]!);
      if (!verb) continue;
      for (let p = f + 1; p < list.length; p++) {
        if (used.has(p) || !loose(p) || programVerb(text[p]!) !== verb || doesLess(steps[n - 1]!, text[p]!)) continue;
        used.add(p);
        changed.push({ step: n, callIx: list[p]!.ix, id: list[p]!.c.id });
        break;
      }
    }

    const extra: ExtraStep[] = [];
    let after = 0;
    list.forEach(({ c, ix }, p) => {
      if (!used.has(p) && loose(p)) extra.push({ callIx: ix, after, sha: extraKey(c, params, where), id: c.id });
      if (match[p]! >= 0) after = Math.max(after, match[p]! + 1);
    });

    const isTheCheck = (n: number) => !!check && normalizeCommand(steps[n - 1]!) === normalizeCommand(check);
    const missing = steps1(count).filter((n) => !last.has(n) && !isTheCheck(n));
    return { ran, missing, extra, changed };
  } catch {
    return { ran: [], missing: steps1(count), extra: [], changed: [] };
  }
}

export function fidelityCounts(f: Fidelity): FidelityCounts {
  return { ran: f.ran.length, missing: f.missing.length, extra: f.extra.length, changed: f.changed.length };
}
