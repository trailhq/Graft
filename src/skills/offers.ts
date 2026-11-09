/**
 * Skill offers (design 2.5, 4.12, 4.13, spec 9): the log of every offer
 * shown and answered (`~/.trail/offers.jsonl`, the never-ask-again list), the
 * budget every offer shares, and the bookkeeping an answer leaves.
 *
 * The budget, in this order: offers off (everywhere or in this repo), a repo
 * paused after two nos, 1 offer per session, 1 in the first week after skills
 * go on, 3 a week, never again after a no for that (repo, job), one more
 * chance 14+ days after an ignored offer and then never, and the governor:
 * when fewer than 1 in 3 of the last 9 answered offers were kept, a job has
 * to come back one more day before it is offered.
 *
 * The log is the truth. `settings.json` keeps only the pause and a cache of
 * the governor's window; only this file writes them (a static test pins it).
 * The words of an offer and of the answers to it are in `offer-words.ts`.
 */
import { randomBytes } from 'node:crypto';
import type { OfferChannel, PendingOffer } from '../trace/types.js';
import type { Answer, OfferLine } from './types.js';
import { localDate, noteGovernor, pauseRepo, readSettings } from './settings.js';
import { appendPrivateLine, trailPath } from '../util/private-fs.js';
import { readFileSync } from 'node:fs';

export {
  answerDirective, endsWithLine, isKeepLine, keepLine, noticeText, offerLines, postToolOfferText, stopBlockReason, GOVERNOR_LINE, KEEP_IT, type OfferFacts,
} from './offer-words.js';
import { GOVERNOR_LINE } from './offer-words.js';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const IGNORED_AFTER_MS = DAY_MS;
const SECOND_CHANCE_MS = 14 * DAY_MS;
const PAUSE_DAYS = 14;
const WEEK_CAP = 3;
const GOVERNOR_WINDOW = 9;
const EVENTS = new Set(['shown', 'answer', 'not-shown', 'closed']);
/** Phase 2 (R2): moments 5 and 6 and the retire proposal are kept as themselves; a moment this file doesn't know is
 *  written as 'repeated' (line below), so each new one must be listed here first. */
const MOMENTS = new Set(['repeated', 'repaired', 'correction', 'update', 'drift', 'retire']);
/** 2.4: what an answer line's yes chose. */
const OPS = new Set(['update', 'extend', 'split', 'replace', 'retire']);
const ANSWERS = new Set(['yes', 'no', 'show', 'none', 'withdrawn']);
const CHANNELS = new Set(['stop', 'notice', 'post-tool']);

/** <home>/offers.jsonl */
export function offersPath(env?: NodeJS.ProcessEnv): string {
  return trailPath(env, 'offers.jsonl');
}

const str = (v: unknown): v is string => typeof v === 'string';

function asLine(v: unknown): OfferLine | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const l = v as OfferLine;
  if (!str(l.id) || !str(l.at) || Number.isNaN(Date.parse(l.at)) || !EVENTS.has(l.event)) return null;
  if (!str(l.repo) || !str(l.key) || !str(l.runId) || !str(l.name) || !CHANNELS.has(l.channel)) return null;
  // 1b (4.20): a closed line is only ever init's, a no; every other line is an offer of moment 2, 3 or 4.
  if (l.event === 'closed') return l.moment === 'init' && l.answer === 'no' ? l : null;
  if (!MOMENTS.has(l.moment)) return null;
  if (l.event === 'answer' && !ANSWERS.has(l.answer as string)) return null;
  // 2.4: an op outside the set is dropped, the line kept (its answer still counts).
  if (Object.hasOwn(l, 'op') && !(l.event === 'answer' && OPS.has(l.op as string))) {
    const { op: _op, ...rest } = l;
    return rest;
  }
  return l;
}

export function readOffers(env?: NodeJS.ProcessEnv): OfferLine[] {
  let text: string;
  try {
    text = readFileSync(offersPath(env), 'utf8');
  } catch {
    return [];
  }
  const out: OfferLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const l = asLine(JSON.parse(raw));
      if (l) out.push(l);
    } catch { /* a bad line is skipped */ }
  }
  return out;
}

/** OfferLine's `answer` as the final one, null when never answered (`OfferLine & { answer: Answer | null }` can't hold null). */
export type OfferRecord = Omit<OfferLine, 'answer'> & { answer: Answer | null };

/**
 * Folds 'shown' + 'answer' + 'not-shown' lines by id: one record per offer with its final answer. The record's
 * `at` is when it was shown; `not-shown` (the agent left it out) wins over `shown`; the last answer wins.
 */
export function foldOffers(lines: OfferLine[]): OfferRecord[] {
  const byId = new Map<string, OfferRecord>();
  for (const l of lines) {
    let r = byId.get(l.id);
    if (r === undefined) {
      const { answer: _a, ...base } = l;
      r = { ...base, event: l.event === 'answer' ? 'shown' : l.event, answer: null };
      byId.set(l.id, r);
    }
    if (l.event === 'not-shown' && r.event !== 'closed') r.event = 'not-shown';
    if (l.event === 'closed') r.answer = 'no';
    if (l.event === 'answer' && l.answer) {
      r.answer = l.answer;
      if (l.op) r.op = l.op;
    }
  }
  return [...byId.values()];
}

/** yes, no or none (an ignored offer: answered none, or shown and never answered for 24 h); null otherwise, and for init's closed lines. */
function settled(r: OfferRecord, now: Date): 'yes' | 'no' | 'none' | null {
  if (r.event === 'closed') return null; // "said no" for its key only (4.20, P10)
  if (r.answer === 'yes' || r.answer === 'no' || r.answer === 'none') return r.answer;
  if (r.answer === null && r.event === 'shown' && now.getTime() - Date.parse(r.at) > IGNORED_AFTER_MS) return 'none';
  return null;
}

const byTime = (a: OfferRecord, b: OfferRecord) => Date.parse(a.at) - Date.parse(b.at);

/** The governor's window: the last 9 offers that were kept, refused or ignored, oldest first. */
function lastNine(records: OfferRecord[], now: Date): Array<'yes' | 'no' | 'none'> {
  return records.slice().sort(byTime).flatMap((r) => {
    const s = settled(r, now);
    return s ? [s] : [];
  }).slice(-GOVERNOR_WINDOW);
}

const governorOn = (nine: Array<'yes' | 'no' | 'none'>) => nine.length >= 3 && nine.filter((a) => a === 'yes').length * 3 < nine.length;

export interface BudgetCtx { repoKey: string; key: string; sessionOfferUsed: boolean; now?: Date; env?: NodeJS.ProcessEnv }
export type BudgetVerdict =
  | { ok: true; extraDay: boolean; secondChance: boolean }
  | { ok: false; why: 'session' | 'week' | 'first-week' | 'said-no' | 'paused' | 'off' | 'off-here' | 'no-answer-twice' | 'too-soon' };

/** 4.13, steps 1 to 8 in order. */
export function offerBudget(c: BudgetCtx): BudgetVerdict {
  const now = c.now ?? new Date();
  const s = readSettings(c.env);
  if (s.offers === 'off') return { ok: false, why: 'off' };
  if (s.offRepos.includes(c.repoKey)) return { ok: false, why: 'off-here' };
  const until = s.pausedUntil[c.repoKey];
  if (until && until > localDate(now)) return { ok: false, why: 'paused' };
  if (c.sessionOfferUsed) return { ok: false, why: 'session' };

  const records = foldOffers(readOffers(c.env));
  const shown = records.filter((r) => r.event === 'shown');
  const since = s.onSince === null ? NaN : Date.parse(s.onSince);
  if (!Number.isNaN(since) && now.getTime() - since < WEEK_MS && shown.some((r) => Date.parse(r.at) >= since)) return { ok: false, why: 'first-week' };
  const weekAgo = now.getTime() - WEEK_MS;
  if (shown.filter((r) => Date.parse(r.at) > weekAgo && Date.parse(r.at) <= now.getTime() + 5000).length >= WEEK_CAP) return { ok: false, why: 'week' };

  const mine = records.filter((r) => r.key === c.key);
  if (mine.some((r) => r.answer === 'no')) return { ok: false, why: 'said-no' };
  const ignored = mine.filter((r) => settled(r, now) === 'none');
  let secondChance = false;
  if (ignored.length >= 2) return { ok: false, why: 'no-answer-twice' };
  if (ignored.length === 1) {
    if (now.getTime() - Date.parse(ignored[0]!.at) < SECOND_CHANCE_MS) return { ok: false, why: 'too-soon' };
    secondChance = true;
  }
  return { ok: true, extraDay: governorOn(lastNine(records, now)), secondChance };
}

function line(o: PendingOffer, repoKey: string, event: OfferLine['event'], now: Date, answer?: Answer, op?: OfferLine['op']): OfferLine {
  const moment = MOMENTS.has(o.moment) ? o.moment : 'repeated';
  const l: OfferLine = { id: o.offerId, at: now.toISOString(), event, repo: repoKey, key: o.key, moment, runId: o.runId, name: o.name, channel: o.channel as OfferChannel };
  if (answer) l.answer = answer;
  if (answer && op && OPS.has(op)) l.op = op;
  return l;
}

function append(l: OfferLine, env?: NodeJS.ProcessEnv): void {
  appendPrivateLine(offersPath(env), JSON.stringify(l));
}

/** The governor cache in settings.json: the window as it is now; said-at kept while the governor stays on. */
function refreshGovernor(env: NodeJS.ProcessEnv | undefined, now: Date, saidAt?: string | null): void {
  const nine = lastNine(foldOffers(readOffers(env)), now);
  const s = readSettings(env);
  const keep = saidAt === undefined ? s.governorSaidAt : saidAt;
  const next = governorOn(nine) ? keep : null;
  if (JSON.stringify(s.lastNine) === JSON.stringify(nine) && s.governorSaidAt === next) return;
  try {
    noteGovernor(nine, next, env);
  } catch { /* busy: the log stays the truth, the cache catches up next time */ }
}

export function recordShown(o: PendingOffer, repoKey: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): void {
  append(line(o, repoKey, 'shown', now), env);
  refreshGovernor(env, now);
}

/** A stop or post-tool offer the agent left out: the session stays spent; the week and the governor ignore it. */
export function recordNotShown(o: PendingOffer, repoKey: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): void {
  append(line(o, repoKey, 'not-shown', now), env);
}

/**
 * Records the answer and refreshes settings.lastNine. The 2nd 'no' in a row in this repo pauses it 14 days.
 * Phase 2 (2.4): `op` says which change a yes chose (a fold op, drift's 'replace', or 'retire'); `answer` stays 1a's.
 */
export function recordAnswer(o: PendingOffer, repoKey: string, a: Answer, env?: NodeJS.ProcessEnv, now: Date = new Date(),
  op?: OfferLine['op']): { paused: boolean; firstNo: boolean } {
  const before = a === 'no' ? foldOffers(readOffers(env)) : [];
  append(line(o, repoKey, 'answer', now, a, op), env);
  refreshGovernor(env, now);
  if (a !== 'no') return { paused: false, firstNo: false };
  const firstNo = !before.some((r) => r.answer === 'no' && r.event !== 'closed' && r.id !== o.offerId);
  const here = foldOffers(readOffers(env)).filter((r) => r.repo === repoKey).sort(byTime).filter((r) => settled(r, now) !== null);
  const lastTwo = here.slice(-2);
  if (lastTwo.length < 2 || !lastTwo.every((r) => settled(r, now) === 'no')) return { paused: false, firstNo };
  try {
    pauseRepo(repoKey, new Date(now.getTime() + PAUSE_DAYS * DAY_MS), env);
  } catch {
    return { paused: false, firstNo }; // not written: not said
  }
  return { paused: true, firstNo };
}

/**
 * For `trail skills` (2.10): the governor line the first time it is printed while the governor is on (records
 * governorSaidAt through noteGovernor); null otherwise. noteGovernor clears governorSaidAt when the governor turns
 * off, so it is said again next time.
 */
export function governorLine(env?: NodeJS.ProcessEnv, now: Date = new Date()): string | null {
  const nine = lastNine(foldOffers(readOffers(env)), now);
  const s = readSettings(env);
  if (!governorOn(nine)) {
    if (s.governorSaidAt !== null || JSON.stringify(s.lastNine) !== JSON.stringify(nine)) refreshGovernor(env, now, null);
    return null;
  }
  if (s.governorSaidAt !== null) return null;
  try {
    noteGovernor(nine, now.toISOString(), env);
  } catch {
    return null; // not recorded: say it next time instead of twice
  }
  return GOVERNOR_LINE;
}

/**
 * Init's `closed` line (2.4, 4.20, R53): an item the person was shown at `trail init` and didn't keep. It counts as
 * "said no" for `key` forever, and for nothing else: not the session, the week, the first week, the pause or the
 * governor (P10). Its only writer; b6 calls it for each skill key init closes.
 */
export function recordInitClosed(repoKey: string, key: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): void {
  append({
    id: `o-init-${randomBytes(2).toString('hex')}`, at: now.toISOString(), event: 'closed', repo: repoKey, key, moment: 'init', runId: '', name: '',
    channel: 'stop', answer: 'no',
  }, env);
}

/* Keys (2.4, 4.10, P8, P13). Moments 5 and 6 are keyed per version, so a no is never asked again for that version and
 * a new version (only after a yes, an adopted hand edit or a restore) may be offered again; the retire proposal is
 * once per skill, ever. A key names a skill, never a repo: the offer's `repo` (1b) says where it was made. */

const KEY_PART = /^[^|\s]{1,200}$/;
function keyPart(skillId: string): string {
  if (!KEY_PART.test(String(skillId))) throw new Error('trail: not a skill id for an offer key');
  return skillId;
}
function keyVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('trail: not a skill version for an offer key');
  return version;
}

/** Moment 5's key: `<skillId>|update|v<n>`. */
export const updateOfferKey = (skillId: string, version: number): string => `${keyPart(skillId)}|update|v${keyVersion(version)}`;
/** Moment 6's key: `<skillId>|drift|v<n>`. */
export const driftOfferKey = (skillId: string, version: number): string => `${keyPart(skillId)}|drift|v${keyVersion(version)}`;
/** The retire proposal's key: `<skillId>|retire`. */
export const retireOfferKey = (skillId: string): string => `${keyPart(skillId)}|retire`;

const SKILL_KEY = /^([^|\s]{1,200})\|(?:correction|update\|v[1-9]\d*|drift\|v[1-9]\d*|retire)$/;
/** The skill a skill-keyed offer names (moments 4, 5, 6 and the retire proposal); null for a repo-keyed one (2, 3). */
export function skillOfOfferKey(key: string): string | null {
  return SKILL_KEY.exec(String(key))?.[1] ?? null;
}

/** 'o-' + 6 hex */
export function newOfferId(): string {
  return `o-${randomBytes(3).toString('hex')}`;
}
