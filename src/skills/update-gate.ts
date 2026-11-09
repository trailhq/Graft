/**
 * The update gate (phase 2 design 4.11, P29, R4, R14): 1a's dual consent for
 * `trail skills update <name> --offer <id>`, the one command that changes a
 * skill Trail kept. An agent can never change a skill without the person's
 * typed yes to the offer that showed that exact change.
 *
 * The PreToolUse half (`checkSkillsUpdate`) denies, or writes a receipt and
 * lets the command run. The CLI half (`cliUpdate`) never trusts the receipt:
 * it re-decides from the transcript under the session lock (the same
 * `decide`), plans the change again, and writes only when the plan still
 * gives the `proposalSha` the person saw from the file it was computed from
 * (`baseHash`). Every new or changed step is read again in the transcript at
 * its offsets and must show it ran as stored and worked (R4), so no step
 * comes from a run sheet the agent edited or from text it only read.
 *
 * A file the person changed by hand is never written: the change goes beside
 * it as a proposal (4.6). Loaded only for an update command (the save gate
 * imports it lazily), and never loads the CLI or telemetry.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { PreBashDecision } from '../claude/pre-bash.js';
import type { FoldResult } from '../trace/runs.js';
import type { GateCtx } from '../trace/skill-session.js';
import type { Host } from '../trace/host.js';
import type { PendingOffer, SkillSessionState } from '../trace/types.js';
import type { ChangeOp, CompiledSkill, Receipt, UpdateReceipt } from './types.js';
import { skillsGate, withSkillSession } from '../trace/skill-session.js';
import { joinCarriedSheet, readRunSheet } from '../trace/runs.js';
import { classifyFor } from './offer-answers.js';
import { CLAUDE_DIALECT, dialectFor } from '../trace/dialect.js';
import { flatLine } from '../notes/flatten.js';
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { hookError } from '../claude/skills-hook-util.js';
import { skillsOn } from './settings.js';
import { hostFacts } from './host-facts.js';
import { codexSandboxRefusal } from './codex-sandbox.js';
import { endsWithLine } from './offer-words.js';
import { offerLinesOf } from './offer-lines.js';
import { receiptPath, receiptTranscriptOk, receiptTranscriptRead, typedLineStillThere } from './receipts.js';
import { dialectUse, personLine, ranAndWorked, replyBefore } from './save-verify.js';
import { parseSkillsUpdate, SKILLS_UPDATE_RE, type SkillsUpdateCmd } from './save-parse.js';
import { bashCommand, tailCalls, tamperInTail, type ToolCall } from './save-gate.js';
import { listAllPersonal } from './store.js';
import { writeNewVersion, writeProposal } from './versions.js';
import { replan, type Replanned } from './update-plan.js';

export { parseSkillsUpdate, SKILLS_UPDATE_RE as UPDATE_RE, type SkillsUpdateCmd } from './save-parse.js';
export { foldInputFor, proposalShaOf, replan, type PlanInj, type PlanOpts, type Replanned } from './update-plan.js';

/** An update receipt older than this is stale (4.11 CLI step 1). */
const FRESH_MS = 30 * 60_000;
const AHEAD_MS = 5_000;
const SKEW_MS = 5_000;
const CMD_MAX = 64 * 1024;

const NOT = 'trail · not changed: ';
export const UPDATE_DENY = {
  flags: `${NOT}\`trail skills update\` takes only the skill's name and --offer <id>, and runs on its own.`,
  tooLong: `${NOT}that command is too long for Trail to read, so it changes nothing.`,
  noOffer: `${NOT}there is no change offer with that id in this session, so there is nothing the person said yes to.`,
  noYes: `${NOT}the person didn't say yes to this change.`,
  subagent: `${NOT}only the main session can change a skill.`,
  noPerson: `${NOT}this session runs without a person at the keyboard (headless, CI or a scratch folder), so Trail changes nothing from it.`,
  busy: `${NOT}Trail was busy. Run the same command again.`,
  transcript: `${NOT}Trail couldn't find this conversation where Claude Code keeps it, so it can't check that the person said yes.`,
} as const;
const one = (t: string, max = 60) => flatLine(t, max);
export const changedDeny = (name: string) => `${NOT}${one(name)} changed since Trail showed this, so nothing changed. The person can see it with: trail skills show ${one(name)}`;
const nameDeny = (name: string, id: string) => `${NOT}the offer was for the skill ${one(name)}. Run: trail skills update ${one(name)} --offer ${one(id, 40)}`;
const splitDeny = (name: string, runId: string) => `${NOT}that offer keeps the steps as a new skill. Run: trail skills add ${one(name)} --run ${one(runId, 40)}`;
const neverRanDeny = (cmds: string[]) => `${NOT}these steps never ran here and worked: ${cmds.map((c) => one(c, 80)).join('; ')}.`;
const tamperDeny = (what: string) => `${NOT}this session changed Trail's own files (${one(what, 120)}), so Trail can't trust its record of what was offered.`;

/* -------------------------------------------------------------- the decision */

type Decided = { deny: string } | { po: PendingOffer & { fold: NonNullable<PendingOffer['fold']> }; typed: { offset: number; lineSha: string }; plan: Replanned };

/**
 * The person's yes to this offer, as `classifyFor` reads it for the offer's moment (4.10): 1a's yes words for an
 * update; for drift its own word `replace` and 1a's yes words but not the keep or save ones ("keep it" there means leave it).
 */
const isYes = (moment: PendingOffer['moment'], afterShow: boolean) => (t: string) => classifyFor(moment, t, afterShow) === 'yes';

/** The steps of `next` that aren't steps of `base` (the new or changed ones), with the calls they were copied from. */
const changedSteps = (base: CompiledSkill, next: CompiledSkill) => next.steps.filter((s) => !base.steps.some((b) => b.cmd === s.cmd));

/** 4.11 steps 1, 3, 4, 5b and 6, both halves. Tamper (step 5) is read by each half from the transcript's tail. */
function decide(cmd: SkillsUpdateCmd | null, ctx: GateCtx, st: SkillSessionState): Decided {
  const env = ctx.env;
  if (ctx.subagent) return { deny: UPDATE_DENY.subagent };
  if (!ctx.fold || !ctx.learn) return { deny: UPDATE_DENY.noPerson };
  if (!cmd) return { deny: UPDATE_DENY.flags };
  if (st.tampered) return { deny: tamperDeny(st.tampered) };
  const po = st.pendingOffer;
  if (!po || po.offerId !== cmd.offerId || (po.moment !== 'update' && po.moment !== 'drift') || !po.fold) return { deny: UPDATE_DENY.noOffer };
  if (po.fold.op === 'split') return { deny: splitDeny(po.name, po.runId) };
  if (cmd.name !== po.name) return { deny: nameDeny(po.name, po.offerId) };
  const fold = po.fold;
  const sheet = readRunSheet(po.runId, env);
  if (!sheet || sheet.session !== ctx.sessionHash) return { deny: UPDATE_DENY.noOffer };
  const tx = ctx.transcriptPath;
  if (!tx || !po.shownAt || !po.yes) return { deny: UPDATE_DENY.noYes };
  const ta = po.typedAfter;
  const entry = ta[0]?.answer === 'show' ? ta[1] : ta[0];
  if (!entry || entry.answer !== 'yes' || entry.sha !== po.yes.typedSha) return { deny: UPDATE_DENY.noYes };
  const afterShow = entry !== ta[0];
  // 4.16: every read of the transcript goes through the host's dialect (a Codex typed line counts by its keyed hash).
  const use = dialectUse(ctx.host, st);
  const p = personLine(tx, entry.offset, entry.sha, isYes(po.moment, afterShow), env, undefined, use);
  // A yes typed before the offer was shown is no yes to it.
  if (!p || !(p.at + SKEW_MS >= Date.parse(po.shownAt))) return { deny: UPDATE_DENY.noYes };
  // D72, R11: the agent's reply right before the yes ended with the offer's own line 2, after "show me" too (c3's show
  // directive asks line 2 again after the diff, never 1a's Keep it?).
  const lines = offerLinesOf(po, tx, env, use);
  const notice = po.channel === 'notice' && hostFacts(env, ctx.host as Host).offerChannel === 'notice';
  if (!lines || (!notice && !endsWithLine(replyBefore(tx, entry.offset, env, use) ?? '', lines[1]))) return { deny: UPDATE_DENY.noYes };
  // 6 (P29, R14): the same change, from the same file.
  const plan = replan(fold.skillId, po.runId, fold.op, env, { st });
  if (!plan || plan.baseHash !== fold.baseHash || plan.proposalSha !== fold.proposalSha) return { deny: changedDeny(po.name) };
  // 5b (R4): every new or changed step ran here, as stored, and worked, read again in the transcript.
  const joined = joinCarriedSheet(sheet, (id) => readRunSheet(id, env));
  const byId = new Map(joined.calls.map((c) => [c.id, c]));
  const units = changedSteps(plan.base, plan.next).map((s) => ({ ids: s.from ?? [], text: s.cmd }));
  // A check the old version didn't have (drift's replace takes the fresh compile's), as 1a's add gate reads one (step 7).
  const checkCall = joined.checkIndex === null ? null : joined.calls[joined.checkIndex] ?? null;
  if (plan.next.check && !plan.next.checkIsStep && plan.next.check !== plan.base.check) units.push({ ids: checkCall ? [checkCall.id] : [], text: plan.next.check });
  const bad = units.filter((u) => !u.ids.length || !u.ids.every((id) => ranAndWorked(byId.get(id), tx, joined.job, use, env)));
  if (bad.length) return { deny: neverRanDeny(bad.slice(0, 3).map((u) => u.text)) };
  return { po: po as PendingOffer & { fold: typeof fold }, typed: p.typed, plan };
}

/* -------------------------------------------------------------- the receipts */

const updateReceiptPath = (session: string, env?: NodeJS.ProcessEnv) => receiptPath(session, env).replace(/\.json$/, '.update.json');
const str = (v: unknown): v is string => typeof v === 'string';
const OPS = new Set(['update', 'extend', 'replace']);

function asUpdateReceipt(v: unknown): UpdateReceipt | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as UpdateReceipt;
  if (r.v !== 1 || r.kind !== 'update' || !str(r.session) || !str(r.transcriptPath) || !str(r.toolUseId) || !str(r.host)) return null;
  if (!str(r.offerId) || !str(r.skillId) || !str(r.name) || !str(r.runId) || !OPS.has(r.op) || !str(r.baseHash) || !str(r.proposalSha) || !str(r.at)) return null;
  if (!r.typed || typeof r.typed !== 'object' || typeof r.typed.offset !== 'number' || !str(r.typed.lineSha)) return null;
  return r.usedAt === null || str(r.usedAt) ? r : null;
}

function readUpdateReceipt(path: string): UpdateReceipt | null {
  try {
    if (!lstatSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return asUpdateReceipt(readJsonSafe<unknown>(path));
}

/** The unused update receipt for this offer and name, under 30 minutes old (any session's file; the newest). */
export function findUpdateReceipt(offerId: string, name: string, now: Date, env?: NodeJS.ProcessEnv): UpdateReceipt | null {
  let names: string[];
  try {
    names = readdirSync(trailPath(env, 'receipts'));
  } catch {
    return null;
  }
  let best: UpdateReceipt | null = null;
  for (const n of names) {
    if (!n.endsWith('.update.json')) continue;
    const r = readUpdateReceipt(join(trailPath(env, 'receipts'), n));
    if (!r || r.usedAt !== null || r.offerId !== offerId || r.name !== name) continue;
    const age = now.getTime() - Date.parse(r.at);
    if (Number.isNaN(age) || age > FRESH_MS || age < -AHEAD_MS) continue;
    if (!best || Date.parse(r.at) > Date.parse(best.at)) best = r;
  }
  return best;
}

function markUpdateReceiptUsed(r: UpdateReceipt, now: Date, env?: NodeJS.ProcessEnv): void {
  const path = updateReceiptPath(r.session, env);
  withLock(path, () => {
    const cur = readUpdateReceipt(path);
    if (!cur || cur.toolUseId !== r.toolUseId || cur.at !== r.at || cur.usedAt !== null) return;
    writePrivate(path, `${JSON.stringify({ ...cur, usedAt: now.toISOString() }, null, 2)}\n`);
  }, 1000);
}

/** The receipt as 1a's transcript checks read one: tier A always (updates are tier A only), so another host's is refused. */
const asReceipt = (r: UpdateReceipt) => ({ ...r, tier: 'A' }) as unknown as Receipt;

/* ----------------------------------------------------------- PreToolUse half */

/** 4.11's PreToolUse half: a deny with the reason, or null after writing the receipt (the call runs). */
export function checkSkillsUpdate(input: any, ctx: GateCtx, st: SkillSessionState, _fold: FoldResult | null): PreBashDecision | null {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !SKILLS_UPDATE_RE.test(command)) return null;
  if (command.length > CMD_MAX) return { permissionDecision: 'deny', reason: UPDATE_DENY.tooLong };
  const cmd = parseSkillsUpdate(command);
  const tx = ctx.transcriptPath;
  const tampered = cmd && tx && !ctx.subagent && ctx.learn ? tamperInTail(tailCalls(tx, dialectFor(ctx.host) ?? CLAUDE_DIALECT, ctx.env), tx, ctx.env) : null;
  if (tampered) return { permissionDecision: 'deny', reason: tamperDeny(tampered) };
  const d = decide(cmd, ctx, st);
  if ('deny' in d) return { permissionDecision: 'deny', reason: d.deny };
  const r: UpdateReceipt = {
    v: 1, kind: 'update', session: ctx.sessionId, transcriptPath: tx ?? '', toolUseId: typeof input?.tool_use_id === 'string' ? input.tool_use_id : '',
    host: ctx.host, offerId: d.po.offerId, skillId: d.po.fold.skillId, name: d.po.name, runId: d.po.runId, op: d.po.fold.op,
    baseHash: d.plan.baseHash, proposalSha: d.plan.proposalSha, typed: d.typed, at: ctx.now.toISOString(), usedAt: null,
  };
  writePrivate(updateReceiptPath(ctx.sessionId, ctx.env), `${JSON.stringify(r, null, 2)}\n`);
  return null;
}

/** 3.3 step 3 for an update command, from the hook's payload: the gate, then `checkSkillsUpdate` under the session lock. */
export function updateGate(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, now?: Date): PreBashDecision | null {
  try {
    const g = skillsGate(input, dir, env, now);
    if (!g.ok) return null;
    const ctx = g.ctx;
    if (ctx.subagent) return { permissionDecision: 'deny', reason: UPDATE_DENY.subagent };
    if (!ctx.fold) return { permissionDecision: 'deny', reason: UPDATE_DENY.noPerson };
    const r = withSkillSession(ctx, { catchUp: true, waitMs: 300 }, (st, fold) => checkSkillsUpdate(input, ctx, st, fold));
    return r === undefined ? { permissionDecision: 'deny', reason: UPDATE_DENY.busy } : r;
  } catch (e) {
    // 0 rule 5: the command runs, and the CLI finds no receipt and changes nothing.
    hookError('pre-bash', e, env);
    return null;
  }
}

/* ------------------------------------------------------------------ CLI half */

export interface CliUpdateResult { code: 0 | 1; lines: string[]; op?: ChangeOp; proposal?: boolean }

const fail = (line: string): CliUpdateResult => ({ code: 1, lines: [line] });

/** The transcript shows the main session's agent running exactly this update, with the receipt's tool_use id. */
function updateInTranscript(r: UpdateReceipt, name: string, offerId: string, calls: ToolCall[]): boolean {
  if (!r.toolUseId) return false;
  return calls.some((call) => {
    const raw = call.id === r.toolUseId ? bashCommand(call) : null;
    const c = raw === null ? null : parseSkillsUpdate(raw);
    return c !== null && c.name === name && c.offerId === offerId;
  });
}

/** A path as the person reads it: `~/…` under their home (Windows may set only USERPROFILE, which homedir() reads). */
function shown(p: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir();
  const rel = home && isAbsolute(p) ? relative(home, p) : '';
  // Forward slashes either way: the person pastes it into Git Bash or PowerShell on Windows, and both take them.
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `~/${rel.split(sep).join('/')}` : p.split(sep).join('/');
}

/** What changed, in words: `step 4 is now '…'`, `step 5 added: '…'`, `the 4 steps that just worked replace the old ones`. */
export function whatChanged(op: ChangeOp, plan: Replanned): string {
  const q = (c: string) => `'${one(c, 60).replace(/'/g, '"')}'`;
  if (op === 'update' && plan.plan?.op === 'update') return `step ${plan.plan.step} is now ${q(plan.plan.cmd.cmd)}`;
  if (op === 'extend' && plan.plan?.op === 'extend') {
    const at = plan.plan.at;
    const cmds = plan.plan.cmds;
    return cmds.length === 1 ? `step ${at + 1} added: ${q(cmds[0]!.cmd)}` : `steps ${at + 1} and ${at + 2} added: ${q(cmds[0]!.cmd)} and ${q(cmds[1]!.cmd)}`;
  }
  const k = plan.next.steps.length;
  return `the ${k} step${k === 1 ? '' : 's'} that just worked replace the old ones`;
}

const WRITE_WHY: Record<'busy' | 'link' | 'io', string> = {
  busy: UPDATE_DENY.busy,
  link: `${NOT}the skill's folder in Trail's home is a link, so Trail won't write through it.`,
  io: `${NOT}Trail couldn't write the new version, so the skill is as it was.`,
};

/** 4.11's CLI half: re-decides from the transcript, plans again, writes the new version or the proposal. Exit 0 changed, 1 not. */
export function cliUpdate(name: string, offerId: string, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): CliUpdateResult {
  if (!skillsOn(env)) return fail('Skills are off. Turn them on with: trail skills on');
  const found = findUpdateReceipt(offerId, name, now, env);
  if (!found) return fail(UPDATE_DENY.noYes);
  const sandboxed = codexSandboxRefusal(found.host, `trail skills update ${name} --offer ${offerId}`, env);
  if (sandboxed) return fail(sandboxed);
  const r = receiptTranscriptOk(asReceipt(found), env) && receiptTranscriptRead(asReceipt(found), env) ? found : null;
  if (!r) {
    markUpdateReceiptUsed(found, now, env);
    return fail(UPDATE_DENY.transcript);
  }
  const calls = tailCalls(r.transcriptPath, dialectFor(r.host) ?? CLAUDE_DIALECT, env);
  if (!updateInTranscript(r, name, offerId, calls)) return fail(UPDATE_DENY.noYes);
  const tampered = tamperInTail(calls, r.transcriptPath, env);
  if (tampered) {
    markUpdateReceiptUsed(r, now, env);
    return fail(tamperDeny(tampered));
  }
  const sheet = readRunSheet(r.runId, env);
  if (!sheet) {
    markUpdateReceiptUsed(r, now, env);
    return fail(`${NOT}the run it came from is gone (runs are kept 7 days).`);
  }
  const ctx: GateCtx = {
    sessionId: r.session, sessionHash: createHash('sha256').update(r.session).digest('hex').slice(0, 12), host: r.host, tier: 'A',
    entry: 'interactive', permissionMode: null, subagent: false, fold: true, learn: true, learnOff: null, dir: sheet.checkout ?? '',
    checkout: sheet.checkout ?? '', repoKey: sheet.repoKey, transcriptPath: r.transcriptPath, env, now,
  };
  let out: CliUpdateResult | undefined;
  try {
    out = withSkillSession<CliUpdateResult>(ctx, { catchUp: true, waitMs: 1000 }, (st) => {
      const d = decide({ name, offerId }, ctx, st);
      if ('deny' in d) return fail(d.deny);
      const backed = d.typed.offset === r.typed.offset && d.typed.lineSha === r.typed.lineSha && typedLineStillThere(r.transcriptPath, r.typed)
        && d.plan.proposalSha === r.proposalSha && d.plan.baseHash === r.baseHash && d.po.fold.op === r.op && d.po.fold.skillId === r.skillId;
      if (!backed) return fail(changedDeny(name));
      const ref = listAllPersonal(env).find((x) => x.id === r.skillId && x.name === name);
      if (!ref) return fail(changedDeny(name));
      const op = r.op as ChangeOp;
      if (d.plan.handEdited) {
        const p = writeProposal(ref, d.plan.next, r.op, env, now);
        if (!p) return fail(`${NOT}Trail couldn't write the change beside ${one(name)}, so nothing changed.`);
        st.pendingOffer = null;
        const diff = p.diff ? p.diff.split('\n') : [];
        return {
          code: 0, op, proposal: true, lines: [
            ...diff,
            `Tell the person: you changed ${one(name)} by hand, so Trail left it alone and wrote the change beside it. To use it, they run this in their own terminal: cp ${shown(p.path, env)} ${shown(ref.file, env)} (their edited file is kept in .versions/${p.hand})`,
          ],
        };
      }
      const w = writeNewVersion(ref, d.plan.next, { op, offerId, baseHash: d.plan.baseHash, lessonIds: d.plan.plan?.op === 'extend' ? d.plan.plan.lessonIds : undefined, env, now });
      if (!w.ok) return fail(w.why === 'changed' ? changedDeny(name) : WRITE_WHY[w.why]);
      st.pendingOffer = null;
      const what = whatChanged(op, d.plan);
      const n = w.version;
      return {
        code: 0, op, lines: [
          `✓ changed ${one(name)} to v${n} · ${what}`,
          `Tell the person what Trail changed: ${one(name)} is now v${n}: ${what}. It's a candidate again until its next checked use. The old version is kept; to go back: trail skills restore ${one(name)} --version ${n - 1}`,
        ],
      };
    });
  } catch (e) {
    out = fail(`${NOT}${one(e instanceof Error ? e.message : String(e), 160).replace(/^trail:\s*/, '')}`);
  }
  // 4.11 CLI step 4: used once, a refusal included; a busy session lock leaves it for the same command again.
  if (out === undefined) return fail(UPDATE_DENY.busy);
  markUpdateReceiptUsed(r, now, env);
  return out;
}
