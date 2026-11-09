/**
 * Moment 3 (design 4.13, J06): a job that checked out after getting past a
 * known wall the same way it did before. When (wall, program) was hit and
 * fixed in an earlier epoch in this repo within 45 days, Trail offers to
 * keep the run as a skill, compiled exactly as moment 2 compiles it (R58),
 * or, when compile refuses or gives one step (D70), what fixed it as a
 * lesson whose exact text line 2 shows (R26).
 *
 * The delta texts are the repair detector's, already secret-checked,
 * relativized and held to the never-save, gated and bypass lists (4.12,
 * D104). Nothing typed is in them.
 */
import { homedir } from 'node:os';
import type { FixDelta, PendingOffer, WallClass } from '../trace/types.js';
import { WALL_CLASSES } from '../notes/learning-fields.js';
import { flatLine } from '../notes/flatten.js';
import { leadingCds, splitTop } from '../trace/shell.js';
import { programWords } from '../trace/shell-words.js';
import { unquote } from '../trace/shell-scan.js';
import { detectRepairs } from '../trace/repairs.js';
import { programKey, readWalls, repairsSeen } from '../trace/wall-state.js';
import { WALLS } from '../trace/walls.js';
import { stableBranches } from './compile-words.js';
import { joinCarriedSheet, readRunSheet } from '../trace/runs.js';
import { jobCovered } from './store.js';
import { stepsTotal } from './store-fs.js';
import { lessonRefused, lessonSha, LESSON_MAX, wallLessons } from './lessons.js';
import { checkLine, ordinalWord } from './offer-words.js';
import { newOfferId, offerBudget } from './offers.js';
import { compileOffered, skillSha, type OfferDue, type OfferInput } from './offer-moment.js';
import { withFollowLine } from './follow-learnings.js';

/** The words of a moment-3 offer (4.13, J06) and of its saved wall lesson (4.15). Said as they are. */
export const REPAIR_COPY: Record<string, string> = {
  line1: '{check} This is the {nth} time {span} that {program} failed on {fixed} and needed {delta}.',
  skill: 'Keep the {k} working steps as a skill, just for you in this repo? (yes / show me / no)',
  lesson: 'Keep what fixed it as a learning, just for you {where}: "{lesson}"? (yes / no)',
  savedWall: '✓ learning kept, just for you {where} · Trail shows it when {fixed} comes back · undo: trail forget {id}',
};

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
const LINE_MAX = 400;
const DAY_MS = 86_400_000;
/** A wall about one repo's remote, not the machine (spec 2, R49): its lesson holds in this repo only. */
const REPO_WALLS = new Set<WallClass>(['git-https-auth']);

/** `in every repo` for a machine wall, `in this repo` for git-https-auth (R49). */
export function lessonWhere(cls: WallClass): 'this repo' | 'every repo' {
  return REPO_WALLS.has(cls) ? 'this repo' : 'every repo';
}

/** The wall's fixed words: `"rootless Docker not found"`, `zsh "no matches found"`. */
export function fixedWords(cls: WallClass): string {
  return WALLS.find((w) => w.cls === cls)?.words ?? cls;
}

/** One delta in words (4.13): `Colima's socket`, `DOCKER_HOST set`, `the --no-glob flag`, `noglob in front`, `colima start first`. */
function deltaWord(d: FixDelta): string {
  switch (d.kind) {
    case 'env':
      return d.name === 'DOCKER_HOST' && /\.colima\b/.test(d.text) ? "Colima's socket" : `${flatLine(d.name, 40)} set`;
    case 'flag':
      return `the ${flatLine(d.name, 40)} flag`;
    case 'wrapper':
      return `${flatLine(d.name, 40)} in front`;
    default:
      return `${stepJob(d.text)} first`;
  }
}

/**
 * fix-lab5: what an enabling step does, for line 1: its program and up to two subcommand words (`colima start`,
 * `git remote set-url`), never its raw text. Of `a || b` (a status check with its fallback), the fallback does the
 * work; a leading cd, a wrapper, flags, values and redirections are left out. Line 2's lesson keeps the text.
 */
function stepJob(text: string): string {
  const s = leadingCds(String(text ?? '')).rest || String(text ?? '');
  const segs = splitTop(s);
  let pick = segs[0];
  for (let k = 0; k + 1 < segs.length && segs[k]!.sep === '||'; k++) pick = segs[k + 1];
  const w = programWords(pick?.text ?? s).map(unquote);
  const words = w[0] ? [w[0]] : [];
  for (const a of w.slice(1)) {
    if (a.startsWith('-')) continue;
    if (!/^[a-z][a-z-]{0,30}$/.test(a) || words.length > 2) break;
    words.push(a);
  }
  return flatLine(words.join(' '), 60) || flatLine(text, 60);
}

/** `a`, `a and b`, `a, b and c`, each named once. */
export function deltaWords(delta: FixDelta[]): string {
  const w = [...new Set(delta.map(deltaWord))];
  if (w.length < 2) return w.join('');
  return `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
}

/** The lesson a moment-3 offer keeps: `{fixed words}: {delta texts joined by ", then "}`; null past 200 characters (never cut). */
export function repairLessonText(cls: WallClass, delta: FixDelta[]): string | null {
  if (!delta.length) return null;
  const text = flatLine(`${fixedWords(cls)}: ${delta.map((d) => d.text).join(', then ')}`, 4000);
  return text && text.length <= LESSON_MAX && !lessonRefused(text) ? text : null;
}

/** `this week` when the first time was within 7 days, else `in {days} days` (the days from the first time to today). */
function spanWords(days: number): string {
  return days <= 7 ? 'this week' : `in ${Math.floor(days)} days`;
}

/**
 * 4.13's 2 lines. `days`: from the first time to today, counting both. b4: `program` is named in line 1 (the design's
 * signature left it out).
 */
export function repairLines(o: { checkLine: string; nth: number; days: number; cls: WallClass; delta: FixDelta[]; program: string;
  as: 'skill' | 'lesson'; steps: number; lessonText: string | null; where: 'this repo' | 'every repo' }): [string, string] {
  const check = flatLine(o.checkLine, 200).replace(/([^.!?])$/, '$1.');
  const line1 = fill(REPAIR_COPY.line1!, {
    check, nth: ordinalWord(o.nth), span: spanWords(o.days), program: flatLine(o.program, 40) || 'it', fixed: fixedWords(o.cls), delta: deltaWords(o.delta),
  });
  const line2 = o.as === 'skill'
    ? fill(REPAIR_COPY.skill!, { k: String(Math.max(2, Math.floor(o.steps))) })
    // D114 (3): line 2 quotes the lesson, so the quotes inside it become single ones (never ""…"").
    : fill(REPAIR_COPY.lesson!, { where: `in ${o.where}`, lesson: flatLine(o.lessonText ?? '', LESSON_MAX).replace(/["\u201c\u201d]/g, "'") });
  return [flatLine(line1, LINE_MAX), flatLine(line2, LINE_MAX)];
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Days from `first` (local date) to `now`, counting both. */
function daysSince(first: string | null, now: Date): number {
  if (!first) return 1;
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${localDay(now)}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? 1 : Math.max(1, Math.round((b - a) / DAY_MS) + 1);
}

/** Budget answers about one key, not the session, week or repo (4.20). */
const KEY_ONLY = new Set(['said-no', 'no-answer-twice', 'too-soon']);

type Why = 'learn' | 'pending' | 'not-checked' | 'no-sheet' | 'no-repair' | 'skill' | 'covered' | 'not-repeated' | 'known' | 'too-long'
  | `budget:${string}`;

/** Moment 3 (4.13). Called by offerDue at Stop after the fold, inside the session lock; same input as 1a's offerDue (R9). */
export function repairOfferDue(i: OfferInput): OfferDue | { due: false; why: Why } {
  const { run, verdict, st, ctx, channel } = i;
  const env = ctx.env;
  const now = ctx.now;
  if (!ctx.learn) return { due: false, why: 'learn' };
  if (st.pendingOffer) return { due: false, why: 'pending' };
  // Spec 9: moments 2 and 3 wait for a checked success; the turn ended done (no failure, no question).
  if (!verdict.checked || verdict.checkIndex === null || verdict.end !== 'done') return { due: false, why: 'not-checked' };
  const sheet = i.sheet;
  if (!sheet || sheet.id !== run.id || !run.repoKey) return { due: false, why: 'no-sheet' };
  // The run is still open at Stop, so its repairs are read from its calls now (run close fills run.repairs).
  const repairs = (run.repairs ?? detectRepairs(run, { home: env.HOME || homedir(), root: ctx.checkout }))
    .filter((r) => (WALL_CLASSES as readonly string[]).includes(r.cls) && programKey(r.program));
  if (!repairs.length) return { due: false, why: 'no-repair' };
  if (run.skillId) return { due: false, why: 'skill' };
  const scope = { repoKeys: [...new Set([...st.scopeKeys, run.repoKey])], checkout: ctx.checkout, env };
  if (run.job && jobCovered(run.job, scope)) return { due: false, why: 'covered' };

  const walls = readWalls(env);
  let why: Why = 'not-repeated';
  for (const r of [...repairs].reverse()) {
    const program = programKey(r.program);
    const key = `${run.repoKey}|wall:${r.cls}|${program}`;
    const seen = repairsSeen(walls, run.repoKey, r.cls, r.program, st.sessionHash, run.epoch, now);
    if (seen.epochs < 1) { why = 'not-repeated'; continue; }
    // Already known: a kept lesson for this wall applies here.
    if (wallLessons(r.cls, run.repoKey, env).length) { why = 'known'; continue; }
    const budget = offerBudget({ repoKey: run.repoKey, key, sessionOfferUsed: st.offerUsed, now, env });
    // A no (or two ignored offers) for this repair's key is about this key only: another repair in the run may be due.
    if (!budget.ok && KEY_ONLY.has(budget.why)) { why = `budget:${budget.why}`; continue; }
    if (!budget.ok) return { due: false, why: `budget:${budget.why}` };
    // The governor (4.20): moment 3 then needs two earlier epochs.
    if (seen.epochs < (budget.extraDay ? 2 : 1)) { why = 'not-repeated'; continue; }

    const compiled = compileOffered(sheet, st, ctx);
    const asSkill = compiled.ok && compiled.skill.steps.length >= 2;
    const lesson = asSkill ? null : repairLessonText(r.cls, r.delta);
    if (!asSkill && !lesson) { why = 'too-long'; continue; }
    const joined = asSkill ? joinCarriedSheet(sheet, (id) => readRunSheet(id, env)) : null;
    const hit = run.calls[verdict.checkIndex]?.check;
    const branches = joined && run.job === 'ship' ? stableBranches(joined.calls, joined.jobWords) : [];
    const nth = seen.epochs + 1;
    const where = lessonWhere(r.cls);
    const lines = withFollowLine(repairLines({
      checkLine: hit ? checkLine(hit, branches) : 'Done: the check passed.', nth, days: daysSince(seen.firstAt, now), cls: r.cls, delta: r.delta,
      program, as: asSkill ? 'skill' : 'lesson', steps: asSkill ? stepsTotal(compiled.skill) : 1, lessonText: lesson, where,
    }), asSkill && compiled.ok ? compiled.skill.followed : undefined);
    const offer: PendingOffer = {
      offerId: newOfferId(), moment: 'repaired', runId: run.id, name: asSkill ? compiled.skill.name : r.cls, key, lines, channel,
      shownAt: channel === 'post-tool' ? null : now.toISOString(), showMe: false, yes: null, typedAfter: [], repo: run.repoKey,
      repair: {
        cls: r.cls, program, nth, firstAt: seen.firstAt ?? localDay(now), as: asSkill ? 'skill' : 'lesson',
        delta: r.delta.map((d) => ({ kind: d.kind, name: d.name, text: d.text, callId: d.callId })), ...(lesson ? { lessonSha: lessonSha(lesson) } : {}),
      },
      ...(asSkill ? { skillSha: skillSha(compiled.skill) } : {}),
    };
    return { due: true, offer };
  }
  return { due: false, why };
}
