/**
 * Cue misses and 60 days unused (design 1.3, 4.19, spec 13, P26, P27).
 *
 * A cue miss is a block a `job` cue brought in whose steps the agent never
 * ran. Two in a row for one asks phrase drop that phrase from
 * `metadata.asks`, only when Trail wrote the file last (its hash is the one
 * in state) and never the last phrase; a hand-edited skill is never edited,
 * the count just stays. Phrases are never added. A phrase can be the
 * person's own words (D71 b), so outside SKILL.md it is only ever its
 * `phraseSha`: 8 hex of sha256 (R30).
 *
 * A skill unused for 60 days leaves the index line; its cues still fire on a
 * typed ask, and its folder stays.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { SkillRef, SkillState } from './types.js';
import { appendLedger } from './ledger.js';
import { getSkillState, updateSkillState } from './state.js';
import { listAllPersonal } from './store.js';
import { parseSkillMd, skillHash } from './skillmd.js';
import { localDate } from './settings.js';
import { flatLine } from '../notes/flatten.js';
import { writePrivate } from '../util/private-fs.js';
import { tryStoreLock, MAX_SKILL_BYTES } from './store-fs.js';

export const UNUSED_DAYS = 60;
const DROP_AT = 2;
const MAX_KEYS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 8 hex of sha256 of the phrase, its spaces collapsed and lower-cased (R30). */
export function phraseSha(phrase: string): string {
  const t = String(phrase ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(t).digest('hex').slice(0, 8);
}

const counts = (st: SkillState): Record<string, number> => {
  const c = st.cueMisses;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
  return Object.fromEntries(Object.entries(c).filter(([k, v]) => /^[0-9a-f]{8}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0));
};

/** At credit flush (4.19). Returns whether the phrase should be dropped now. Changes st.cueMisses only. */
export function noteCueResult(st: SkillState, phraseSha: string | null, followed: boolean): { drop: boolean } {
  if (!phraseSha || !/^[0-9a-f]{8}$/.test(phraseSha)) return { drop: false };
  const c = counts(st);
  if (followed) delete c[phraseSha];
  else c[phraseSha] = (c[phraseSha] ?? 0) + 1;
  const keys = Object.keys(c);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_KEYS))) if (k !== phraseSha) delete c[k];
  st.cueMisses = c;
  return { drop: !followed && (c[phraseSha] ?? 0) >= DROP_AT };
}

const ASKS_LINE = /^ {2}asks: .*$/m;

/**
 * Removes the asks phrase whose phraseSha matches when the file's hash equals st.hash; never the last phrase.
 * Updates st.hash. Never writes through a link (the skill's folder or its SKILL.md). The caller holds the locks.
 */
export function dropPhrase(ref: SkillRef, st: SkillState, sha: string): boolean {
  try {
    if (lstatSync(ref.dir).isSymbolicLink()) return false;
    const f = lstatSync(ref.file);
    if (!f.isFile() || f.size > MAX_SKILL_BYTES) return false;
    const text = readFileSync(ref.file, 'utf8');
    if (!st.hash || skillHash(text) !== st.hash) return false;
    const parsed = parseSkillMd(text, ref.name);
    if (!parsed || parsed.meta.trail !== ref.id) return false;
    const phrases = String(parsed.meta.asks ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    const keep = phrases.filter((p) => phraseSha(p) !== sha);
    if (keep.length === phrases.length || keep.length === 0) return false;
    const front = text.slice(0, text.indexOf('\n---', 3) + 1);
    if (!front || (front.match(new RegExp(ASKS_LINE.source, 'gm')) ?? []).length !== 1) return false;
    const asks = keep.join(', ');
    const next = text.slice(0, front.length).replace(ASKS_LINE, `  asks: ${JSON.stringify(flatLine(asks, 1024))}`) + text.slice(front.length);
    const back = parseSkillMd(next, ref.name);
    if (!back || back.meta.asks !== asks || back.meta.trail !== ref.id || back.steps.length !== parsed.steps.length) return false;
    writePrivate(ref.file, next);
    st.hash = skillHash(next);
    return true;
  } catch {
    return false;
  }
}

/**
 * 4.19 at a credit flush, with the locks: the count in state, and at 2 misses in a row the drop (store lock, then
 * the state lock, as a save takes them), its ledger `cue` line. Fails closed: nothing dropped.
 */
export function cueFlush(skillId: string, sha: string | null, followed: boolean, env?: NodeJS.ProcessEnv, now: Date = new Date()): { dropped: boolean } {
  if (!sha || !/^[0-9a-f]{8}$/.test(sha)) return { dropped: false };
  const had = getSkillState(skillId, env);
  if (!had || (followed && !counts(had)[sha])) return { dropped: false };
  let drop = false;
  updateSkillState(skillId, (s) => {
    if (!s) return s;
    drop = noteCueResult(s, sha, followed).drop;
    return s;
  }, env);
  if (!drop) return { dropped: false };
  const ref = listAllPersonal(env).find((r) => r.id === skillId);
  if (!ref) return { dropped: false };
  let dropped = false;
  try {
    tryStoreLock(env, () => updateSkillState(skillId, (s) => {
      if (s && dropPhrase(ref, s, sha)) {
        dropped = true;
        const c = counts(s);
        delete c[sha];
        s.cueMisses = c;
      }
      return s;
    }, env));
  } catch {
    return { dropped: false };
  }
  if (dropped) {
    try { appendLedger(skillId, { at: now.toISOString(), event: 'cue', skill: skillId, phraseSha: sha, change: 'dropped' }, env); } catch { /* state is the truth */ }
  }
  return { dropped };
}

/** The date it was last used or saved when that is 60+ days ago, else null. */
export function unusedSince(st: SkillState, now: Date = new Date()): string | null {
  // A date that can't be read, or one after now (a clock that moved back, a hand edit), says nothing: the next one does.
  const ok = (d: unknown): d is string => typeof d === 'string' && !Number.isNaN(Date.parse(d)) && Date.parse(d) <= now.getTime() + DAY_MS;
  const base = [st.lastUsedAt, st.addedAt].find(ok);
  if (!base || now.getTime() - Date.parse(base) < UNUSED_DAYS * DAY_MS) return null;
  return localDate(base);
}

/** skill_stale{unused} is due: once per unused stretch (a use after it was said starts a new one). Sets unusedSaidAt. */
export function markUnusedSaid(skillId: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): boolean {
  let due = false;
  updateSkillState(skillId, (s) => {
    if (!s || !unusedSince(s, now)) return s;
    const said = s.unusedSaidAt ? Date.parse(s.unusedSaidAt) : NaN;
    const used = Date.parse(s.lastUsedAt || s.addedAt);
    if (!Number.isNaN(said) && !(used > said)) return s;
    s.unusedSaidAt = now.toISOString();
    due = true;
    return s;
  }, env);
  return due;
}

/** skill_stale{missing} is due: once per skill per local day (4.18). Sets missingSaidAt. */
export function markMissingSaid(skillId: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): boolean {
  let due = false;
  updateSkillState(skillId, (s) => {
    if (!s) return s;
    if (s.missingSaidAt && localDate(s.missingSaidAt) === localDate(now)) return s;
    s.missingSaidAt = now.toISOString();
    due = true;
    return s;
  }, env);
  return due;
}
