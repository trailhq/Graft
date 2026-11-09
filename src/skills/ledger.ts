/**
 * A skill's ledger (`~/.trail/ledger/<skill-id>.jsonl`, design 2.6): one line
 * per event (saved, used, corrected, status changed), kept for good. It holds
 * counts and labels only: which steps ran, which failed, whether the check
 * passed, how many commands, the forms of the ready probes that failed; never
 * a command, a probe's text, a prompt or an output. Each
 * event's known fields are all that is ever written, so a caller that hands
 * over more can't leak it.
 *
 * And credit (4.8): from the commands that ran after a run block came in,
 * which of the skill's steps ran and worked, the step that failed, and
 * whether its check passed. Pure: the calls come from the session state, or,
 * for a run whose calls the session no longer holds (closed, its sheet
 * written: D57), from its run sheet (`creditCalls`).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CreditState, RunCall, RunState, SkillInjection } from '../trace/types.js';
import type { LedgerLine } from './types.js';
import { appendPrivateLine, trailPath } from '../util/private-fs.js';
import { flatLine } from '../notes/flatten.js';
import { stepMatches } from '../trace/shell.js';
import { callText, hasVersion, HEAD_SHA } from '../trace/checks.js';
import { readRunSheet } from '../trace/run-sheets.js';
import { joinCarriedSheet } from '../trace/run-join.js';
import { ownFolder } from './own-folder.js';
import { doesLess } from './ran-less.js';
import { dirname } from 'node:path';

/** A skill id as a file name: what Trail writes is 's-' and 6 hex; a hand-edited SKILL.md can say anything. */
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A call at most this long before a block's `at` belongs to it (the fold's own slack for the typed line, 4.1). */
const SLACK_MS = 5000;
/** A deploy status read over MCP (D59b, `RunCall.tool`): no command, never a step, not a Bash call. */
const isToolCall = (c: RunCall) => typeof c.tool === 'string';

export function ledgerPath(skillId: string, env?: NodeJS.ProcessEnv): string {
  if (!SKILL_ID.test(String(skillId))) throw new Error(`trail: not a skill id: ${flatLine(skillId, 40)}`);
  return trailPath(env, 'ledger', `${skillId}.jsonl`);
}

const str = (v: unknown, max: number) => flatLine(v, max);
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
const steps = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0).slice(0, 50) : []);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);

/** The forms a ready probe takes (4.5 step 11). The ledger keeps the form, never the probe's text. */
export const PROBE_FORMS = ['clean', 'on-branch', 'program', 'path', 'ref', 'other'] as const;
export type ProbeForm = (typeof PROBE_FORMS)[number];

/** A ready probe's form: `git status --porcelain` is clean, `... = <branch>` on-branch, and so on. A form stays itself. */
export function probeForm(probe: string): ProbeForm {
  const p = String(probe ?? '').trim();
  if ((PROBE_FORMS as readonly string[]).includes(p)) return p as ProbeForm;
  if (/^git status --porcelain$/.test(p)) return 'clean';
  if (/^git rev-parse --abbrev-ref HEAD = \S+$/.test(p)) return 'on-branch';
  if (/^command -v \S+$/.test(p)) return 'program';
  if (/^(?:test -[SfdeE] \S+|\[ -S \S+ \])$/.test(p)) return 'path';
  if (/^git rev-parse --verify \S+$/.test(p)) return 'ref';
  return 'other';
}
const forms = (v: unknown): ProbeForm[] =>
  [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map(probeForm))];

const LESSON_ID = /^(?:ls-[0-9a-f]{6}|l-[0-9a-f]{6,16})$/;

/**
 * Phase 2 (2.3, 4.1): a use line's fidelity facts, only when the caller gave them, so a 1b use line is written byte
 * for byte as before. Counts, 8-hex shas (at most 4) and step numbers (at most 4); never a command.
 */
function useFacts(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.fid && typeof r.fid === 'object' && !Array.isArray(r.fid)) {
    const f = r.fid as Record<string, unknown>;
    out.fid = { ran: count(f.ran), missing: count(f.missing), extra: count(f.extra), changed: count(f.changed) };
  }
  if (Array.isArray(r.extraShas)) out.extraShas = r.extraShas.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{8}$/.test(x)).slice(0, 4);
  if (Array.isArray(r.changedSteps)) out.changedSteps = steps(r.changedSteps).slice(0, 4);
  if (Array.isArray(r.handed)) out.handed = steps(r.handed).slice(0, 8);
  return out;
}

/** The line as 2.6 writes it: its event's fields, in order, and nothing else. Throws on an unknown event. */
function shape(skillId: string, l: LedgerLine): Record<string, unknown> {
  const r = l as unknown as Record<string, unknown>;
  const at = str(r.at, 40);
  switch (r.event) {
    case 'saved': {
      const rc = (r.receipt && typeof r.receipt === 'object' ? r.receipt : {}) as Record<string, unknown>;
      return {
        at, event: 'saved', skill: skillId, v: str(r.v, 10), from: oneOf(r.from, ['init', 'repeated', 'repaired', 'asked'] as const, 'asked'),
        scope: oneOf(r.scope, ['personal', 'repo', 'team'] as const, 'personal'),
        receipt: { consent: oneOf(rc.consent, ['offer-yes', 'asked', 'init'] as const, 'asked'), stepsVerified: count(rc.stepsVerified), stepsTotal: count(rc.stepsTotal) },
      };
    }
    case 'use':
      return {
        at, event: 'use', useId: str(r.useId, 20), skill: skillId, v: str(r.v, 10), host: str(r.host, 20),
        cue: oneOf(r.cue, ['job', 'name', 'compact', 'run'] as const, 'job'), repo: str(r.repo, 200), stepsRan: steps(r.stepsRan),
        failedStep: typeof r.failedStep === 'number' && Number.isInteger(r.failedStep) && r.failedStep > 0 ? r.failedStep : null,
        readyFailed: forms(r.readyFailed),
        check: oneOf(r.check, ['passed', 'failed', 'none'] as const, 'none'), calls: count(r.calls), failed: count(r.failed),
        ...useFacts(r),
      };
    // Phase 2 (2.3): a change to the file Trail wrote.
    case 'changed':
      return {
        at, event: 'changed', skill: skillId, op: oneOf(r.op, ['update', 'extend', 'replace', 'adopted', 'restore-version'] as const, 'update'),
        from: count(r.from), to: count(r.to), offerId: typeof r.offerId === 'string' && /^o-[0-9a-f]{6}$/.test(r.offerId) ? r.offerId : null,
        ...(Array.isArray(r.lessonIds) ? { lessonIds: r.lessonIds.filter((x): x is string => typeof x === 'string' && LESSON_ID.test(x)).slice(0, 10) } : {}),
      };
    case 'corrected':
      return { at, event: 'corrected', skill: skillId, useId: str(r.useId, 20) };
    case 'status': {
      const statuses = ['candidate', 'active', 'needs-fix', 'retired'] as const;
      return {
        at, event: 'status', skill: skillId, from: oneOf(r.from, statuses, 'candidate'), to: oneOf(r.to, statuses, 'candidate'),
        reason: oneOf(r.reason, ['checked-use', 'failed-twice', 'forget', 'restore', 'retire-offer'] as const, 'restore'),
      };
    }
    // 1b: a lesson kept on the skill, and an asks phrase dropped (by its sha only, never the phrase: R30).
    case 'lesson':
      return {
        at, event: 'lesson', skill: skillId, lessonId: LESSON_ID.test(String(r.lessonId)) ? r.lessonId : '',
        src: oneOf(r.src, ['correction', 'repair'] as const, 'correction'), consent: 'offer-yes',
      };
    case 'cue':
      return { at, event: 'cue', skill: skillId, phraseSha: /^[0-9a-f]{8}$/.test(String(r.phraseSha)) ? r.phraseSha : '', change: 'dropped' };
    default:
      throw new Error(`trail: not a ledger event: ${flatLine(r.event, 20)}`);
  }
}

/** One line, O_APPEND. Throws on a ledger folder that is a link (own-folder.ts) or a ledger file that is one. */
export function appendLedger(skillId: string, line: LedgerLine, env?: NodeJS.ProcessEnv): void {
  const path = ledgerPath(skillId, env);
  ownFolder(dirname(path));
  appendPrivateLine(path, JSON.stringify(shape(skillId, line)));
}

const EVENTS = new Set(['saved', 'use', 'corrected', 'status', 'lesson', 'cue', 'changed']);

/** Every line, oldest first; a broken line, or one that isn't a ledger event, is skipped. [] for an unknown or bad id. */
export function readLedger(skillId: string, env?: NodeJS.ProcessEnv): LedgerLine[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath(skillId, env), 'utf8');
  } catch {
    return [];
  }
  const out: LedgerLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      if (v && typeof v === 'object' && !Array.isArray(v) && EVENTS.has(v.event as string) && typeof v.skill === 'string' && typeof v.at === 'string') out.push(v as unknown as LedgerLine);
    } catch { /* a torn or hand-mangled line */ }
  }
  return out;
}

export type Credit = Pick<CreditState, 'stepsRan' | 'failedStep' | 'check' | 'calls' | 'failed'>;

/** A tool's own name, as `metadata.check-tool` keeps it: `mcp__claude_ai_Vercel__get_deployment` -> `get_deployment`. */
const toolName = (name: string) => name.replace(/^mcp__.+__(?=[^_])/, '');

/** The commit a skill's block is about, when it is one (`{sha}` filled with a hash). */
const blockSha = (inj: SkillInjection) => (/^[0-9a-f]{7,40}$/i.test(inj.params.sha ?? '') ? inj.params.sha!.toLowerCase() : null);
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

const HEAD_ALL = new RegExp(HEAD_SHA, 'g');
const hasHead = (t: string) => new RegExp(HEAD_SHA).test(t);
/** A written-out commit: 7 to 40 hex with a digit and a letter (promptParams' rule), not part of a longer word. */
const LITERAL_SHA = /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g;
const shasIn = (t: string) => [...new Set(t.match(LITERAL_SHA) ?? [])].slice(0, 6);

/**
 * D71 c: a skill's step or check matches a call that ran it, its commit written either way: the skill's
 * `$(git rev-parse HEAD)` (the `{sha}` default) where the run wrote the commit out, the commit the block named
 * where the run worked it out with `$(git rev-parse HEAD)`, and a short sha where the run wrote the full one.
 * Another commit is never a match.
 */
export function ranAs(step: string, ran: string, params: Record<string, string>): boolean {
  // D138 (2): a call that made the step do less (a dry run, a --no- flag, a hidden failure) is not the step.
  if (doesLess(step, ran)) return false;
  if (stepMatches(step, ran, params, true)) return true;
  const ranShas = shasIn(ran);
  if (hasHead(step)) {
    for (const sha of ranShas) if (stepMatches(step.replace(HEAD_ALL, sha), ran, params, true)) return true;
  }
  const stepShas = shasIn(step);
  if (hasHead(ran)) {
    for (const sha of stepShas) if (stepMatches(step, ran.replace(HEAD_ALL, sha), params, true)) return true;
  }
  for (const s of stepShas) {
    for (const r of ranShas) if (r !== s && sameCommit(s, r) && stepMatches(step.split(s).join(r), ran, params, true)) return true;
  }
  return false;
}

/**
 * D66: a deploy status read over MCP is the check of a skill whose check is that tool (`checkTool`, from
 * `metadata.check-tool`), when it read the block's commit (or says no commit). Null when it is not the check.
 */
function toolCheck(inj: SkillInjection, c: RunCall): boolean | null {
  if (!inj.checkTool || !c.tool || toolName(c.tool) !== toolName(inj.checkTool)) return null;
  const sha = blockSha(inj);
  const read = c.check?.facts.sha?.toLowerCase();
  if (sha && read && !sameCommit(sha, read)) return null;
  return c.check?.passed === true;
}

/** The end of the `$(…)` that opens at `open` (the index after `$(`), quotes respected; -1 when it never closes. */
function closeParen(text: string, open: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

const LOOP = /(?:^|[\s;&|(])(?:until|while|for)\s[\s\S]*\bdo\b[\s\S]*\bdone\b/;

/**
 * D65 / D59c: the check run inside a wait loop, as a `$(CHECK)` the loop compares (the skill's own wait step,
 * `until [ "$(CHECK)" = "success" ]`) or as the loop's condition (`until CHECK >/dev/null`, `while ! CHECK`).
 * Only a call the fold read as a check (`c.check`) is judged this way: its CheckHit is the loop's last reading.
 */
function checkInLoop(check: string, text: string, params: Record<string, string>): boolean {
  if (!LOOP.test(text)) return false;
  const inner: string[] = [];
  for (const m of text.matchAll(/\$\(/g)) {
    const from = m.index! + 2;
    const to = closeParen(text, from);
    if (to > from) inner.push(text.slice(from, to));
  }
  for (const m of text.matchAll(/(?:^|[\s;&|(])(?:until|while)\s+(?:!\s+)?(?!\[)([^;]+);\s*do\b/g)) inner.push(m[1]!);
  return inner.some((t) => ranAs(check, t.trim(), params));
}

/**
 * Credit from commands that ran (4.8). Pure. The calls are the injection's run's (`creditCalls`); only those at or
 * after `inj.at` (less 5 s, the fold's slack) count. Each call goes to the first step it matches (params filled,
 * env prefixes ignored); a step's last outcome wins, so a failed try then a pass ran. `calls` and `failed` count Bash
 * calls only: an MCP deploy read (`tool`) is never a step. A check-cue injection earns nothing.
 *
 * The check (D65): a call matching `inj.check` at a command start, the check run inside a wait loop, or for a
 * check-tool skill (D66) that tool's result. It is the run's check only once a step has run ok before it (or the
 * call is itself a step, as a tests check is): a check that passed before the steps ran proves nothing about them.
 * Any passing reading makes it `passed`; a reading that never passed, `failed`. A reading is the fold's, except for a
 * version check (D106, `checkVersion`): it passes when the call worked and showed that version.
 */
export function creditRun(inj: SkillInjection, calls: RunCall[]): Credit {
  if (inj.cue === 'check') return { stepsRan: [], failedStep: null, check: 'none', calls: 0, failed: 0 };
  const from = Date.parse(inj.at);
  const span = calls.filter((c) => Number.isNaN(from) || Date.parse(c.at) >= from - SLACK_MS);
  const bash = span.filter((c) => !isToolCall(c));
  const last = new Map<number, boolean>();
  let check: Credit['check'] = 'none';
  let stepRan = false;
  // D137: a gated step handed to the person (denied here, theirs to run) counts as ran, its denied call no failure.
  const handed = new Set((inj.handed ?? []).map((h) => h.n).filter((n) => Number.isInteger(n) && n >= 1 && n <= inj.steps.length));
  const reading = (passed: boolean) => {
    if (check !== 'passed') check = passed ? 'passed' : 'failed';
  };
  // D106: a version check passes when it shows the version the block filled in, not on what the fold could tell.
  const want = inj.checkVersion;
  const passes = (c: RunCall) => (want ? !c.failed && (hasVersion(c.tail ?? '', want) || c.check?.facts.version === want) : c.check?.passed === true);
  for (const c of span) {
    if (isToolCall(c)) {
      const hit = stepRan ? toolCheck(inj, c) : null;
      if (hit !== null) reading(hit);
      continue;
    }
    const text = callText(c);
    if (!text) continue;
    const i = inj.steps.findIndex((s) => ranAs(s, text, inj.params));
    const ok = !c.failed || handed.has(i + 1);
    if (i >= 0) last.set(i + 1, ok);
    if (inj.check && !inj.checkTool && (stepRan || i >= 0)) {
      if (ranAs(inj.check, text, inj.params)) reading(passes(c));
      else if (c.check && checkInLoop(inj.check, text, inj.params)) reading(passes(c));
    }
    if (i >= 0 && ok) stepRan = true;
  }
  for (const n of handed) if (!last.has(n)) last.set(n, true);
  const ran = [...last].filter(([, ok]) => ok).map(([n]) => n).sort((a, b) => a - b);
  const bad = [...last].filter(([, ok]) => !ok).map(([n]) => n);
  return { stepsRan: ran, failedStep: bad.length ? Math.min(...bad) : null, check, calls: bash.length, failed: bash.filter((c) => c.failed).length };
}

/**
 * D57: the calls an injection is credited from. Its run's calls while the session state holds them (the open run,
 * or a run the fold just closed, inside `withSkillSession`'s fn), else its run sheet: a closed run's calls are
 * emptied once its sheet is written, so a run the next typed ask closed is credited from `runs/<id>.json`. A sheet
 * carried across a compaction (D59a) is joined with the parts before it (`joinCarriedSheet`).
 * With no run, every call of the injection's epoch the session still holds. [] when there is nothing.
 */
export function creditCalls(inj: SkillInjection, runs: RunState[], env?: NodeJS.ProcessEnv): RunCall[] {
  if (!inj.runId) return runs.filter((r) => r.epoch === inj.epoch).flatMap((r) => r.calls);
  const run = runs.find((r) => r.id === inj.runId);
  if (run && (run.calls.length || !run.closed)) return run.calls;
  const sheet = readRunSheet(inj.runId, env);
  return sheet ? joinCarriedSheet(sheet, (id) => readRunSheet(id, env)).calls : [];
}

export function newUseId(): string {
  return `u-${randomBytes(3).toString('hex')}`;
}
