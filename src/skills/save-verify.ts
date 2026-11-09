/**
 * The save gate's decision (design 4.9 steps 1 to 10, `verifySave`), shared
 * by the PreToolUse half and the CLI half so they can't disagree.
 * Re-exported from `save-gate.ts`, where the design names it.
 *
 * Consent is never taken from a flag, an agent message or a file the agent
 * can write alone: it needs the prompt hook's own record of the person's
 * words (a hash) and the line the person typed in the transcript, read at
 * its offset. Every step must have run here and worked, read from the
 * transcript itself, not from the run sheet. Each line is read through the
 * session's host dialect (4.16): Claude Code's lines by their own flags,
 * Codex's typed lines only by the prompt hook's hashes (P30).
 */
import { homedir } from 'node:os';
import type { FoldResult } from '../trace/runs.js';
import type { GateCtx } from '../trace/skill-session.js';
import type { JobClass, PendingOffer, RunCall, RunSheet, SkillSessionState } from '../trace/types.js';
import type { CompiledSkill, Receipt } from './types.js';
import type { SkillsAddCmd } from './save-parse.js';
import { findPriorSheet, joinCarriedSheet, readRunSheet } from '../trace/runs.js';
import { isTypedByPerson, textOf, type TraceEvent } from '../trace/claude.js';
import { CLAUDE_DIALECT, CLAUDE_USE, dialectFor, typedOnLine, type DialectUse } from '../trace/dialect.js';
import { classifyAnswer, isSaveRequest, typedSha } from '../trace/typed.js';
import { redactSecrets, cleanLine } from '../trace/redact.js';
import { splitTop } from '../trace/shell.js';
import { callText } from '../trace/checks.js';
import { callParts, grepNoMatch, MAX_RAW } from '../trace/run-calls.js';
import { failedText } from '../trace/failure.js';
import { isHookScriptTamper } from '../trace/tamper.js';
import { secretReason } from '../notes/secrets.js';
import { flatLine } from '../notes/flatten.js';
import { repoName } from '../notes/home.js';
import { compileRun, refusalWords } from './compile.js';
import { goodName } from './compile-words.js';
import { renderSkillMd } from './skillmd.js';
import { heldRunId, nameTaken, readSkillsStateSafe } from './save-store.js';
import { stepsTotal } from './store-fs.js';
import { linkedOwnFolder } from './own-folder.js';
import { lineAt, lineSha, linesBefore } from './receipts.js';
import { endsWithLine, isKeepLine, KEEP_IT } from './offer-words.js';
import { skillSha } from './offer-moment.js';
import { hostFacts } from './host-facts.js';
import { offerLinesOf } from './offer-lines.js';
import { runCheckout } from './run-checkout.js';
import { stepLearnings } from './follow-learnings.js';

export interface SaveVerdict {
  deny?: string;                // set: refuse, nothing saved
  consent: Receipt['consent'];
  offerId: string | null;
  typed: Receipt['typed'];
  stepsTotal: number;
  stepsVerified: number;
  verdict: 'live' | 'held';
  heldWhy?: 'no-yes' | 'host';
  compiled?: CompiledSkill;
  /** D93: the checkout the run was compiled in (`runCheckout`), for the receipt; '' for none. */
  checkout?: string;
}

const NOT = 'trail · not saved: ';
export const DENY = {
  subagent: `${NOT}only the main session can keep a skill.`,
  noPerson: `${NOT}this session runs without a person at the keyboard (headless, CI or a scratch folder), so Trail keeps nothing from it.`,
  busy: `${NOT}Trail was busy. Run the same command again.`,
  flags: `${NOT}\`trail skills add\` takes only a name and --run <id>.`,
  name: `${NOT}pick a name with lowercase letters, digits and dashes, with at least one letter.`,
  run: `${NOT}that run isn't from this session.`,
  /** D94: a host whose transcript Trail can't read (Cursor, tier D) has no run of this session to keep. */
  unreadable: `${NOT}Trail can't read this tool's session history, so it can't keep skills from it.`,
  secret: `${NOT}a step still holds something that looks like a secret.`,
  changed: `${NOT}the steps changed after the offer, so they aren't the ones the person said yes to. If they want these, they can say "save this as a skill".`,
  askedChanged: `${NOT}the steps changed after you asked. Ask again once the job is done.`,
} as const;
/** The person's own ask names `name`: as typed, or with spaces for its dashes. */
const namedIn = (typed: string, name: string) => {
  const t = ` ${typed.toLowerCase().replace(/[^a-z0-9-]+/g, ' ')} `;
  return t.includes(` ${name} `) || t.includes(` ${name.replace(/-/g, ' ')} `);
};
const askedNameDeny = (name: string, use: string, runId: string) =>
  `${NOT}the person asked to keep this as ${flatLine(name, 60)}. Run: trail skills add ${flatLine(use, 60)} --run ${flatLine(runId, 40)}`;
const offeredNameDeny = (name: string, use: string, runId: string) =>
  `${NOT}the offer was for the name ${flatLine(name, 60)}. Run: trail skills add ${flatLine(use, 60)} --run ${flatLine(runId, 40)}`;
/** The refusal for a tamper mark: a hook script run by hand in its own words (D93), a write naming what it wrote. */
export const tamperDeny = (what: string) => isHookScriptTamper(what)
  ? `${NOT}this session ran Trail's hook script by hand, so Trail can't trust its record of what ran.`
  : `${NOT}this session changed Trail's own files (${flatLine(what, 120)}), so Trail can't trust its record of what ran.`;
const linkDeny = (folder: string) => `${NOT}${flatLine(folder, 60)} in Trail's home is a link, not Trail's own folder, so Trail won't write through it.`;
/** D70: a run this session did in another checkout, named in words (`acme/storefront`). */
function otherRepoDeny(runRepo: string, scope: string[]): string {
  const names = [...new Set(scope.map((k) => flatLine(repoName(k), 60)).filter(Boolean))].slice(0, 3);
  const here = names.length ? `, and this session works in ${names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}` : '';
  return `${NOT}that run was done in ${flatLine(repoName(runRepo), 60)}${here}, so Trail can't keep it from here.`;
}
const keptDeny = (name: string) => `${NOT}that run is already kept as the skill ${flatLine(name, 60)}.`;
const neverRanDeny = (cmds: string[]) => `${NOT}these steps never ran here and worked: ${cmds.join('; ')}.`;
const takenDeny = (name: string, where: string, runId: string, other: string) =>
  `${NOT}the name ${name} is taken (${where}). Use another: trail skills add ${other} --run ${flatLine(runId, 40)}`;

const WHERE: Record<string, string> = {
  personal: 'one of your skills', retired: 'a skill you forgot, which trail skills restore brings back', held: 'a skill Trail is holding for you to keep',
  repo: "this repo's skills", team: "your team's skills", host: 'a skill your agent already has', 'built-in': "one of Trail's own commands", invalid: 'not a folder name',
};

/** `name` is free to take for this run: nobody has it, or only a held copy of this same run (D65). */
function nameFreeFor(name: string, runId: string, scope: Parameters<typeof nameTaken>[1]): boolean {
  const where = nameTaken(name, scope);
  return where === null || (where === 'held' && heldRunId(name, scope.env) === runId);
}

/** The first free `name-2` .. `name-20` for this run; '<other>' when none is. */
function numbered(name: string, runId: string, scope: Parameters<typeof nameTaken>[1]): string {
  for (let k = 2; k <= 20; k++) if (goodName(`${name}-${k}`) && nameFreeFor(`${name}-${k}`, runId, scope)) return `${name}-${k}`;
  return '<other>';
}
/** `name` is `base` with a number on the end (`release-npm-3`). */
const sameNumbered = (name: string, base: string) => name.startsWith(`${base}-`) && /^[1-9]\d?$/.test(name.slice(base.length + 1));

const denied = (deny: string, extra: Partial<SaveVerdict> = {}): SaveVerdict =>
  ({ deny, consent: 'none', offerId: null, typed: null, stepsTotal: 0, stepsVerified: 0, verdict: 'held', ...extra });

const parse = (line: string | null): Record<string, any> | null => {
  if (line === null) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** A consent and the line it rests on: when the person wrote it, and for an offer's yes, whether it followed "show me". */
interface Consent extends Pick<SaveVerdict, 'consent' | 'offerId' | 'typed'> { at: number; afterShow: boolean }
const NONE: Consent = { consent: 'none', offerId: null, typed: null, at: Number.NaN, afterShow: false };
const pick = (c: Consent): Pick<SaveVerdict, 'consent' | 'offerId' | 'typed'> => ({ consent: c.consent, offerId: c.offerId, typed: c.typed });

/** The dialect a session's lines are read with (4.16), and the state its typed lines are judged by. */
export const dialectUse = (host: string, st: SkillSessionState | null): DialectUse => ({ dialect: dialectFor(host) ?? CLAUDE_DIALECT, st });

/**
 * Step 5's second half: the line at `offset` is one the person typed, its words hash to `sha`; and when it was written.
 * `use`: the host's dialect and the session state (Claude's by default).
 */
export function personLine(tx: string, offset: number, sha: string, mustBe: (text: string) => boolean, env: NodeJS.ProcessEnv, said?: (text: string) => void,
  use: DialectUse = CLAUDE_USE): { typed: NonNullable<Receipt['typed']>; at: number } | null {
  const line = lineAt(tx, offset);
  const entry = parse(line);
  const text = entry ? typedOnLine(entry, use, env) : '';
  if (!entry || !text) return null;
  if (typedSha(text) !== sha || !mustBe(text)) return null;
  said?.(text);
  return { typed: { offset, lineSha: lineSha(line!) }, at: Date.parse(String(entry.timestamp ?? '')) };
}

/**
 * Phase 2 (4.7): a yes to which offers keeps a run as a skill. 1a and 1b's moments; of phase 2's, only moment 5's
 * split, whose new skill is this offer's name. An update, a drift or a retire offer's yes is never a yes to an add.
 */
export const isSplitOffer = (po: PendingOffer | null | undefined): boolean =>
  !!po && po.moment === 'update' && po.fold?.op === 'split' && typeof po.fold.splitName === 'string' && po.fold.splitName === po.name;
const keepsASkill = (po: PendingOffer) => (po.moment === 'update' || po.moment === 'drift' || po.moment === 'retire' ? isSplitOffer(po) : true);

/** 4.9 step 5: offer-yes, asked, or none, from the hook's record and the person's line. The bindings come after compile. */
/** `said`: the person's save request as typed (D71 b: a job-less run's asks); never part of the verdict or the receipt. */
function consentOf(cmd: SkillsAddCmd, st: SkillSessionState, tx: string | null, env: NodeJS.ProcessEnv, said: ((text: string) => void) | undefined, use: DialectUse): Consent {
  if (!tx) return NONE;
  const po = st.pendingOffer;
  if (po && po.runId === cmd.runId && po.shownAt && po.yes && keepsASkill(po)) {
    const ta = po.typedAfter;
    const entry = ta[0]?.answer === 'show' ? ta[1] : ta[0];
    if (entry && entry.answer === 'yes' && entry.sha === po.yes.typedSha) {
      const afterShow = entry !== ta[0];
      const p = personLine(tx, entry.offset, entry.sha, (t) => classifyAnswer(t, afterShow) === 'yes', env, undefined, use);
      if (p) return { consent: 'offer-yes', offerId: po.offerId, typed: p.typed, at: p.at, afterShow };
    }
  }
  const sr = st.saveRequest;
  if (sr && sr.runId === cmd.runId && sr.typed && sr.typed.sha === sr.typedSha) {
    const p = personLine(tx, sr.typed.offset, sr.typed.sha, isSaveRequest, env, said, use);
    if (p) return { consent: 'asked', offerId: null, typed: p.typed, at: p.at, afterShow: false };
  }
  return NONE;
}

/**
 * The agent's last words before the person's line at `offset`: the text of the main session's last reply, when no
 * tool call, tool result or other typed line comes between them; null otherwise, or further back than 1 MB.
 */
export function replyBefore(tx: string, offset: number, env: NodeJS.ProcessEnv, use: DialectUse = CLAUDE_USE): string | null {
  const lines = linesBefore(tx, offset);
  if (use.dialect.host !== 'claude') return replyBeforeEvents(lines, env, use);
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]!);
    if (!e || e.isSidechain) continue;
    if (isTypedByPerson(e, env)) return null;
    const content = e.message?.content;
    const parts: any[] = Array.isArray(content) ? content : [];
    if (e.type === 'user') {
      if (parts.some((p) => p && p.type === 'tool_result')) return null;
      continue; // a hook's feedback, a command's output: not the agent's words
    }
    if (e.type !== 'assistant') continue; // system rows, attachments, the host's bookkeeping
    if (parts.some((p) => p && p.type === 'tool_use')) return null;
    const text = textOf(content);
    if (text.trim()) return text;
  }
  return null;
}

/** replyBefore for a dialect other than Claude's: each line decoded on its own, newest first. */
function replyBeforeEvents(lines: string[], env: NodeJS.ProcessEnv, use: DialectUse): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]!);
    if (!e) continue;
    const evs = use.dialect.lineEvents(e, {}, undefined, env);
    if (evs.some((ev) => ev.kind === 'tool_call' || ev.kind === 'tool_result')) return null;
    if (evs.some((ev) => ev.kind === 'typed' && use.dialect.typedByPerson(ev, use.st, env))) return null;
    const said = evs.flatMap((ev) => (ev.kind === 'assistant' ? [ev.text] : []));
    if (said.length) return said.join('\n');
  }
  return null;
}

const SKEW_MS = 5000;
/**
 * The person's line answers what it consents to (g5 review). Both: the run had started when they wrote it. An offer's
 * yes: the agent's reply right before it ended with the offer's own question (a Keep line; "Keep it? (yes / no)"
 * after the draft), unless the host shows the offer as Trail's own notice, so a yes to a question the agent added
 * is no yes to the skill.
 */
function answers(c: Consent, po: PendingOffer | null, sheet: RunSheet, tx: string, env: NodeJS.ProcessEnv, use: DialectUse): boolean {
  if (c.consent === 'none' || !c.typed) return false;
  if (!(Date.parse(sheet.startedAt) <= c.at + SKEW_MS)) return false;
  if (c.consent === 'asked') return true;
  // 1b (R12): the offer's lines through offerLinesOf; an offer with none has no yes.
  const lines = po ? offerLinesOf(po, tx, env, use) : null;
  // A split's line 2 is its own question (4.7), checked word for word below like a keep line.
  if (!po || !lines || !(isKeepLine(lines[1]) || isSplitOffer(po))) return false;
  if (po.channel === 'notice' && hostFacts(env, use.dialect.host).offerChannel === 'notice') return true;
  // After "show me", 1a's moments ask Keep it?; a split asks its own line 2 again (c3's show directive), as the update gate reads it.
  return endsWithLine(replyBefore(tx, c.typed.offset, env, use) ?? '', c.afterShow && !isSplitOffer(po) ? KEEP_IT : lines[1]);
}

const clip = (t: string) => (t.length > 40_000 ? `${t.slice(0, 8000)}\n…\n${t.slice(-32_000)}` : t);

/** The command as the fold stored it (4.10, D58c): redacted, or piece by piece when over 2,000 characters. */
function storedForm(raw: string, job: JobClass | null): string | null {
  if (raw.length > MAX_RAW) return callText({ cmd: null, parts: callParts(splitTop(raw), job) });
  return redactSecrets(raw).cmd;
}
const storedText = (c: RunCall): string | null => (c.cmd !== null ? c.cmd : c.parts?.length ? callText(c) : null);

/** The call and its result as `d` reads their two lines, decoded in order with one memo; null when either isn't there. */
function callLines(call: RunCall, tx: string, use: DialectUse, env: NodeJS.ProcessEnv):
  { block: { name: string; input: any }; out: { isError: boolean; text: string } } | null {
  const memo = {};
  const at = (offset: number): TraceEvent[] => {
    const e = parse(lineAt(tx, offset));
    return e ? use.dialect.lineEvents(e, memo, offset, env) : [];
  };
  const c = at(call.src.use).find((ev) => ev.kind === 'tool_call' && ev.id === call.id);
  const r = at(call.src.result!).find((ev) => ev.kind === 'tool_result' && ev.id === call.id);
  if (!c || c.kind !== 'tool_call' || !r || r.kind !== 'tool_result') return null;
  // A result whose exit never showed (ok false, no error flag) is no proof it worked.
  return { block: { name: c.name, input: c.input }, out: { isError: r.isError === true || !r.ok, text: r.text } };
}

/** 4.9 step 7 for one call: its tool_use and tool_result lines, read at their offsets, show it ran as stored and worked. */
export function ranAndWorked(call: RunCall | undefined, tx: string, job: JobClass | null, how: DialectUse = CLAUDE_USE, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!call || call.fromMark || call.failed || call.src.result === null || call.src.use < 0 || call.src.result < 0) return false;
  if (how.dialect.host !== 'claude') {
    const got = callLines(call, tx, how, env);
    return got !== null && workedAs(call, got.block, got.out.isError, got.out.text, job);
  }
  const use = parse(lineAt(tx, call.src.use));
  const res = parse(lineAt(tx, call.src.result));
  if (!use || !res || use.type !== 'assistant' || res.type !== 'user' || use.isSidechain || res.isSidechain) return false;
  const block = Array.isArray(use.message?.content) ? use.message.content.find((p: any) => p && p.type === 'tool_use' && p.id === call.id) : null;
  const out = Array.isArray(res.message?.content) ? res.message.content.find((p: any) => p && p.type === 'tool_result' && p.tool_use_id === call.id) : null;
  if (!block || !out) return false;
  return workedAs(call, block, out.is_error === true, typeof out.content === 'string' ? out.content : textOf(out.content), job);
}

/** The call as its lines show it ran: the stored command (or tool), and a result that worked. */
function workedAs(call: RunCall, block: { name?: unknown; input?: any }, isError: boolean, text: string, job: JobClass | null): boolean {
  if (call.tool) return block.name === call.tool && !isError;
  const raw = block.name === 'Bash' && typeof block.input?.command === 'string' ? (block.input.command as string) : null;
  if (raw === null) return false;
  const stored = storedText(call);
  if (stored === null || storedForm(raw, job) !== stored) return false;
  // A look fails by its exit or the host's flag only, as the fold judges it (D56c).
  if (call.kind === 'look' || call.kind === 'plumbing') return !(isError && !grepNoMatch(raw, text));
  return !isError && !failedText(clip(text));
}

/**
 * D93: the checkout `sheet` ran in, from the run itself (its sheet's checkout; for an older sheet, the ctx's when it
 * is the run's repo), so both halves compile the same steps wherever the CLI runs; '' when none holds.
 */
const rootFor = (sheet: RunSheet, ctx: GateCtx, env: NodeJS.ProcessEnv) => runCheckout(sheet, env, ctx.checkout && ctx.repoKey === sheet.repoKey ? ctx.checkout : '');

/** 4.9 steps 1 to 10. `cmd` null: the command matched `skills add` but didn't parse (step 1). */
export function verifySave(cmd: SkillsAddCmd | null, ctx: GateCtx, st: SkillSessionState, _fold: FoldResult | null, env: NodeJS.ProcessEnv = ctx.env): SaveVerdict {
  // 3.3 step 3.1, here too: the gate holds even when a caller skipped it.
  if (ctx.subagent) return denied(DENY.subagent);
  if (!ctx.fold) return denied(DENY.noPerson);
  if (!cmd || cmd.flags.length) return denied(DENY.flags);
  if (!goodName(cmd.name)) return denied(DENY.name);
  if (st.tampered) return denied(tamperDeny(st.tampered));
  const linked = linkedOwnFolder(env);
  if (linked) return denied(linkDeny(linked));
  const own = readRunSheet(cmd.runId, env);
  // D94: outside Claude Code no run of this session means Trail could not read its history, not a wrong run id.
  if (!own || own.session !== ctx.sessionHash || own.session !== st.sessionHash) return denied(ctx.tier !== 'A' ? DENY.unreadable : DENY.run);
  if (!st.scopeKeys.includes(own.repoKey)) return denied(otherRepoDeny(own.repoKey, st.scopeKeys));
  const keptAs = Object.values(readSkillsStateSafe(env)).find((s) => s.runId === cmd.runId && s.status !== 'retired');
  if (keptAs) return denied(keptDeny(keptAs.name));

  let askedWith: string | null = null;
  const how = dialectUse(ctx.host, st);
  let c = consentOf(cmd, st, ctx.transcriptPath, env, (t) => { askedWith = t; }, how);
  const po = st.pendingOffer;
  const root = rootFor(own, ctx, env);
  const scope = { repoKeys: st.scopeKeys, checkout: root || ctx.checkout, env };
  // An offer's yes keeps the skill under the offered name; when that was taken since, under a numbered one (`name-2`).
  // A split keeps exactly the name its offer showed (4.7): no numbered stand-in.
  const offered = c.consent === 'offer-yes' && po ? (isSplitOffer(po) || nameFreeFor(po.name, cmd.runId, scope) ? po.name : numbered(po.name, cmd.runId, scope)) : null;
  if (offered !== null && cmd.name !== po!.name && cmd.name !== offered && !(offered !== po!.name && sameNumbered(cmd.name, po!.name))) {
    return denied(offeredNameDeny(po!.name, offered, cmd.runId), pick(c));
  }
  // Each sheet read once, so compile and step 7 see the same run.
  const sheets = new Map<string, RunSheet | null>([[own.id, own]]);
  const read = (id: string) => {
    if (!sheets.has(id)) sheets.set(id, readRunSheet(id, env));
    return sheets.get(id)!;
  };
  const sr = st.saveRequest;
  const compiled = compileRun(own, {
    repoRoot: root, home: env.HOME || homedir(), platform: process.platform, readSheet: read, now: ctx.now,
    prior: findPriorSheet(own, env), name: cmd.name, moment: c.consent === 'offer-yes' ? 'repeated' : 'asked', askedWith,
    applies: c.consent === 'asked' && sr?.scope === 'every repo' ? 'every repo' : own.repoKey,
    // The asked name is free here so compile keeps it; step 9 says where it is taken.
    taken: (n) => n !== cmd.name && nameTaken(n, scope) !== null,
    learnings: stepLearnings({ repoKeys: [own.repoKey], checkout: root, env }),
  });
  if (!compiled.ok) return denied(`${NOT}${refusalWords(compiled.reason, compiled.detail)}.`, pick(c));
  const skill = compiled.skill;
  if (skill.name !== cmd.name) return denied(DENY.name, pick(c));
  if (c.consent !== 'none' && !answers(c, po, own, ctx.transcriptPath ?? '', env, how)) c = NONE;
  // What the yes agreed to: the offer's skill, not steps the run gained after it or a sheet changed since.
  if (c.consent === 'offer-yes' && po?.skillSha !== skillSha(skill)) return denied(DENY.changed, pick(c));
  // D73: the same for an asked save: the skill compiled when the person asked. A request with no sha (older state) too.
  if (c.consent === 'asked' && (typeof sr?.skillSha !== 'string' || sr.skillSha !== skillSha(skill))) return denied(DENY.askedChanged, pick(c));
  // An asked save keeps the name Trail gave it when the person asked (names drive the name cue), the numbered one the
  // taken refusal suggests when that name was taken since, or a name the person typed in the ask itself ("save this
  // as a skill called regen-client"). A request with no name (older state): refused.
  if (c.consent === 'asked') {
    const base = typeof sr?.name === 'string' ? sr.name : null;
    if (base === null) return denied(DENY.askedChanged, pick(c));
    const use = nameFreeFor(base, cmd.runId, scope) ? base : numbered(base, cmd.runId, scope);
    const typedAsk = askedWith as string | null;
    const named = typedAsk !== null && namedIn(typedAsk, cmd.name);
    if (cmd.name !== base && cmd.name !== use && !named && !(use !== base && sameNumbered(cmd.name, base))) return denied(askedNameDeny(base, use, cmd.runId), pick(c));
  }

  // Step 7: every step, and the check when it is not a step, ran here and worked.
  const joined = joinCarriedSheet(own, read);
  const byId = new Map(joined.calls.map((x) => [x.id, x]));
  const total = stepsTotal(skill);
  const checkCall = joined.checkIndex === null ? null : joined.calls[joined.checkIndex] ?? null;
  const units: Array<{ ids: string[]; text: string }> = skill.steps.map((s) => ({ ids: s.from ?? [], text: s.cmd }));
  if (skill.check && !skill.checkIsStep) units.push({ ids: checkCall ? [checkCall.id] : [], text: skill.check });
  const bad = units.filter((u) => !u.ids.length || !u.ids.every((id) => ranAndWorked(byId.get(id), ctx.transcriptPath ?? '', joined.job, how, env)));
  if (bad.length) return denied(neverRanDeny(bad.slice(0, 3).map((u) => cleanLine(u.text, 80) ?? 'a step')), { ...pick(c), stepsTotal: total, stepsVerified: total - bad.length });

  if (secretReason(renderSkillMd(skill))) return denied(DENY.secret, { ...pick(c), stepsTotal: total, stepsVerified: total });

  // Step 9. D65: a held item of this name kept from this same run is not in the way; the live save replaces it.
  const where = nameTaken(cmd.name, scope);
  if (where !== null && !(where === 'held' && heldRunId(cmd.name, env) === cmd.runId)) {
    return denied(takenDeny(cmd.name, WHERE[where] ?? where, cmd.runId, offered ?? '<other>'), { ...pick(c), stepsTotal: total, stepsVerified: total });
  }

  const live = c.consent !== 'none' && ctx.learn;
  return {
    ...pick(c), stepsTotal: total, stepsVerified: total, compiled: skill, checkout: root,
    verdict: live ? 'live' : 'held', ...(live ? {} : { heldWhy: ctx.learn ? 'no-yes' as const : 'host' as const }),
  };
}
