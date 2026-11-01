/**
 * The lesson save (design 4.15): 1a's dual consent applied to
 * `trail skills lesson [<skill>] --offer <offer-id>`. An agent can never
 * keep a lesson without the person's typed yes to the offer that showed its
 * exact text.
 *
 * The PreToolUse half (`lessonGatePre`) denies, or writes a lesson receipt
 * and lets the command run. The CLI half (`keepLessonCli`) never trusts the
 * receipt: it re-decides from the transcript under the session lock (the
 * same `decide` both halves call), rebuilds the lesson text, checks its sha,
 * and only then writes the lesson, under the store lock. Anything that
 * doesn't match is held: exit 1, nothing written.
 *
 * Receipts: `receipts/<session>.lesson.json`, one per session, used once,
 * ignored after 2 hours or from the future, accepted only for the very
 * transcript the hooks read for that session (D82, R31).
 */
import type { Host } from '../trace/host.js';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PreBashDecision } from '../claude/pre-bash.js';
import type { GateCtx } from '../trace/skill-session.js';
import { skillsGate, withSkillSession } from '../trace/skill-session.js';
import type { PendingOffer, SkillSessionState } from '../trace/types.js';
import type { LessonReceipt, Receipt } from './types.js';
import { classifyAnswer } from '../trace/typed.js';
import { readRunSheet } from '../trace/runs.js';
import { flatLine } from '../notes/flatten.js';
import { parseNote } from '../notes/notes.js';
import { readJsonSafe, trailPath, withLock, writePrivate } from '../util/private-fs.js';
import { hookError } from '../claude/skills-hook-util.js';
import { localDate, skillsOn } from './settings.js';
import { hostFacts } from './host-facts.js';
import { codexSandboxRefusal } from './codex-sandbox.js';
import { endsWithLine } from './offer-words.js';
import { isLessonOffer } from './offer-words-1b.js';
import { correctionLesson, offerLinesOf } from './offer-lines.js';
import { fixedWords, lessonWhere, repairLessonText, REPAIR_COPY } from './offer-repair.js';
import { LESSON_COPY, lessonRefused, lessonSha, newLessonId, writeLesson } from './lessons.js';
import { appendLedger } from './ledger.js';
import { underStoreLock } from './store-fs.js';
import { receiptPath, receiptTranscriptOk, receiptTranscriptRead, typedLineStillThere } from './receipts.js';
import { dialectUse, personLine, replyBefore } from './save-verify.js';
import { parseSkillsLesson, SKILLS_LESSON_RE, type SkillsLessonCmd } from './save-parse.js';
import { bashCommand, tailCalls, tamperInTail, type ToolCall } from './save-gate.js';
import { CLAUDE_DIALECT, dialectFor, type DialectUse } from '../trace/dialect.js';
import { detectHost } from '../trace/host.js';
import { noteWalls, programKey, readWalls, repairsSeen } from '../trace/wall-state.js';

/** A lesson receipt older than this is stale (2.11). */
const FRESH_MS = 2 * 60 * 60_000;
const AHEAD_MS = 5_000;

const NOT = 'trail · learning not kept: ';
export const LESSON_DENY = {
  flags: `${NOT}\`trail skills lesson\` takes only a skill name and --offer <id>.`,
  noOffer: `${NOT}there is no learning offer with that id in this session, so there is nothing the person said yes to.`,
  noYes: "the person didn't say yes to this learning in this session",
  changed: 'the learning changed after the offer, so it is not the one the person said yes to',
  refused: 'its text would tell an agent to skip a check or run a step that cannot be undone',
  // D111: 1a's refusals in a lesson's words.
  subagent: `${NOT}only the main session can keep a learning.`,
  noPerson: `${NOT}this session runs without a person at the keyboard (headless, CI or a scratch folder), so Trail keeps nothing from it.`,
  busy: `${NOT}Trail was busy. Run the same command again.`,
} as const;
const skillDeny = (name: string, id: string) => `${NOT}the offer was for the skill ${flatLine(name, 60)}. Run: trail skills lesson ${flatLine(name, 60)} --offer ${flatLine(id, 40)}`;
const wallDeny = (id: string) => `${NOT}that offer keeps a learning about an error, not one on a skill. Run: trail skills lesson --offer ${flatLine(id, 40)}`;
const tamperDeny = (what: string) => `${NOT}this session changed Trail's own files (${flatLine(what, 120)}), so Trail can't trust its record of what was offered.`;

/* -------------------------------------------------------------- the decision */

type Decided =
  | { deny: string }
  | { po: PendingOffer; typed: { offset: number; lineSha: string }; text: string; sha: string };

/** The lesson the offer showed, rebuilt now: from the correction line by its pointer, or from the repair's delta. */
function lessonOf(po: PendingOffer, tx: string, env: NodeJS.ProcessEnv, use?: DialectUse): { text: string; pinned: string | undefined } | null {
  if (po.moment === 'correction' && po.correction) {
    const l = correctionLesson(po.correction, tx, env, use);
    return l ? { text: l.text, pinned: po.correction.lessonSha } : null;
  }
  if (po.moment === 'repaired' && po.repair?.as === 'lesson') {
    const text = repairLessonText(po.repair.cls, po.repair.delta ?? []);
    return text ? { text, pinned: po.repair.lessonSha } : null;
  }
  return null;
}

/** 4.15, both halves: the pending offer, the person's typed yes to it as the first line after it, the reply ending with its line 2, the lesson unchanged. */
function decide(cmd: SkillsLessonCmd | null, ctx: GateCtx, st: SkillSessionState): Decided {
  const env = ctx.env;
  if (ctx.subagent) return { deny: LESSON_DENY.subagent };
  if (!ctx.fold || !ctx.learn) return { deny: LESSON_DENY.noPerson };
  if (!cmd || cmd.flags.length) return { deny: LESSON_DENY.flags };
  if (st.tampered) return { deny: tamperDeny(st.tampered) };
  const po = st.pendingOffer;
  if (!po || po.offerId !== cmd.offerId || !isLessonOffer(po)) return { deny: LESSON_DENY.noOffer };
  if (po.moment === 'correction' && cmd.skill !== po.name) return { deny: skillDeny(po.name, po.offerId) };
  if (po.moment === 'repaired' && cmd.skill !== null) return { deny: wallDeny(po.offerId) };
  const tx = ctx.transcriptPath;
  const no = { deny: `${NOT}${LESSON_DENY.noYes}.` };
  if (!tx || !po.shownAt || !po.yes) return no;
  // The first typed line after the offer is the yes (a lesson offer has no "show me").
  const first = po.typedAfter[0];
  if (!first || first.answer !== 'yes' || first.sha !== po.yes.typedSha) return no;
  const how = dialectUse(ctx.host, st);
  const p = personLine(tx, first.offset, first.sha, (t) => classifyAnswer(t, false) === 'yes', env, undefined, how);
  if (!p) return no;
  const lines = offerLinesOf(po, tx, env, how);
  const lesson = lessonOf(po, tx, env, how);
  if (!lines || !lesson || lessonSha(lesson.text) !== lesson.pinned) return { deny: `${NOT}${LESSON_DENY.changed}.` };
  if (lessonRefused(lesson.text)) return { deny: `${NOT}${LESSON_DENY.refused}.` };
  // D72: the agent's reply right before the yes ended with the offer's own question (unless the host showed it as Trail's notice).
  const notice = po.channel === 'notice' && hostFacts(env, ctx.host as Host).offerChannel === 'notice';
  if (!notice && !endsWithLine(replyBefore(tx, first.offset, env, how) ?? '', lines[1])) return no;
  return { po, typed: p.typed, text: lesson.text, sha: lesson.pinned! };
}

/* ------------------------------------------------------------ the receipts */

const lessonReceiptPath = (session: string, env?: NodeJS.ProcessEnv) => receiptPath(session, env).replace(/\.json$/, '.lesson.json');
const str = (v: unknown): v is string => typeof v === 'string';

function asLessonReceipt(v: unknown): LessonReceipt | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as LessonReceipt;
  if (r.v !== 1 || r.kind !== 'lesson' || !str(r.session) || !str(r.transcriptPath) || !str(r.toolUseId) || !str(r.offerId) || !str(r.at)) return null;
  if (r.skill !== null && !str(r.skill)) return null;
  if (!r.typed || typeof r.typed !== 'object' || typeof r.typed.offset !== 'number' || !str(r.typed.lineSha) || !str(r.lessonSha)) return null;
  if ((r.verdict !== 'live' && r.verdict !== 'held') || (r.usedAt !== null && !str(r.usedAt))) return null;
  return r;
}

function readLessonReceipt(path: string): LessonReceipt | null {
  try {
    if (!lstatSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return asLessonReceipt(readJsonSafe<unknown>(path));
}

/** The unused, fresh lesson receipt for this offer (any session's file; the newest). */
export function findLessonReceipt(offerId: string, now: Date, env?: NodeJS.ProcessEnv): LessonReceipt | null {
  const dir = trailPath(env, 'receipts');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: LessonReceipt | null = null;
  for (const n of names) {
    if (!n.endsWith('.lesson.json')) continue;
    const r = readLessonReceipt(join(dir, n));
    if (!r || r.usedAt !== null || r.offerId !== offerId) continue;
    const age = now.getTime() - Date.parse(r.at);
    if (Number.isNaN(age) || age > FRESH_MS || age < -AHEAD_MS) continue;
    if (!best || Date.parse(r.at) > Date.parse(best.at)) best = r;
  }
  return best;
}

function markLessonReceiptUsed(r: LessonReceipt, now: Date, env?: NodeJS.ProcessEnv): void {
  const path = lessonReceiptPath(r.session, env);
  withLock(path, () => {
    const cur = readLessonReceipt(path);
    if (!cur || cur.toolUseId !== r.toolUseId || cur.at !== r.at || cur.usedAt !== null) return;
    writePrivate(path, `${JSON.stringify({ ...cur, usedAt: now.toISOString() }, null, 2)}\n`);
  }, 1000);
}

/**
 * The host whose transcript a lesson receipt names, from its path (a lesson receipt keeps no host): Codex for a
 * rollout, else Claude Code. The path still has to pass that host's own transcript checks.
 */
const hostOfReceipt = (r: LessonReceipt): 'claude' | 'codex' =>
  detectHost({ session_id: r.session, transcript_path: r.transcriptPath, hook_event_name: 'Stop' }).host === 'codex' ? 'codex' : 'claude';
/** The lesson receipt as 1a's transcript checks read a receipt: its host, tier A (lessons are offered only where learning is on). */
const asReceipt = (r: LessonReceipt) => ({ ...r, host: hostOfReceipt(r), tier: 'A' }) as unknown as Receipt;

/* ----------------------------------------------------------- PreToolUse half */

/** PreToolUse half for `trail skills lesson ... --offer <id>`: needs the hook's yes and the typed yes (4.15). A deny, or null after writing the receipt. */
export async function lessonGatePre(input: any, ctx: GateCtx): Promise<PreBashDecision | null> {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !SKILLS_LESSON_RE.test(command)) return null;
  if (ctx.subagent) return { permissionDecision: 'deny', reason: LESSON_DENY.subagent };
  if (!ctx.fold) return { permissionDecision: 'deny', reason: LESSON_DENY.noPerson };
  const cmd = parseSkillsLesson(command);
  const r = withSkillSession(ctx, { catchUp: true, waitMs: 300 }, (st) => {
    const d = decide(cmd, ctx, st);
    if ('deny' in d) return { permissionDecision: 'deny' as const, reason: d.deny };
    const receipt: LessonReceipt = {
      v: 1, kind: 'lesson', session: ctx.sessionId, transcriptPath: ctx.transcriptPath ?? '', toolUseId: typeof input?.tool_use_id === 'string' ? input.tool_use_id : '',
      offerId: d.po.offerId, skill: cmd!.skill, typed: d.typed, lessonSha: d.sha, at: ctx.now.toISOString(), verdict: 'live', usedAt: null,
    };
    writePrivate(lessonReceiptPath(ctx.sessionId, ctx.env), `${JSON.stringify(receipt, null, 2)}\n`);
    return null;
  });
  return r === undefined ? { permissionDecision: 'deny', reason: LESSON_DENY.busy } : r;
}

/** 3.3 step 2 for a lesson command, from the hook's payload: the gate, then `lessonGatePre`. Skills off or no session: null (the CLI holds). */
export async function lessonGate(input: any, dir: string, env: NodeJS.ProcessEnv = process.env, now?: Date): Promise<PreBashDecision | null> {
  try {
    const g = skillsGate(input, dir, env, now);
    return g.ok ? await lessonGatePre(input, g.ctx) : null;
  } catch (e) {
    hookError('pre-bash', e, env);
    return null;
  }
}

/* ------------------------------------------------------------------ CLI half */

/** The transcript shows the main session's agent running exactly this lesson command, with the receipt's tool_use id. */
function lessonInTranscript(r: LessonReceipt, skill: string | null, offerId: string, calls: ToolCall[]): boolean {
  if (!r.toolUseId) return false;
  return calls.some((t) => {
    const raw = t.id === r.toolUseId ? bashCommand(t) : null;
    const c = raw === null ? null : parseSkillsLesson(raw);
    return c !== null && !c.flags.length && c.skill === skill && c.offerId === offerId;
  });
}

const held = (why: string): { code: 1; line: string } => ({ code: 1, line: `${NOT}${why}.` });

/** A wall lesson's learning id, read back from the file it was written to. */
function learningIdOf(path: string): string {
  try {
    return parseNote(readFileSync(path, 'utf8'), path)?.id ?? basename(path, '.md');
  } catch {
    return basename(path, '.md');
  }
}

/** R48: a moment-3 lesson starts with the epochs the same fix worked in: the earlier same-delta ones, and this one. */
function startWorked(po: PendingOffer, lessonId: string, ctx: GateCtx, now: Date): void {
  const rep = po.repair;
  const repo = po.repo ?? '';
  if (!rep || !repo) return;
  const sheet = readRunSheet(po.runId, ctx.env);
  const epoch = sheet?.epoch ?? 0;
  const d = localDate(sheet?.endedAt ?? now.toISOString());
  const program = programKey(rep.program);
  noteWalls({ fixed: [{ cls: rep.cls, d, sh: ctx.sessionHash, epoch, repo, program, delta: rep.delta.map((x) => ({ kind: x.kind, name: x.name })) }] }, ctx.env);
  const seen = repairsSeen(readWalls(ctx.env), repo, rep.cls, program, ctx.sessionHash, epoch, now);
  if (seen.from.length) noteWalls({ worked: seen.from.map((f) => ({ cls: rep.cls, lessonId, sh: f.sh, epoch: f.epoch, d: f.d })) }, ctx.env);
}

/** CLI half: re-decides from the transcript, checks lessonSha, writes the lesson. Exit 0 saved, 1 held. */
export function keepLessonCli(skill: string | null, offerId: string, env: NodeJS.ProcessEnv, now: Date = new Date()): { code: 0 | 1; line: string } {
  if (!skillsOn(env)) return { code: 1, line: 'Skills are off. Turn them on with: trail skills on' };
  const found = findLessonReceipt(offerId, now, env);
  if (!found) return held(LESSON_DENY.noYes);
  const sandboxed = codexSandboxRefusal(hostOfReceipt(found), `trail skills lesson ${skill ? `${skill} ` : ''}--offer ${offerId}`, env);
  if (sandboxed) return { code: 1, line: sandboxed };
  const r = receiptTranscriptOk(asReceipt(found), env) && receiptTranscriptRead(asReceipt(found), env) ? found : null;
  if (!r) {
    markLessonReceiptUsed(found, now, env);
    const where = hostOfReceipt(found) === 'codex' ? 'Codex' : 'Claude Code';
    return held(`Trail couldn't find this conversation where ${where} keeps it, so it can't check that the person said yes`);
  }
  const host = hostOfReceipt(r);
  const calls = tailCalls(r.transcriptPath, dialectFor(host) ?? CLAUDE_DIALECT, env);
  if (!lessonInTranscript(r, skill, offerId, calls)) return held(LESSON_DENY.noYes);
  const tampered = tamperInTail(calls, r.transcriptPath, env);
  if (tampered) {
    markLessonReceiptUsed(r, now, env);
    return held(`this session changed Trail's own files (${flatLine(tampered, 120)}), so Trail can't trust its record of what was offered`);
  }
  const ctx: GateCtx = {
    sessionId: r.session, sessionHash: createHash('sha256').update(r.session).digest('hex').slice(0, 12), host, tier: 'A',
    entry: 'interactive', permissionMode: null, subagent: false, fold: true, learn: true, learnOff: null, dir: '', checkout: '', repoKey: '',
    transcriptPath: r.transcriptPath, env, now,
  };
  type Out = { held: string } | { saved: { po: PendingOffer; text: string; path: string; id: string } };
  let out: Out | undefined;
  try {
    out = withSkillSession<Out>(ctx, { catchUp: true, waitMs: 1000 }, (st) => {
      const d = decide({ skill, offerId, flags: [] }, ctx, st);
      if ('deny' in d) return { held: d.deny.replace(NOT, '').replace(/\.$/, '') };
      const backed = d.typed.offset === r.typed.offset && d.typed.lineSha === r.typed.lineSha && d.sha === r.lessonSha && typedLineStillThere(r.transcriptPath, r.typed);
      if (!backed) return { held: LESSON_DENY.changed };
      if (lessonRefused(d.text)) return { held: LESSON_DENY.refused };
      // The consent is spent with the write, under the same lock; a write that throws puts the state back.
      const po = d.po;
      st.pendingOffer = null;
      const id = po.moment === 'correction' ? newLessonId() : '';
      const lesson = {
        id, skill: po.moment === 'correction' ? po.name : null, at: localDate(now), text: d.text, kind: 'lesson' as const,
        src: po.moment === 'correction' ? 'correction' as const : 'repair' as const, wall: po.moment === 'repaired' ? po.repair!.cls : null,
      };
      // b3: two keeps can't race for one file name.
      const path = underStoreLock(env, () => writeLesson(lesson, po.repo ?? '', env));
      return { saved: { po, text: d.text, path, id: id || learningIdOf(path) } };
    });
  } catch (e) {
    return held(`Trail couldn't write it (${flatLine(e instanceof Error ? e.message : String(e), 160).replace(/^trail:\s*/, '')})`);
  }
  if (out === undefined) return held('Trail was busy. Run the same command again');
  markLessonReceiptUsed(r, now, env);
  if ('held' in out) return held(out.held);
  const { po, id } = out.saved;
  if (po.moment === 'correction') {
    try {
      appendLedger(po.correction!.skillId, { at: now.toISOString(), event: 'lesson', skill: po.correction!.skillId, lessonId: id, src: 'correction', consent: 'offer-yes' }, env);
    } catch { /* the lesson is kept; the ledger line is a record */ }
    return { code: 0, line: fill(LESSON_COPY.saved!, { skill: flatLine(po.name, 60), id }) };
  }
  try {
    startWorked(po, id, ctx, now);
  } catch { /* the lesson is kept; it shows once it works again */ }
  return { code: 0, line: fill(REPAIR_COPY.savedWall!, { where: `in ${lessonWhere(po.repair!.cls)}`, fixed: fixedWords(po.repair!.cls), id }) };
}

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
