/**
 * The save gate (design 3.3 step 3, 4.9): the trust boundary of learned
 * skills. An agent can never keep a skill without the person's typed yes.
 *
 * Two halves decide the same way (`verifySave`). PreToolUse sees the agent's
 * `trail skills add`, denies it or writes a receipt and lets it run. The CLI
 * (`trail skills add`, `cliAdd`) never trusts that receipt: it re-decides
 * from the transcript under the session lock, and anything that doesn't
 * match (no receipt, a used or stale one, one the transcript doesn't back,
 * a different verdict) is held for the person to keep in their own
 * terminal, never saved. A held item never reaches the agent.
 *
 * Nothing here loads the CLI, the graph, ask, the cloud or telemetry: the
 * CLI half returns what was saved for `cli-skills.ts` to report.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import type { FoldResult } from '../trace/runs.js';
import type { PreBashDecision } from '../claude/pre-bash.js';
import type { CompiledSkill, Receipt } from './types.js';
import type { RunSheet } from '../trace/types.js';
import type { TraceEvent } from '../trace/claude.js';
import { CLAUDE_DIALECT, dialectFor, type HostDialect } from '../trace/dialect.js';
import { skillsGate, withSkillSession, type GateCtx } from '../trace/skill-session.js';
import type { SkillSessionState } from '../trace/types.js';
import { readRunSheet } from '../trace/runs.js';
import { tamperOf } from '../trace/tamper.js';
import { runCheckout } from './run-checkout.js';
import { trailHome } from '../notes/trail-home.js';
import { flatLine } from '../notes/flatten.js';
import { localDate, skillsOn } from './settings.js';
import { askedWords, monthDay, goodName } from './compile-words.js';
import { compileRun, refusalWords } from './compile.js';
import { dropHeld, saveHeld, savePersonal } from './store.js';
import { findReceipt, markReceiptUsed, receiptTranscriptOk, receiptTranscriptRead, typedLineStillThere, writeReceipt } from './receipts.js';
import { parseSkillsAdd, SKILLS_ADD_RE, SKILLS_LESSON_RE, SKILLS_UPDATE_RE, type SkillsAddCmd } from './save-parse.js';
import { DENY, isSplitOffer, tamperDeny, verifySave, type SaveVerdict } from './save-verify.js';
import { heldRunId, nameTaken, readSkillsStateSafe } from './save-store.js';
import { hookError } from '../claude/skills-hook-util.js';
import { codexSandboxRefusal } from './codex-sandbox.js';
import { stepLearnings } from './follow-learnings.js';

export { parseSkillsAdd, parseSkillsLesson, SAVE_GATE_RE, SKILLS_ADD_RE, SKILLS_LESSON_RE, type SkillsAddCmd, type SkillsLessonCmd } from './save-parse.js';
export { DENY, verifySave, type SaveVerdict } from './save-verify.js';

/** 3.3 step 3, after the gate: a deny, or null after writing the receipt (live or held). */
export function checkSkillsAdd(input: any, ctx: GateCtx, st: SkillSessionState, fold: FoldResult | null): PreBashDecision | null {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !SKILLS_ADD_RE.test(command)) return null;
  let v: SaveVerdict;
  try {
    v = verifySave(parseSkillsAdd(command), ctx, st, fold, ctx.env);
  } catch (e) {
    // A store that can't be read safely (a planted link, a busy lock) refuses, never lets the add through.
    return { permissionDecision: 'deny', reason: notSaved(e) };
  }
  if (v.deny) return { permissionDecision: 'deny', reason: v.deny };
  const r: Receipt = {
    v: 1, session: ctx.sessionId, transcriptPath: ctx.transcriptPath ?? '', toolUseId: typeof input?.tool_use_id === 'string' ? input.tool_use_id : '',
    runId: parseSkillsAdd(command)!.runId, name: v.compiled!.name, at: ctx.now.toISOString(), host: ctx.host, tier: ctx.tier,
    consent: v.consent, offerId: v.offerId, typed: v.typed, typedYes: v.consent === 'offer-yes', typedSave: v.consent === 'asked',
    asked: v.consent === 'asked' ? st.saveRequest?.scope ?? null : null, stepsTotal: v.stepsTotal, stepsVerified: v.stepsVerified,
    verdict: v.verdict, ...(v.heldWhy ? { heldWhy: v.heldWhy } : {}), checkout: v.checkout ?? '', usedAt: null,
  };
  writeReceipt(r, ctx.env);
  return null;
}

/** 3.3 step 3 from the gate's ctx on: the subagent and no-person denies, then the locked check. */
export function saveGateFor(input: any, ctx: GateCtx): PreBashDecision | null {
  if (ctx.subagent) return { permissionDecision: 'deny', reason: DENY.subagent };
  if (!ctx.fold) return { permissionDecision: 'deny', reason: DENY.noPerson };
  const r = withSkillSession(ctx, { catchUp: true, waitMs: 300 }, (st, fold) => checkSkillsAdd(input, ctx, st, fold));
  return r === undefined ? { permissionDecision: 'deny', reason: DENY.busy } : r;
}

/** 3.3 step 3 whole, for `preBashSkills`: the gate, then `saveGateFor`. Skills off or no session: null (the CLI holds). Throws: null. */
export function saveGate(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, now?: Date): PreBashDecision | null {
  try {
    const g = skillsGate(input, dir, env, now);
    return g.ok ? saveGateFor(input, g.ctx) : null;
  } catch (e) {
    // 0 rule 5: the add runs, and the CLI holds it (no receipt); one line in hook-errors.log.
    hookError('pre-bash', e, env);
    return null;
  }
}

/**
 * 1b (3.3 step 2): the save gate for either save, `skills add` (this file) or `skills lesson` (lesson-gate.ts, loaded
 * only for a lesson command); phase 2's `skills update` (update-gate.ts, loaded only for an update command). b7's `preBashSkills` calls this for a command matching SAVE_GATE_RE.
 */
export async function saveOrLessonGate(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, now?: Date): Promise<PreBashDecision | null> {
  const cmd = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';
  // Phase 2 (4.11): an update, loaded only for an update command. One that also adds or keeps a lesson is denied there.
  if (SKILLS_UPDATE_RE.test(cmd)) {
    const { updateGate } = await import('./update-gate.js');
    return updateGate(input, dir, env, now);
  }
  if (SKILLS_LESSON_RE.test(cmd) && !SKILLS_ADD_RE.test(cmd)) {
    const { lessonGate } = await import('./lesson-gate.js');
    return lessonGate(input, dir, env, now);
  }
  return saveGate(input, dir, env, now);
}

/**
 * The GateCtx the CLI half rebuilds from a receipt (session, transcript, host, tier), with fold and learn as the
 * receipt's tier allows. D93: its checkout and repo key are the run's (the sheet's checkout, else the receipt's,
 * when it is still a checkout of the run's repo), never the CLI's own folder: a session that started above the repo
 * runs `trail skills add` up there. verifySave still checks the run is this session's.
 */
export function ctxFromReceipt(r: Receipt, sheet: RunSheet, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): GateCtx {
  const a = r.tier === 'A';
  const checkout = runCheckout(sheet, env, r.checkout);
  return {
    sessionId: r.session, sessionHash: createHash('sha256').update(r.session).digest('hex').slice(0, 12), host: r.host, tier: r.tier,
    entry: 'interactive', permissionMode: null, subagent: false, fold: true, learn: a, learnOff: a ? null : 'host', dir: checkout,
    checkout, repoKey: sheet.repoKey, transcriptPath: r.transcriptPath || null, env, now,
  };
}

const TAIL_BYTES = 4 * 1024 * 1024;

/** The whole lines in the transcript's last 4 MB, newest last, as parsed objects ([] when unreadable). */
export function tailEntries(tx: string): Array<Record<string, any>> {
  let fd: number;
  try {
    fd = openSync(tx, 'r');
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    let text = buf.subarray(0, n).toString('utf8');
    if (from > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').flatMap((l) => {
      try {
        const v = JSON.parse(l);
        return v && typeof v === 'object' && !Array.isArray(v) ? [v] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

export type ToolCall = Extract<TraceEvent, { kind: 'tool_call' }>;

/**
 * The main session's tool calls in the transcript's last 4 MB, oldest first, as the host's dialect reads them (4.16):
 * Claude's tool_use blocks (subagent lines left out), Codex's function calls.
 */
export function tailCalls(tx: string, dialect: HostDialect, env: NodeJS.ProcessEnv): ToolCall[] {
  const memo = dialect.tailMemo?.(tx, env) ?? {};
  return tailEntries(tx).flatMap((e) => dialect.lineEvents(e, memo, undefined, env).filter((ev): ev is ToolCall => ev.kind === 'tool_call'));
}

/** The command a Bash call ran, or null for any other tool. */
export const bashCommand = (c: ToolCall): string | null => {
  const i = c.input as { command?: unknown } | null;
  return c.name === 'Bash' && typeof i?.command === 'string' ? i.command : null;
};

/** CLI step 3: the transcript shows the main session's agent running exactly this add, with the receipt's tool_use id. */
function addInTranscript(r: Receipt, cmd: SkillsAddCmd, calls: ToolCall[]): boolean {
  if (!r.toolUseId) return false;
  return calls.some((c) => {
    const raw = c.id === r.toolUseId ? bashCommand(c) : null;
    const a = raw === null ? null : parseSkillsAdd(raw);
    return a !== null && !a.flags.length && a.name === cmd.name && a.runId === cmd.runId;
  });
}

/** A write to Trail's files or the transcript among the tail's tool calls, whatever the session's cursor says. */
export function tamperInTail(calls: ToolCall[], tx: string, env: NodeJS.ProcessEnv): string | null {
  const ctx = { trailHome: trailHome(env), transcriptPath: tx, home: env.HOME };
  for (const c of calls) {
    const hit = tamperOf(String(c.name ?? ''), c.input, bashCommand(c), { ...ctx, folder: c.cwd ?? null });
    if (hit) return hit;
  }
  return null;
}

const HOSTS: Record<string, string> = { claude: 'Claude Code', cursor: 'Cursor', copilot: 'GitHub Copilot', codex: 'Codex', gemini: 'Gemini CLI' };
const steps = (n: number) => `${n} step${n === 1 ? '' : 's'}`;

/** `at HH:MM today` (local, the run's end) or `on <Mon D>`. */
function whenRan(endedAt: string, now: Date): string {
  const d = new Date(endedAt);
  if (Number.isNaN(d.getTime())) return 'earlier';
  if (localDate(d) !== localDate(now)) return `on ${monthDay(endedAt)}`;
  return `at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} today`;
}

/** 4.9 CLI step 5's two lines. */
export function savedLines(c: CompiledSkill, n: number, endedAt: string, asked: Receipt['asked'], now: Date): [string, string] {
  const name = flatLine(c.name, 60);
  const every = c.meta.applies === 'every repo';
  const where = every ? 'just for you, in every repo' : 'just for you in this repo';
  const first = flatLine((c.meta.asks ?? '').split(',')[0]?.trim() ?? '', 80);
  // fix-lab5: "you ask for integration tests", never "you ask to integration tests".
  const ask = first ? askedWords([first]) : 'to do this job';
  const when = whenRan(endedAt, now);
  // D118 c: steps and a check that is not itself a step are named apart ("1 step and its check", never "2 steps").
  const apart = !!c.check && !c.checkIsStep && n >= 1;
  const count = apart ? `${steps(n - 1)} and its check` : steps(n);
  const later = asked === 'repo' ? ' Saving it for the whole repo comes later, so for now it\'s just yours.'
    : asked === 'team' ? ' Saving it for the team comes later, so for now it\'s just yours.' : '';
  // Part 7: steps that follow the person's learnings rather than the run, said in the same one line.
  const follow = c.followed ? ` ${flatLine(c.followed, 400)}` : '';
  return [
    `✓ saved ${name}, ${where} · ${count}, each one ran here ${when}${follow ? ` ·${follow}` : ''}`,
    `Tell the person what Trail kept: Saved ${name}, ${where}: ${count}, each one ran here ${when}.${follow} Next time you ask ${ask}, I start from them.${later} See them: trail skills show ${name} · undo: trail forget ${name}`,
  ];
}

/** Why a receipt that names a file other than the session's own transcript is held (g7, D74), in the host's name (c7). */
const transcriptWhy = (host: string) => `Trail couldn't find this conversation where ${HOSTS[host] ?? 'your agent'} keeps it, so it can't check that you said yes`;

/** 4.9 CLI step 6's two lines. `transcript`: the receipt named a file other than the session's own (held as no-yes). */
export function heldLines(name: string, why: 'no-yes' | 'host' | 'transcript', host: string): [string, string] {
  const n = flatLine(name, 60);
  const because = why === 'host' ? `it came from ${HOSTS[host] ?? 'another tool'}, where Trail can't check which steps ran`
    : why === 'transcript' ? transcriptWhy(host) : "you didn't say yes to keeping it";
  return [`· not kept: ${because}`, `Tell the person why Trail didn't keep it: I didn't keep ${n} as a skill, because ${because}. If you want it, run this in your own terminal: trail skills keep ${n}`];
}

export interface CliAddResult {
  exit: 0 | 1;
  lines: string[];
  /** For `skill_saved` telemetry, sent by cli-skills.ts (this module loads no telemetry). */
  saved?: { from: 'asked' | 'repeated' | 'repaired'; scope: 'personal' };
  held?: 'no-yes' | 'host';
  /** Phase 2: the save was moment 5's split, for `skill_changed{split}`. */
  changed?: 'split';
}

const fail = (line: string): CliAddResult => ({ exit: 1, lines: [line] });
/** g4's words for a store another trail command holds (`underStoreLock`). */
const STORE_BUSY = 'trail: the skill store is busy (another trail command is changing it). Try again.';
/** A store error (busy, a planted link) as the refusal line: nothing was saved. */
function notSaved(e: unknown): string {
  const msg = flatLine(e instanceof Error ? e.message : String(e), 200).replace(/^trail:\s*/, '');
  return `trail · not saved: ${msg || 'the skill store could not be written'}`;
}

/** No receipt the transcript backs: compile the run as an asked save and hold it for the person. */
function holdUnbacked(cmd: SkillsAddCmd, env: NodeJS.ProcessEnv, now: Date, why: 'no-yes' | 'transcript' = 'no-yes'): CliAddResult {
  const sheet = readRunSheet(cmd.runId, env)!;
  if (!goodName(cmd.name)) return fail(DENY.name);
  const keptAs = Object.values(readSkillsStateSafe(env)).find((s) => s.runId === cmd.runId && s.status !== 'retired');
  if (keptAs) return fail(`trail · not saved: that run is already kept as the skill ${flatLine(keptAs.name, 60)}.`);
  // D93: the run's own checkout, never the folder the CLI runs in.
  const root = runCheckout(sheet, env);
  const scope = { repoKeys: [sheet.repoKey], checkout: root, env };
  const where = nameTaken(cmd.name, scope);
  if (where !== null && where !== 'held') return fail(`trail · not saved: the name ${cmd.name} is taken. Use another: trail skills add <other> --run ${flatLine(cmd.runId, 40)}`);
  const c = compileRun(sheet, {
    repoRoot: root, home: env.HOME || homedir(), platform: process.platform, now,
    readSheet: (id) => readRunSheet(id, env), name: cmd.name, moment: 'asked', applies: sheet.repoKey, taken: (n) => n !== cmd.name && nameTaken(n, scope) !== null,
    learnings: stepLearnings({ repoKeys: [sheet.repoKey], checkout: root, env }),
  });
  if (!c.ok) return fail(`trail · not saved: ${refusalWords(c.reason, c.detail)}.`);
  try {
    // D93: held by the session whose run it is (no receipt says more), so that session's own starts don't show it.
    saveHeld(c.skill, 'no-yes', { host: sheet.host, job: sheet.job, repoKey: sheet.repoKey, session: sheet.session }, env, now);
  } catch (e) {
    return fail(notSaved(e));
  }
  return { exit: 0, lines: heldLines(c.skill.name, why, sheet.host), held: 'no-yes' };
}

const sameTyped = (a: Receipt['typed'], b: Receipt['typed']) => (a === null ? b === null : b !== null && a.offset === b.offset && a.lineSha === b.lineSha);

/**
 * 4.9 CLI half, minus printing: what `trail skills add` prints and its exit code. cli-skills.ts only prints.
 * `_cwd`, the folder the CLI runs in, is not read (D93): the checkout is the run's.
 */
export function cliAdd(name: string, runId: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date(), _cwd: string = process.cwd()): CliAddResult {
  if (!skillsOn(env)) return fail('Skills are off. Turn them on with: trail skills on');
  const sheet = readRunSheet(runId, env);
  if (!sheet) return fail(`no run called ${flatLine(runId, 40)} (runs are kept 7 days)`);
  const cmd: SkillsAddCmd = { name, runId, flags: [] };
  const found = findReceipt(runId, name, now, env);
  // 4.17, R21: Codex's sandbox may refuse ~/.trail. Nothing changes and the receipt stays unused for the person's run.
  const sandboxed = found ? codexSandboxRefusal(found.host, `trail skills add ${name} --run ${runId}`, env) : null;
  if (sandboxed) return fail(sandboxed);
  // The receipt is read only when it names the session's own transcript, where the host keeps it (D74), and that file
  // is the one the hooks read for the session (its cursor's inode): never a copy at a path the agent picked.
  const r = found && receiptTranscriptOk(found, env) && receiptTranscriptRead(found, env) ? found : null;
  if (found && !r) {
    const held = holdUnbacked(cmd, env, now, 'transcript');
    markReceiptUsed(found, now, env);
    return held;
  }
  const calls = r ? tailCalls(r.transcriptPath, dialectFor(r.host) ?? CLAUDE_DIALECT, env) : [];
  if (!r || !addInTranscript(r, cmd, calls)) return holdUnbacked(cmd, env, now);
  const tampered = tamperInTail(calls, r.transcriptPath, env);
  if (tampered) {
    markReceiptUsed(r, now, env);
    return fail(tamperDeny(tampered));
  }

  const ctx = ctxFromReceipt(r, sheet, env, now);
  type Out = { deny: string } | { live: SaveVerdict; from: 'asked' | 'repeated' | 'repaired'; split: boolean } | { held: SaveVerdict; why: 'no-yes' | 'host' };
  let out: Out | undefined;
  try {
    out = withSkillSession<Out>(ctx, { catchUp: true, waitMs: 1000 }, (st, fold) => {
      const v = verifySave(cmd, ctx, st, fold, env);
      if (v.deny) return { deny: v.deny };
      const backed = st.host === r.host && st.tier === r.tier && v.verdict === r.verdict && v.consent === r.consent && sameTyped(v.typed, r.typed)
        && (r.typed === null || typedLineStillThere(r.transcriptPath, r.typed));
      if (!backed || v.verdict !== 'live') return { held: v, why: backed && v.heldWhy ? v.heldWhy : 'no-yes' };
      // Live: the consent is spent with the save, under the same lock. A save that throws (a busy state, a
      // planted link) is undone by the store, and the session state is put back as it was, consent unspent.
      // R14: a yes to a moment-3 offer saves from 'repaired' (skill_saved{from:'repaired'}); any other offer's from 'repeated'.
      const from = v.consent === 'asked' ? 'asked' as const : st.pendingOffer?.moment === 'repaired' ? 'repaired' as const : 'repeated' as const;
      const split = v.consent === 'offer-yes' && isSplitOffer(st.pendingOffer);
      if (v.consent === 'offer-yes') st.pendingOffer = null;
      else st.saveRequest = null;
      if (heldRunId(name, env) === runId) {
        // D65, D70: the held copy of this run goes first. A store too busy to drop it refuses the save, so the
        // held copy never stays beside the saved skill; the throw puts the consent back for a retry.
        dropHeld(name, env);
        if (heldRunId(name, env) === runId) throw new Error(STORE_BUSY);
      }
      savePersonal(v.compiled!, { from, runId, consent: v.consent as 'offer-yes' | 'asked', stepsVerified: v.stepsVerified, env, now });
      return { live: v, from, split };
    });
  } catch (e) {
    return fail(notSaved(e));
  }
  if (out === undefined) return fail(DENY.busy);
  if ('deny' in out) {
    markReceiptUsed(r, now, env);
    return fail(out.deny);
  }
  if ('held' in out) {
    try {
      saveHeld(out.held.compiled!, out.why, { host: r.host, job: sheet.job, repoKey: sheet.repoKey, session: ctx.sessionHash }, env, now);
    } catch (e) {
      return fail(notSaved(e));
    }
    markReceiptUsed(r, now, env);
    return { exit: 0, lines: heldLines(out.held.compiled!.name, out.why, r.host), held: out.why };
  }
  markReceiptUsed(r, now, env);
  const v = out.live;
  return {
    exit: 0, lines: savedLines(v.compiled!, v.stepsVerified, sheet.endedAt, r.asked, now),
    saved: { from: out.from, scope: 'personal' }, ...(out.split ? { changed: 'split' as const } : {}),
  };
}
