/**
 * What `trail skills` prints (design 2.10): each skill with its scope in
 * words, status, uses and last good use; held items with how to keep them;
 * the jobs Trail is counting; the offers line (and the governor line, once);
 * the skills line. `--json` is the same facts as one object. Every line names
 * the command that changes it. Reading only, except the governor line, which
 * records that it was said (offers.ts).
 */
import type { JobClass } from '../trace/types.js';
import type { SkillState, SkillStatus } from './types.js';
import { OFFER_FAMILIES } from '../trace/jobs.js';
import { watching } from '../trace/pool.js';
import { flatLine } from '../notes/flatten.js';
import { monthDay, repoName } from './compile-words.js';
import { foldOffers, governorLine, readOffers } from './offers.js';
import { readSettings } from './settings.js';
import { readSkillsState } from './state.js';
import { jobCovered, listAllPersonal, listHeld, readSkill, type HeldItem } from './store.js';
import { refusedAtRecall } from './recall.js';
import {
  errorLine, errorRows, extrasWords, guardrailLines, guardrailRows, lessonsLine, lessonTotal, placeOf, skillExtras, valueHere,
  type ErrorRow, type GuardrailRow, type SkillExtras,
} from './cli-skills-report-1b.js';

const WEEK_MS = 7 * 86_400_000;
const WATCH_MAX = 5;
const HOSTS: Record<string, string> = { claude: 'Claude Code', cursor: 'Cursor', copilot: 'GitHub Copilot', codex: 'Codex', gemini: 'Gemini CLI' };

export interface SkillRow {
  name: string; id: string; scope: 'personal'; applies: string | null; status: SkillStatus; version: string | null;
  uses: number; checkedUses: number; lastWorked: string | null; addedAt: string | null;
  source: { commands: number; failed: number } | null; statusWhy: string | null; off: boolean;
  /** Refused at recall now (a step edited by hand that the risk rules refuse): why, in words. Not used while set. */
  refused: string | null;
}
/** A skill's row with 1b's facts (2.12). */
export type SkillRow1b = SkillRow & SkillExtras;
export interface HeldRow { name: string; why: HeldItem['why']; host: string; repo: string; at: string; shownAt: string | null }
export interface WatchRow { job: JobClass; repo: string; sessionDays: number; need: number }
export interface SkillsReport {
  skills: SkillRow1b[];
  held: HeldRow[];
  watching: WatchRow[];
  offers: { on: boolean; offSince: string | null; offIn: string[]; perSession: 1; perWeek: 3; thisWeek: number; kept: number };
  governor: string | null;
  settings: { skills: 'on' | 'off'; onSince: string | null };
  /** 1b (2.12): the guardrails kept, the catalog errors in this repo over 30 days, every lesson that holds here. */
  guardrails: GuardrailRow[];
  errorsHere: ErrorRow[];
  lessons: number;
  /** Phase 2 (4.14): the weekly value line for this repo, on top; null when there is none. */
  value?: string | null;
}

/** `Oct 29` for an ISO time or a local `YYYY-MM-DD` day (read as that local day, not UTC midnight). */
export function dayWords(d: string): string {
  return monthDay(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const one = (t: string, max = 60) => flatLine(t, max);

/** Where a skill applies, in words: `yours, in webshop` or `yours, in every repo`. */
export function whereWords(applies: string | null): string {
  return !applies || applies.toLowerCase() === 'every repo' ? 'yours, in every repo' : `yours, in ${one(repoName(applies))}`;
}

/** The status part of a skill's line (2.10). */
export function statusWords(r: SkillRow): string {
  const v = r.version ? ` v${one(r.version, 8)}` : '';
  let s: string;
  if (r.refused) s = `needs a fix: ${one(r.refused, 120)} · not used until fixed`;
  else if (r.status === 'needs-fix') s = `needs a fix: ${one(r.statusWhy ?? 'its steps failed twice', 120)} · not used until fixed`;
  else if (r.status === 'active') s = `active${v} · used ${r.uses}, checked ${r.checkedUses}${r.lastWorked ? ` · last worked ${dayWords(r.lastWorked)}` : ''}`;
  else {
    const from = r.source ? ` from a run of ${plural(r.source.commands, 'command')}, ${r.source.failed ? `${r.source.failed} failed` : 'none failed'}` : '';
    s = `candidate${v}${r.addedAt ? ` · saved ${dayWords(r.addedAt)}${from}` : ''}`;
  }
  return r.off ? `${s} · off: turn it on with trail skills on ${one(r.name)}` : s;
}

/** One held item's line. */
export function heldWords(h: Pick<HeldRow, 'name' | 'why' | 'host'>): string {
  const why = h.why === 'host' ? `came from ${HOSTS[h.host] ?? 'another tool'}` : 'started without your yes';
  return `held, not kept: ${one(h.name)} (${why}) · keep it: trail skills keep ${one(h.name)}`;
}

function rows(env: NodeJS.ProcessEnv, now: Date, cwd?: string): SkillRow1b[] {
  // Each file first: reading a needs-fix skill edited by hand puts its state back (4.8), so the state is read after.
  const read = listAllPersonal(env).map((ref) => ({ ref, parsed: readSkill(ref) }));
  const state: Record<string, SkillState> = readSkillsState(env).skills;
  const off = new Set(readSettings(env).skillsOff);
  const place = placeOf(cwd, env);
  return read.map(({ ref, parsed }): SkillRow1b => {
    const st = state[ref.id];
    return {
      name: ref.name, id: ref.id, scope: 'personal' as const, applies: ref.applies, status: (st?.status ?? 'candidate') as SkillStatus,
      version: parsed?.meta.version ?? null, uses: st?.uses ?? 0, checkedUses: st?.checkedUses ?? 0, lastWorked: st?.lastWorked ?? null,
      addedAt: st?.addedAt ?? null, source: st?.source ? { commands: st.source.commands, failed: st.source.failed } : null,
      statusWhy: st?.statusWhy ?? null, off: off.has(ref.name), refused: parsed ? refusedAtRecall(parsed) : null,
      ...skillExtras(ref, parsed, st, place, env, now),
    };
  }).filter((r) => r.status !== 'retired');
}

/** The facts `trail skills` prints, `cwd` the folder it runs in. Says the governor line at most once per time it turns on (records it). */
export function skillsReport(env: NodeJS.ProcessEnv, now: Date, cwd?: string): SkillsReport {
  const s = readSettings(env);
  const records = foldOffers(readOffers(env)).filter((r) => r.event === 'shown' && now.getTime() - Date.parse(r.at) < WEEK_MS && Date.parse(r.at) <= now.getTime());
  const watch = watching(env, now)
    .filter((w) => OFFER_FAMILIES[w.job] && !jobCovered(w.job, { repoKeys: [w.repoKey], checkout: '', env }))
    .sort((a, b) => b.sessionDays - a.sessionDays || a.repoKey.localeCompare(b.repoKey) || a.job.localeCompare(b.job))
    .slice(0, WATCH_MAX)
    .map((w) => ({ job: w.job, repo: w.repoKey, sessionDays: w.sessionDays, need: w.need }));
  const skills = rows(env, now, cwd);
  const place = placeOf(cwd, env);
  return {
    skills,
    held: listHeld(env, now).map((h) => ({ name: h.name, why: h.why, host: h.host, repo: h.repoKey, at: h.at, shownAt: h.shownAt })),
    watching: watch,
    offers: {
      on: s.offers === 'on', offSince: s.offers === 'off' ? s.offersOffAt : null, offIn: s.offRepos.slice(), perSession: 1, perWeek: 3,
      thisWeek: records.length, kept: records.filter((r) => r.answer === 'yes').length,
    },
    governor: s.offers === 'on' ? governorLine(env, now) : null,
    settings: { skills: s.skills, onSince: s.onSince },
    guardrails: guardrailRows(place, env, s.skills === 'on'),
    errorsHere: errorRows(place, env, now),
    lessons: lessonTotal(skills.reduce((n, k) => n + k.lessons, 0), place, env),
    value: valueHere(place, env, now),
  };
}

/** The report as the lines 2.10 shows. */
export function reportLines(r: SkillsReport): string[] {
  const out: string[] = [];
  if (r.value) out.push(r.value);
  if (!r.skills.length) out.push('no skills yet');
  const width = Math.max(0, ...r.skills.map((s) => one(s.name).length)) + 3;
  for (const s of r.skills) out.push(`${one(s.name).padEnd(width)}${whereWords(s.applies)} · ${statusWords(s)}${extrasWords(s)}`);
  for (const h of r.held) out.push(heldWords(h));
  out.push(...guardrailLines(r.guardrails ?? []));
  for (const l of [errorLine(r.errorsHere ?? []), lessonsLine(r.lessons ?? 0)]) if (l) out.push(l);
  if (r.watching.length) out.push(`watching: ${r.watching.map((w) => `${w.job} in ${one(repoName(w.repo))}, ${w.sessionDays} of ${w.need} days`).join(' · ')}`);
  const o = r.offers;
  if (!o.on) out.push(`offers: off${o.offSince ? ` since ${dayWords(o.offSince)}` : ''} · turn back on: trail skills offers on`);
  else {
    const head = o.offIn.length ? `offers: on, off in ${o.offIn.map((k) => one(repoName(k))).join(', ')}` : 'offers: on';
    const week = o.thisWeek ? `${o.thisWeek} this week, ${o.kept} kept` : 'none this week';
    out.push(`${head} · at most ${o.perSession} per session, ${o.perWeek} a week · ${week} · stop them: trail skills offers off`);
    if (r.governor) out.push(r.governor);
  }
  const st = r.settings;
  out.push(st.skills === 'on' ? `skills: on${st.onSince ? ` since ${dayWords(st.onSince)}` : ''} · turn off: trail skills off` : 'skills: off · turn on: trail skills on');
  return out;
}
