/**
 * Lessons (design 1.3, 2.3, 4.14 steps 2 and 5, 4.16, spec 7 and 13): one
 * line the person kept on a skill after correcting it, or about a wall a
 * fix got past. A lesson on a skill rides at the end of the skill's run
 * block; a wall lesson (no skill) is a learning of kind `lesson` that only
 * `lastTimeText` reads (R47), every repo for a machine wall and this repo's
 * personal folder for git-https-auth (R49).
 *
 * The correction phrase is deterministic: the person's own clause, a few
 * fixed forms, nothing a model wrote. Lesson text is one flattened line of at
 * most 200 characters, with a leading `[trail]` or `[graft]` gone, when it is
 * written and again when it is read (a lesson file can be edited by hand).
 *
 * Files 0600 in 0700 folders, every path under `trailPath(env)` (0 rule 11),
 * never written through a link.
 */
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { WallClass } from '../trace/types.js';
import { flatLine } from '../notes/flatten.js';
import { matter } from '../util/front-matter.js';
import { EVERY_REPO, liveLessons, newLearningId, readLearningFields, WALL_CLASSES } from '../notes/learning-fields.js';
import { parseNote, renderNote, type Note } from '../notes/notes.js';
import { everyRepoDir, writeEveryRepo } from '../notes/every-repo.js';
import { repoNotesDir } from '../notes/repo-notes-dir.js';
import { lessonNotesIn } from '../notes/lesson-index.js';
import { trailPath, writePrivate } from '../util/private-fs.js';
import { privateDir, safeName, skillsDir } from './store-fs.js';
import { ownFolder } from './own-folder.js';
import { gatedKind } from './risk.js';
import { neverSave } from './never-save.js';
import { askText } from '../trace/jobs.js';

export interface Lesson {
  /** Skill lesson: 'ls-' + 6 hex (never a learning id, R4). Wall lesson: the learning's id. */
  id: string;
  /** null: tied to a wall only (moment 3 fallback). */
  skill: string | null;
  /** Local date. */
  at: string;
  /** At most 200 chars, flatLine'd, a leading [trail] or [graft] stripped (spec 7, R27). */
  text: string;
  /** 'guardrail' when the text starts with never / don't / ask first (spec 13). */
  kind: 'lesson' | 'guardrail';
  src: 'correction' | 'repair';
  wall: WallClass | null;
}

export const LESSON_MAX = 200;
const MAX_FILE = 4 * 1024;
const MAX_FILES = 50;
const NEWEST = 3;
const LESSON_ID = /^ls-[0-9a-f]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Walls about the machine, not one repo (spec 2, R49): their lessons hold in every repo. */
const REPO_WALLS = new Set<WallClass>(['git-https-auth']);

/** The words a lesson reaches the agent and the person in (J07, 4.14, 4.15). Information, tied to the skill (D88). */
export const LESSON_COPY: Record<string, string> = {
  line: 'New learning (the person, {date}): {text}',
  lineAlways: 'Always follow (the person, {date}): {text}',
  offerFirst: 'You corrected {skill}: {said}.',
  offerSecond: 'Add a learning to it, just for you: "{lesson}"? (yes / no)',
  saved: "✓ learning added to {skill}, just for you · it rides at the end of the skill's steps · undo: trail forget {id}",
  savedWall: '✓ learning kept, just for you {where} · Trail shows it when "{fixed}" comes back · undo: trail forget {id}',
};

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

/* ----------------------------------------------------------- the phrase */

/**
 * Words a correction often starts with before its clause ("no, it didn't ..."). Not 'also': that is a form. A `no`
 * that starts "no need to", "no reason to" ... is the clause's own negation, never an interjection: dropping it
 * would turn "no need to run the tests" into the lesson "run the tests" (review).
 */
const LEAD = /^(?:(?:no(?!\s+(?:need|reason|point|use|more|longer|way|one|matter|problem|worries|thanks|rush|idea)\b)|nope|oh|hey|wait|actually|but|and|so|ok|okay|hmm|um|well|please|sorry)\b[\s,.!:;-]*)+/i;
/** A tag question at the clause's end (", right", ", did it"): not part of the lesson. */
const TAG = /,\s*(?:right|ok(?:ay)?|yeah|yes|no|eh|huh|(?:did|didn'?t|does|doesn'?t|is|isn'?t|was|wasn'?t)\s+(?:it|you))\s*$/i;
/** Every line break flatLine knows: the person's clause ends at the first (what follows can be a pasted log). */
const BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;
/** A comma before a new subject ends the clause ("don't publish locally, it breaks CI"). */
const NEW_SUBJECT = /,\s*(?:(?:and|but|so|then)\s+)?(?:i|you|we|it|they|he|she|that|this|there|which)\b/i;
const QUESTION = /^(?:did|does|can|could|would|will|is|are|was|were|why|what|how|where|when|who|which|shall)\b|^(?:do|have|has)\s+(?:you|we|i|they|it)\b/i;
const MODAL = /^(?:also|need to|needs to|have to|has to|should|must)(?:\s+|$)/i;
const CLAUSE_MAX = 80;

const FORMS: Array<{ re: RegExp; make: (m: RegExpExecArray) => { lesson: string; kind: 'lesson' | 'guardrail' } | null }> = [
  { re: /^(?:it|you)\s+(?:didn'?t|did not|forgot to|never)\s+(.+)$/i, make: (m) => ({ lesson: `${m[1]} too`, kind: 'lesson' }) },
  {
    re: /^(?:you\s+)?(?:also|need to|have to|should|must)\s+(.+)$/i,
    make: (m) => {
      let rest = m[1]!;
      while (MODAL.test(rest)) rest = rest.replace(MODAL, '');
      return rest ? { lesson: rest, kind: 'lesson' } : null;
    },
  },
  { re: /^(?:don'?t forget to|do not forget to|remember to|make sure to)\s+(.+)$/i, make: (m) => ({ lesson: m[1]!, kind: 'lesson' }) },
  { re: /^(?:don'?t|do not|never)\s+(.+)$/i, make: (m) => ({ lesson: `never ${m[1]}`, kind: 'guardrail' }) },
  {
    re: /\bask (?:me )?first\b/i,
    make: (m) => {
      const rest = m.input.replace(/\bask (?:me )?first\b/i, ' ').replace(/^\s*(?:(?:always|please)\s+)*/i, '').replace(/\s+/g, ' ').trim()
        .replace(/^before\s+/i, '').replace(/[\s,.;:!]+$/, '');
      return rest ? { lesson: `ask first before ${rest}`, kind: 'guardrail' } : null;
    },
  },
];

/** The person's clause: leading interjections gone, cut at `.`, `;`, `!`, `?`, a comma before a new subject, or 80 chars. Null for a question. */
function clauseOf(typed: string): string | null {
  // The first line with words: a paste after it is not the clause (review). Quoted ('>') lines and fenced blocks are
  // what the person quoted, not their words (askText, b4 review).
  const first = askText(typed.slice(0, 8000)).replace(/[\u2018\u2019]/g, "'").split(BREAK).find((l) => l.trim()) ?? '';
  let t = flatLine(first, 2000).replace(LEAD, '').trim();
  const end = /[.;!?]/.exec(t);
  if (end) {
    if (end[0] === '?') return null;
    t = t.slice(0, end.index);
  }
  const sub = NEW_SUBJECT.exec(t);
  if (sub) t = t.slice(0, sub.index);
  if (t.length > CLAUSE_MAX) {
    const cut = t.slice(0, CLAUSE_MAX + 1);
    const sp = cut.lastIndexOf(' ');
    t = sp > 0 ? cut.slice(0, sp) : t.slice(0, CLAUSE_MAX);
  }
  t = t.replace(TAG, '').replace(/[\s,:-]+$/, '').trim();
  if (!t || QUESTION.test(t)) return null;
  return t;
}

/** The correction forms of 4.14 step 2, first match. Null when none matches. */
export function correctionPhrase(typed: string): { said: string; lesson: string; kind: 'lesson' | 'guardrail' } | null {
  if (typeof typed !== 'string') return null;
  const said = clauseOf(typed);
  if (!said) return null;
  for (const f of FORMS) {
    const m = f.re.exec(said);
    if (!m) continue;
    const made = f.make(m);
    if (!made) return null;
    const lesson = made.lesson.replace(/\s+/g, ' ').trim();
    // The person's clause and the lesson made from it are both held to lessonRefused ("no need to ask first").
    return lesson && !lessonRefused(said) && !lessonRefused(lesson) ? { said, lesson, kind: made.kind } : null;
  }
  return null;
}

/* ------------------------------------------------------------- the text */

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A value of 2+ chars back to `{name}`, longest first, never inside a longer number or word. */
function putParamsBack(cmd: string, params: Record<string, string>): string {
  let out = cmd;
  const pairs = Object.entries(params).filter(([, v]) => typeof v === 'string' && v.length >= 2).sort((a, b) => b[1].length - a[1].length);
  // At a word's start, or right after a lone `v` ("v1.4.3").
  const start = '(?:(?<![0-9A-Za-z_.])|(?<=(?:^|[^0-9A-Za-z_.])v))';
  for (const [name, v] of pairs) out = out.replace(new RegExp(`${start}${escapeRe(v)}(?![0-9A-Za-z_])`, 'g'), `{${name}}`);
  return out;
}

/** `{lesson}: {fix command}` (params put back), or `{lesson}` alone; one line, at most 200, no leading marker. A cut command is never kept. */
export function lessonText(phrase: { lesson: string }, fixCmd: string | null, params: Record<string, string>): string {
  const lesson = flatLine(phrase.lesson, LESSON_MAX);
  if (fixCmd) {
    const fix = flatLine(putParamsBack(String(fixCmd), params ?? {}), 4000);
    const both = flatLine(`${lesson}: ${fix}`, 4000);
    if (fix && both.length <= LESSON_MAX) return both;
  }
  return lesson;
}

export function lessonSha(text: string): string {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

export function newLessonId(): string {
  return `ls-${randomBytes(3).toString('hex')}`;
}

/* ------------------------------------------------------------ the files */

const GUARDRAIL_START = /^(?:never|don'?t|do not|ask first)\b/i;
const kindOf = (text: string, said?: unknown): Lesson['kind'] => (said === 'guardrail' || GUARDRAIL_START.test(text) ? 'guardrail' : 'lesson');

/** "never ask first", "don't wait for my yes": a never / don't that has the agent not ask. */
const NO_ASK = /^(?:never|don'?t|do not)\s+(?:(?!without\b)\w+\s+){0,2}?(?:ask\w*|confirm\w*|prompt\w*|wait\s+for|check\s+with)\b/i;
/** "skip the confirmation", "stop asking", "run it without asking", "not ask for approval". */
const SKIP_ASK = /\b(skip\w*|bypass\w*|stop|without|no need to|not|avoid\w*)\s+(?:\w+\s+){0,2}?(?:ask\w*|confirm\w*|prompt\w*|approv\w*|permission|(?:my|a|the|their)\s+yes)\b/gi;

/**
 * Talk of asking the person: ask me / first / before / for my yes, confirm with, check with me, approval, my yes,
 * wait for me. Not a wall's own words ("the HTTPS push asking for a username"): that is a program asking, not the
 * person being asked.
 */
const ASK_TALK = new RegExp([
  String.raw`\bask(?:s|ed|ing)?\b(?=\s*(?:$|[,.;:!?]|(?:me|us|them|the person|first|before|again)\b|for\s+(?:my|a|an|the|their|your|any)\s+(?:yes|ok|okay|go-ahead|approval|permission|confirmation|sign-off)\b))`,
  String.raw`\bconfirm(?:s|ed|ing)?\b(?=\s*(?:$|[,.;:!?]|(?:with|first|before)\b))`,
  String.raw`\bcheck(?:s|ed|ing)?\s+with\s+(?:me|us|them|the person)\b`,
  String.raw`\b(?:approval|permission|confirmation|sign-off|go-ahead)\b`,
  String.raw`\b(?:my|a|the|their|your)\s+(?:yes|ok|okay)\b`,
  String.raw`\bwait(?:s|ed|ing)?\s+for\s+(?:me|my|a|the|their|your)\b`,
].join('|'), 'i');
/** What a lesson may say before its ask: "you should", "please", "so". */
const ASK_LEAD = /^(?:(?:please|so|just|you|we)\s+)*(?:(?:should|must|need to|needs to|have to|has to|also)\s+)*/i;
const WHO = String.raw`(?:me|us|them|the person)`;
/** The forms that add asking (D111): "ask first before X", "always ask before X", "never X without asking". */
const ADDS_ASK = [
  new RegExp(String.raw`^(?:always\s+)?ask\s+(?:${WHO}\s+)?(?:first\s+)?before\s+(.+)$`, 'i'),
  new RegExp(String.raw`^always\s+(?:ask|check\s+with\s+${WHO}|confirm\s+with\s+${WHO})(?:\s+${WHO})?(?:\s+first)?$`, 'i'),
  new RegExp(String.raw`^(?:never|don'?t|do not)\s+(.+?)\s+(?:without|before|until)\s+(?:asking(?:\s+${WHO})?|you\s+ask(?:\s+${WHO})?|i\s+(?:say\s+yes|confirm|approve)|(?:my|a|an)\s+(?:yes|ok|okay|approval|go-ahead)|confirming(?:\s+with\s+${WHO})?|confirmation|approval|permission|checking\s+with\s+${WHO})(?:\s+first)?$`, 'i'),
];
/** A negation inside what the ask is for ("ask first before you don't need to") turns the ask around. */
const ASK_NEG = /\b(?:not|no|never|needn'?t|without)\b|n'?t\b/i;

/** D111: the text talks about asking the person, and is not one of the forms that add asking. */
function asksWithoutAdding(t: string): boolean {
  if (!ASK_TALK.test(t)) return false;
  const core = t.replace(ASK_LEAD, '').replace(/[\s.!]+$/, '');
  return !ADDS_ASK.some((re) => {
    const m = re.exec(core);
    // What the ask is for, up to the fix command (`{lesson}: {fix}`), whose flags (`--no-sign`) are no negation.
    return m !== null && !(m[1] !== undefined && ASK_NEG.test(m[1].split(': ')[0]!));
  });
}

/**
 * Why a lesson's text can't reach the agent, or null (D88, D101, 4.14 step 3): it tells the agent not to ask or
 * confirm (Trail never says that; Claude Code asks before a step that can't be undone), it talks about asking
 * without adding asking (D111: "you don't need to ask first" must never come back as an ask turned around), a
 * command the risk rules never keep, or, unless it is a guardrail that forbids it ("never npm publish from a
 * laptop"), a gated command the block would show with no ask. The same rule for a new lesson's phrase and for a
 * lesson file read back.
 */
export function lessonRefused(text: string): string | null {
  const t = flatLine(text, 4000);
  const guard = GUARDRAIL_START.test(t);
  if (NO_ASK.test(t)) return 'skips the ask';
  // "never publish without asking" asks: a never / don't before `without` is the person's own double negative.
  for (const m of t.matchAll(SKIP_ASK)) if (!(guard && /^without$/i.test(m[1]!))) return 'skips the ask';
  if (asksWithoutAdding(t)) return 'talks about asking without adding it';
  const never = neverSave(t);
  if (never) return never;
  if (!guard && gatedKind(t)) return 'runs a step that cannot be undone';
  return null;
}
const isWall = (v: unknown): v is WallClass => (WALL_CLASSES as readonly unknown[]).includes(v);
const one = (v: unknown) => (typeof v === 'string' ? v : v instanceof Date ? v.toISOString().slice(0, 10) : '');

/** The first free `<date>[-n].md` style name in `dir` (lstat: a link counts as taken). */
function freeName(dir: string, stem: string, numbered: boolean): string {
  for (let n = 1; n < 1000; n++) {
    const name = numbered ? `${stem}-${n}.md` : n === 1 ? `${stem}.md` : `${stem}-${n}.md`;
    let taken = true;
    try { lstatSync(join(dir, name)); } catch { taken = false; }
    if (!taken) return name;
  }
  throw new Error('trail: too many new learnings on one day');
}

/** Throws when `dir` or a folder between the Trail home and it is a link: a planted link would carry the lesson out (b4 review). */
function noLinkTo(dir: string, env?: NodeJS.ProcessEnv): void {
  const home = trailPath(env);
  const rel = relative(home, dir);
  if (!rel || rel.startsWith('..')) return ownFolder(dir);
  let at = home;
  for (const part of rel.split(sep)) ownFolder((at = join(at, part)));
}

function wallLearning(l: Lesson, text: string, repoKey: string, env?: NodeJS.ProcessEnv): string {
  const wall = l.wall!;
  const input = { title: flatLine(text, 80), body: text, author: '', date: l.at, kind: 'lesson' as const, src: l.src, wall };
  if (!REPO_WALLS.has(wall)) {
    // D114 (1): the every-repo folder follows the every-repo writer's rule (a link into a Trail checkout is refused there).
    const dir = everyRepoDir(env);
    const name = existsSync(dir) ? freeName(dir, `lesson-${wall}-${l.at}`, false) : `lesson-${wall}-${l.at}.md`;
    return writeEveryRepo(input, name, env);
  }
  const dir = repoNotesDir(repoKey, env);
  noLinkTo(dir, env);
  privateDir(dir);
  const name = freeName(dir, `${l.at}-lesson-${wall}`, false);
  const note: Omit<Note, 'path'> = {
    title: input.title, author: '', date: l.at, touches: [], body: text,
    ...readLearningFields({ ...input, id: newLearningId(name), scope: 'personal', applies: repoKey, status: 'active' }, name),
  };
  writePrivate(join(dir, name), renderNote(note));
  return join(dir, name);
}

/**
 * skills/<name>/lessons/<date>-<n>.md for a skill (never written through a link); for a wall-only lesson a learning
 * of kind lesson (every-repo for a machine wall, the repo's personal folder for git-https-auth, R49). Returns the path.
 */
export function writeLesson(l: Lesson, repoKey: string, env?: NodeJS.ProcessEnv): string {
  const text = flatLine(l.text, LESSON_MAX);
  if (!text) throw new Error('trail: a learning needs its text');
  if (!DATE.test(String(l.at))) throw new Error('trail: a learning needs its date');
  if (l.skill === null || l.skill === undefined) {
    if (!isWall(l.wall)) throw new Error('trail: a learning needs a skill or an error');
    return wallLearning({ ...l, src: l.src === 'correction' ? 'correction' : 'repair' }, text, repoKey, env);
  }
  if (!safeName(l.skill)) throw new Error(`trail: not a skill name: ${flatLine(l.skill, 60)}`);
  ownFolder(skillsDir(env));
  const dir = join(skillsDir(env), l.skill);
  let st;
  try { st = lstatSync(dir); } catch { throw new Error(`trail: no skill called ${l.skill}`); }
  if (st.isSymbolicLink()) throw new Error(`trail: ${dir} is a link; Trail won't write a learning through it.`);
  if (!st.isDirectory()) throw new Error(`trail: no skill called ${l.skill}`);
  const lessons = join(dir, 'lessons');
  ownFolder(lessons);
  privateDir(lessons);
  const name = freeName(lessons, l.at, true);
  const id = LESSON_ID.test(l.id) ? l.id : newLessonId();
  const front = ['---', `id: ${JSON.stringify(id)}`, `kind: ${JSON.stringify(kindOf(text, l.kind))}`, `skill: ${JSON.stringify(l.skill)}`,
    `src: ${JSON.stringify(l.src === 'repair' ? 'repair' : 'correction')}`, `at: ${JSON.stringify(l.at)}`];
  if (isWall(l.wall)) front.push(`wall: ${JSON.stringify(l.wall)}`);
  writePrivate(join(lessons, name), `${[...front, '---', text].join('\n')}\n`);
  return join(lessons, name);
}

/** One lesson file, or null: a regular file (not a link) of at most 4 KB, with front matter, a date and text. The kind is the text's (spec 13). */
function readLessonFile(path: string, skill: string): Lesson | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const fm = matter(readFileSync(path, 'utf8'), { scalars: ['id', 'kind', 'skill', 'src', 'at', 'wall'] });
    if (fm.refused) return null;
    const d = fm.data as Record<string, unknown>;
    const text = flatLine(String(fm.content ?? ''), LESSON_MAX);
    const at = DATE.test(one(d.at)) ? one(d.at) : /^(\d{4}-\d{2}-\d{2})-\d+\.md$/.exec(basename(path))?.[1] ?? '';
    if (!text || !at) return null;
    const id = LESSON_ID.test(one(d.id)) ? one(d.id) : `ls-${createHash('sha256').update(basename(path)).digest('hex').slice(0, 6)}`;
    return { id, skill, at, text, kind: kindOf(text), src: d.src === 'repair' ? 'repair' : 'correction', wall: isWall(d.wall) ? d.wall : null };
  } catch {
    return null;
  }
}

/** `2026-11-03-10.md` after `2026-11-03-2.md`: by name with its numbers as numbers. */
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** The lessons in `<skillDir>/lessons/` (never through a link), oldest first; the newest 50 files read. */
export function readLessons(skillDir: string): Lesson[] {
  let names: string[];
  try {
    if (!lstatSync(join(skillDir, 'lessons')).isDirectory()) return [];
    names = readdirSync(join(skillDir, 'lessons')).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort(byName).slice(-MAX_FILES);
  } catch {
    return [];
  }
  const skill = basename(skillDir);
  return names.map((n) => readLessonFile(join(skillDir, 'lessons', n), skill)).filter((l): l is Lesson => l !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The live lessons kept for a wall class here: every-repo ones, then this repo's (oldest first). For lastTimeText
 * (4.10). D117 (4): read through the mtime-keyed lesson index; `write` (Stop, session start) keeps what changed.
 */
export function wallLessons(cls: WallClass, repoKey: string, env?: NodeJS.ProcessEnv, opts: { write?: boolean } = {}): Lesson[] {
  const dirs = [everyRepoDir(env)];
  try { dirs.push(repoNotesDir(repoKey, env)); } catch { /* no repo key */ }
  const [everyNotes = [], mineNotes = []] = lessonNotesIn(dirs, env, opts);
  const mine = mineNotes.filter((n) => !n.applies || n.applies.toLowerCase() === repoKey.toLowerCase());
  const every = everyNotes.filter((n) => !n.applies || n.applies === EVERY_REPO);
  return liveLessons([...every, ...mine]).filter((n) => n.wall === cls).flatMap((n) => {
    const text = flatLine(n.body, LESSON_MAX);
    // A hand edit is held to the run block's rule (lessonRefused): the agent reads this text too.
    return text && !lessonRefused(text) ? [{ id: n.id, skill: null, at: n.date, text, kind: kindOf(text), src: n.src === 'correction' ? 'correction' as const : 'repair' as const, wall: cls }] : [];
  }).sort((a, b) => a.at.localeCompare(b.at));
}

/* ------------------------------------------------------------ the lines */

/** 'Nov 3' for a local date. */
function dayOf(d: string): string {
  const m = DATE.exec(d) ? d.split('-').map(Number) : null;
  return m ? `${MONTHS[m[1]! - 1] ?? 'Jan'} ${m[2]}` : 'an earlier day';
}

/** A guardrail-kind lesson (never trimmed from a block): so marked, or its text starts with never / don't / ask first. */
export const isGuardrailLesson = (l: Lesson) => kindOf(flatLine(l.text, LESSON_MAX), l.kind) === 'guardrail';

/** Guardrail-kind lessons first (never trimmed), then up to 3 newest lessons, oldest of them first (4.16, J07). */
/** One lesson's line (`New learning (the person, Nov 3): ...`, or `Always follow (...)` for a guardrail-kind one). */
export const lessonLine = (l: Lesson) =>
  fill((isGuardrailLesson(l) ? LESSON_COPY.lineAlways : LESSON_COPY.line)!, { date: dayOf(l.at), text: flatLine(l.text, LESSON_MAX) });

export function lessonLines(lessons: Lesson[]): string[] {
  const line = lessonLine;
  const byDate = [...lessons].sort((a, b) => a.at.localeCompare(b.at));
  const guard = byDate.filter(isGuardrailLesson);
  const rest = byDate.filter((l) => !guard.includes(l)).slice(-NEWEST);
  return [...guard, ...rest].map(line).filter((l) => !/: $/.test(l));
}
