/**
 * Phase 1b's CLI surface (design 1.7), beside `cli-skills.ts`:
 *  - `trail skills lesson [<skill>] --offer <offer-id>`: the CLI half of a
 *    lesson save (4.15, `keepLessonCli`); it re-decides from the transcript.
 *  - `trail skills draft init-<n> --print`: the pending init skill compiled
 *    again from its source and printed. Writes nothing.
 *  - `trail forget <id or name>`: a skill lesson id (`ls-…`) or a learning id
 *    (`l-…`: a guardrail or a wall lesson) first, then a kept guardrail's
 *    name (`no-timeout`, the way out its deny names), then a skill. A
 *    learning is marked retired, never deleted; a skill lesson moves to its
 *    skill's `lessons/.forgotten/`.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { flatLine } from '../notes/flatten.js';
import { repoPlace, shownPath } from '../notes/home.js';
import { everyRepoDir } from '../notes/every-repo.js';
import { refuseLinkedIntoCheckout } from '../notes/linked-learnings.js';
import { repoNotesDir } from '../notes/repo-notes-dir.js';
import { LEARNING_ID } from '../notes/learning-fields.js';
import { parseNote, renderNote, type Note } from '../notes/notes.js';
import { writePrivate } from '../util/private-fs.js';
import { WALLS } from '../trace/walls.js';
import { readInitRecord } from '../init/init-record.js';
import { recompileInitSkill } from '../init/replay-runs.js';
import { initDraft } from '../init/review-tty.js';
import { keepLessonCli } from './lesson-gate.js';
import { skillsDir } from './store-fs.js';
import type { Dropped } from './forget-notice.js';

/** `dropped`: what a forget removed and how to bring it back, for D117 (2)'s note when an agent ran it. */
export interface CliOut { code: 0 | 1; lines: string[]; dropped?: Omit<Dropped, 'at'> }

const one = (t: string, max = 60) => flatLine(t, max);
const SKILL_LESSON_ID = /^ls-[0-9a-f]{6}$/;
/** The guardrail templates by name (`no-timeout`, `push-over-ssh`), from the wall catalog. */
const GUARDRAILS = new Map(WALLS.flatMap((w) => (w.guardrail ? [[w.guardrail.fileName.replace(/\.md$/, ''), w.guardrail] as const] : [])));

/** 4.15's CLI half: the saved line and exit 0, or the held line and exit 1. */
export function lessonCommand(skill: string | null, offerId: string, env: NodeJS.ProcessEnv, now: Date): CliOut {
  const r = keepLessonCli(skill, offerId, env, now);
  return { code: r.code, lines: [r.line] };
}

/** `trail skills draft init-<n> --print`: the pending init skill n, compiled again from its source (R24, R37). */
export function initDraftCommand(n: number, cwd: string, env: NodeJS.ProcessEnv, now: Date): CliOut {
  const key = repoPlace(cwd, env).key;
  const p = key ? readInitRecord(key, env).pending.find((x) => x.n === n) : undefined;
  if (!p) return { code: 1, lines: [`✗ no item ${n} waits for an answer in this repo · look back again: trail init --look-back`] };
  if (p.kind !== 'skill' || !p.skill) return { code: 1, lines: [`✗ item ${n} is ${p.kind === 'guardrail' ? 'an always-follow learning' : 'a learning'}, not a skill: it has no steps to show`] };
  const r = recompileInitSkill(p.skill.src, key, env, now);
  if (!r.ok) return { code: 1, lines: [`✗ ${one(p.plainName)}: its past session changed or is gone, so Trail can't show the steps.`] };
  return { code: 0, lines: initDraft({ ...r.compiled, name: p.plainName || r.compiled.name }) };
}

/** A plain file, not a link, whose text parses as a learning. */
function readLearning(path: string): Note | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    return parseNote(readFileSync(path, 'utf8'), path);
  } catch {
    return null;
  }
}

/**
 * The learnings forget may retire: every-repo ones, then this repo's personal ones. The every-repo folder may be a
 * dotfiles link (D114 (1)), as the session-start lister and the guardrail read it; the per-repo one never is.
 */
function learningFiles(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const dirs: Array<[string, boolean]> = [[everyRepoDir(env), true]];
  try {
    const key = repoPlace(cwd, env).key;
    if (key) dirs.push([repoNotesDir(key, env), false]);
  } catch { /* no repo here */ }
  return dirs.flatMap(([d, linkOk]) => {
    try {
      if (!(linkOk ? statSync(d) : lstatSync(d)).isDirectory()) return [];
      return readdirSync(d).filter((f) => f.endsWith('.md')).sort().map((f) => join(d, f));
    } catch {
      return [];
    }
  });
}

/** Marks a learning retired (it stops loading and enforcing), never deleting it, and never through a link into a Trail checkout. */
function retire(n: Note, env: NodeJS.ProcessEnv): CliOut {
  if (n.status === 'retired') return { code: 0, lines: [`✓ ${one(n.title)} was already forgotten`] };
  const { path, ...rest } = n;
  try {
    refuseLinkedIntoCheckout(dirname(path), env);
  } catch (e) {
    return { code: 1, lines: [`✗ ${(e as Error).message}`] };
  }
  writePrivate(path, renderNote({ ...rest, status: 'retired' }));
  const what = n.kind === 'guardrail' ? 'guardrail' : n.kind === 'lesson' ? 'lesson' : 'learning';
  const name = what === 'guardrail' ? basename(path, '.md') : one(n.title, 60);
  return {
    code: 0, lines: [`✓ ${what === 'guardrail' ? 'always-follow learning' : 'learning'} forgotten: ${one(n.title, 80)} · it stops loading; the file stays, marked retired: ${shownPath(path)}`],
    dropped: { what, name, back: `change status: retired to status: active in ${shownPath(path)}` },
  };
}

/** A skill lesson by id: its file moves to the skill's `lessons/.forgotten/`. */
function forgetSkillLesson(id: string, env: NodeJS.ProcessEnv): CliOut | null {
  let skills: string[];
  try { skills = readdirSync(skillsDir(env)).filter((s) => !s.startsWith('.')); } catch { return null; }
  for (const skill of skills) {
    const dir = join(skillsDir(env), skill, 'lessons');
    let files: string[];
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      try {
        if (!lstatSync(path).isFile()) continue;
        const m = /^id:\s*"?(ls-[0-9a-f]{6})"?\s*$/m.exec(readFileSync(path, 'utf8').slice(0, 4096));
        if (m?.[1] !== id) continue;
        const gone = join(dir, '.forgotten');
        mkdirSync(gone, { recursive: true, mode: 0o700 });
        renameSync(path, join(gone, f));
        return {
          code: 0, lines: [`✓ learning ${id} forgotten · it no longer rides with ${one(skill)}`],
          dropped: { what: 'lesson', name: id, back: `move ${f} from ${shownPath(gone)}/ back into ${shownPath(dir)}/` },
        };
      } catch { /* the next one */ }
    }
  }
  return null;
}

/**
 * `trail forget` for what isn't a skill: an id first, then a kept guardrail's name. Null when `arg` is neither, so
 * the caller tries a skill of that name; a lesson-id shape that matches nothing is an error, never a skill (b4 review).
 */
export function forgetLearning(arg: string, cwd: string, env: NodeJS.ProcessEnv): CliOut | null {
  if (SKILL_LESSON_ID.test(arg)) return forgetSkillLesson(arg, env) ?? { code: 1, lines: [`✗ no learning called ${one(arg, 40)}`] };
  if (LEARNING_ID.test(arg)) {
    const n = learningFiles(cwd, env).map(readLearning).find((x) => x?.id === arg);
    return n ? retire(n, env) : { code: 1, lines: [`✗ no learning called ${one(arg, 40)} here`] };
  }
  const g = GUARDRAILS.get(arg);
  if (g) {
    const n = learningFiles(cwd, env).map(readLearning).find((x) => x && x.kind === 'guardrail'
      && (x.path.endsWith(`/${arg}.md`) || x.title === g.title) && x.status !== 'retired');
    if (n) return retire(n, env);
  }
  return null;
}
