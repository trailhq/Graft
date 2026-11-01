/**
 * Phase 1b's `trail skills` lines (design 2.12), beside `cli-skills-report.ts`:
 * per skill its lesson count, "may be out of date" for a skill that applies
 * in the repo the command runs in, and "unused since" after 60 days; then the
 * guardrails kept, the errors Trail knows in this repo over 30 days, and the
 * lesson count. Reading only: file reads and stats, no process, no network.
 * The guardrail line has no counts (R62): those are telemetry only.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { flatLine } from '../notes/flatten.js';
import { repoPlace, type RepoPlace } from '../notes/home.js';
import { everyRepoLearnings } from '../notes/every-repo.js';
import { repoNotesDir } from '../notes/repo-notes-dir.js';
import { parseNote, type Note } from '../notes/notes.js';
import { readWalls } from '../trace/wall-state.js';
import { WALLS } from '../trace/walls.js';
import type { WallClass } from '../trace/types.js';
import { goneAnchors, goneWords } from './anchors.js';
import { readLedger } from './ledger.js';
import { readLessons, wallLessons } from './lessons.js';
import { unusedSince } from './staleness.js';
import { valueLine, valueWeek } from './value-line.js';
import type { LedgerUse, ParsedSkill, SkillRef, SkillState } from './types.js';

const DAY_MS = 86_400_000;
const ERROR_DAYS = 30;
const one = (t: string, max = 60) => flatLine(t, max);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface SkillExtras { lessons: number; outOfDate: string | null; unusedSince: string | null }
export interface GuardrailRow { name: string; applies: string; enforced: boolean }
export interface ErrorRow { class: WallClass; times: number; fixed: number }

/** The repo the command runs in, or null outside one. */
export function placeOf(cwd: string | undefined, env: NodeJS.ProcessEnv): RepoPlace | null {
  if (!cwd) return null;
  try {
    const p = repoPlace(cwd, env);
    return p.git && p.key ? p : null;
  } catch {
    return null;
  }
}

const appliesHere = (applies: string | null, place: RepoPlace | null) => !!place
  && (!applies || applies.toLowerCase() === 'every repo' || applies.toLowerCase() === place.key.toLowerCase());

/** One skill's 1b facts: lesson files, gone anchors (only where it applies here), unused for 60 days. */
export function skillExtras(ref: SkillRef, parsed: ParsedSkill | null, st: SkillState | undefined, place: RepoPlace | null,
  env: NodeJS.ProcessEnv, now: Date): SkillExtras {
  let gone = '';
  if (parsed && appliesHere(ref.applies, place)) {
    // Phase 2 (4.13): `trail skills` may scan the repo's CLI for its subcommands (and caches what it found).
    try { gone = goneWords(goneAnchors(parsed, place!.checkout, env, { scan: true, deadline: Date.now() + 1000 })); } catch { /* a check that throws says nothing */ }
  }
  return { lessons: readLessons(ref.dir).length, outOfDate: gone || null, unusedSince: st ? unusedSince(st, now) : null };
}

/** The part a skill's line gains (2.12). */
export function extrasWords(x: SkillExtras): string {
  const parts: string[] = [];
  if (x.lessons) parts.push(plural(x.lessons, 'learning'));
  if (x.outOfDate) parts.push(`may be out of date: ${one(x.outOfDate, 160)}`);
  if (x.unusedSince) parts.push(`unused since ${dayOfLocal(x.unusedSince)} (not in the list agents see; asking for it still brings it)`);
  return parts.map((p) => ` · ${p}`).join('');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayOfLocal(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? 'Jan'} ${Number(m[3])}` : 'an earlier day';
}

/** Active guardrails in this repo's personal folder (plain files only). */
function repoGuardrails(place: RepoPlace | null, env: NodeJS.ProcessEnv): Note[] {
  if (!place) return [];
  let dir: string;
  let files: string[];
  try {
    dir = repoNotesDir(place.key, env);
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      const path = join(dir, f);
      const st = lstatSync(path);
      if (!st.isFile() || st.size > 64 * 1024) return [];
      const n = parseNote(readFileSync(path, 'utf8'), path);
      return n ? [n] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The guardrails kept: every repo, then this repo's. `enforced` only where the fast path denies (b7 review): skills on
 * (0 rule 1) and the file still says check no-timeout and enforce sure-fail (guard-fast.ts reads both).
 */
export function guardrailRows(place: RepoPlace | null, env: NodeJS.ProcessEnv, skillsOn = true): GuardrailRow[] {
  const live = (n: Note) => n.kind === 'guardrail' && (n.status ?? 'active') === 'active';
  const stops = (n: Note) => skillsOn && n.check === 'no-timeout' && n.enforce === 'sure-fail';
  const every = everyRepoLearnings(env).filter(live).map((n) => ({ name: basename(n.path, '.md'), applies: 'every repo', enforced: stops(n) }));
  const here = repoGuardrails(place, env).filter(live).map((n) => ({ name: basename(n.path, '.md'), applies: 'this repo', enforced: stops(n) }));
  return [...every, ...here];
}

/** What a guardrail does, in words. */
function guardrailDoes(g: GuardrailRow): string {
  return g.enforced ? 'stops `timeout N` while this Mac has no timeout' : 'agents read it at session start';
}

export function guardrailLines(rows: GuardrailRow[]): string[] {
  if (!rows.length) return [];
  const width = Math.max(...rows.map((g) => one(g.name).length)) + 3;
  return ['always follow:', ...rows.map((g) => `  ${one(g.name).padEnd(width)}${g.applies} · ${guardrailDoes(g)}`)];
}

/** The errors in the catalog Trail saw in this repo over 30 days, and how often a repair followed. */
export function errorRows(place: RepoPlace | null, env: NodeJS.ProcessEnv, now: Date): ErrorRow[] {
  if (!place) return [];
  const w = readWalls(env);
  const since = now.getTime() - ERROR_DAYS * DAY_MS;
  const recent = (x: { d: string; repo: string }) => x.repo.toLowerCase() === place.key.toLowerCase() && Date.parse(`${x.d}T12:00:00`) >= since;
  const out: ErrorRow[] = [];
  for (const wall of WALLS) {
    const c = w.classes[wall.cls];
    if (!c) continue;
    const times = c.seen.filter(recent).length;
    if (times) out.push({ class: wall.cls, times, fixed: c.fixed.filter(recent).length });
  }
  return out.sort((a, b) => b.times - a.times);
}

export function errorLine(rows: ErrorRow[]): string | null {
  if (!rows.length) return null;
  const words = (r: ErrorRow) => `${WALLS.find((x) => x.cls === r.class)!.words} ${plural(r.times, 'time')}${r.fixed ? `, fixed ${plural(r.fixed, 'time')}` : ''}`;
  return `errors Trail knows here (${ERROR_DAYS} days): ${rows.map(words).join(' · ')}`;
}

/** Skill lesson files plus the live wall lessons that hold here (or in every repo). */
export function lessonTotal(skillLessons: number, place: RepoPlace | null, env: NodeJS.ProcessEnv): number {
  const ids = new Set<string>();
  for (const w of WALLS) for (const l of wallLessons(w.cls, place?.key ?? '', env)) ids.add(l.id);
  return skillLessons + ids.size;
}

export const lessonsLine = (n: number) => (n ? `new learnings: ${n} (trail skills show <name> lists them)` : null);

/**
 * Phase 2 (3.6, 4.14): the weekly value line for the repo `trail skills` runs in, on top of the list, any day once
 * skills have been on for a week (P21). Null outside a repo, in the first week, with skills off, with nothing to say,
 * or on a throw (a count that can't be read says nothing).
 */
export function valueHere(place: RepoPlace | null, env: NodeJS.ProcessEnv, now: Date): string | null {
  if (!place) return null;
  try {
    return valueWeek(env, now) ? valueLine([place.key], env, now) : null;
  } catch {
    return null;
  }
}

const FIDELITY_USES = 10;

/**
 * Phase 2 (3.6, P2, P3): how the skill's last uses followed it, for `trail skills show`, from the fidelity counts on
 * its ledger's use lines (the last 10 that carry them). Counts of uses only; a use line without counts (1b's, or one
 * whose flush threw) is not counted. Null until there is one. Fidelity never changes a status (P3).
 */
export function fidelityLine(skillId: string, env: NodeJS.ProcessEnv): string | null {
  let uses: LedgerUse[];
  try {
    uses = readLedger(skillId, env).filter((l): l is LedgerUse => l.event === 'use' && !!l.fid && typeof l.fid === 'object').slice(-FIDELITY_USES);
  } catch {
    return null;
  }
  if (!uses.length) return null;
  const n = (f: (u: LedgerUse) => boolean) => uses.filter(f).length;
  const parts: Array<[string, number]> = [
    ['every step ran as kept', n((u) => u.fid!.missing === 0 && u.fid!.changed === 0)],
    ['a step was left out', n((u) => u.fid!.missing > 0)],
    ['a step ran another way', n((u) => u.fid!.changed > 0)],
    ['an extra command ran', n((u) => u.fid!.extra > 0)],
  ];
  const said = parts.filter(([, k]) => k > 0).map(([w, k]) => `${w} in ${k}`);
  return `how its last ${plural(uses.length, 'use')} with counts on this machine went: ${said.join(' · ')}`;
}
