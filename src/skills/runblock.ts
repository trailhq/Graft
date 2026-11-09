/**
 * What a skill brings back (design 4.15, spec 11): the run block a job or
 * name cue injects, the check line a status question gets, the injection
 * recorded for either, and the one line the person sees.
 *
 * The block is past tense and attributed ("fits", "last worked Oct 14",
 * "what worked was step 5"), never an order: the agent starts from the
 * steps because they worked here before. At most 1,200 characters. Every
 * value is flattened to one line and every line after the header starts
 * with two spaces, so nothing in a skill file can open a `[trail]` line.
 *
 * A step that can't be undone is said once, after its group: where the
 * host can ask the person, Claude Code will ask before the group's first
 * step and the agent waits for that; where it can't (headless, permissions
 * skipped, another host), the agent shows the person the command instead
 * of running it (D17). The words never tell the agent not to ask and never
 * say what one yes covers (D101): an agent read those as a bypass.
 */
import { randomBytes } from 'node:crypto';
import type { SkillInjection } from '../trace/types.js';
import { nameOf, type Candidate } from './recall.js';
import { flatLine } from '../notes/flatten.js';
import { monthDay } from './compile-words.js';
import { fillParams } from './params.js';
import { gatedGroups, gatedKind } from './risk.js';
import { neverSave } from './never-save.js';
import { checkFamilyOf } from '../trace/checks.js';
import { commandKind } from '../trace/shell.js';
import type { ParsedSkill } from './types.js';
import { beforeYouStart } from './skillmd.js';
import { probePassWords, type ProbeResult } from './probes.js';
import { isGuardrailLesson, lessonLines, lessonRefused, readLessons, type Lesson } from './lessons.js';
import { goneAnchors, outOfDateLine, type Anchor } from './anchors.js';
import { WIDE_SCAN_MS } from './anchors-wide.js';
import { markLines, stepNote, withFixes, type RecallMark } from './follow-learnings.js';

export { runProbes, probePassWords, readyProbes, PROBE_BUDGET_MS, type ProbeResult, type ProbeOpts, type ProbeGit } from './probes.js';

export const RUN_BLOCK_MAX = 1200;

/** A command or value on one line, never cut (a cut command would be wrong; an overlong block becomes the pointer). */
const flat = (t: unknown) => flatLine(t, 4000);
const prose = (t: unknown, max = 200) => flatLine(t, max);

/** 'Oct 14' for a local date (`2026-10-14`) or an ISO time, in local time. */
export function dayWords(d: string | null | undefined): string {
  if (!d) return 'an earlier day';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? monthDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString()) : monthDay(d);
}

const OWNER = { personal: 'yours', repo: "the repo's", team: "the team's" } as const;

/** 'last worked Oct 14', or 'saved Oct 14' for a skill that never checked out. */
function whenWords(c: Candidate): string {
  return c.state?.lastWorked ? `last worked ${dayWords(c.state.lastWorked)}` : `saved ${dayWords(c.state?.addedAt ?? null)}`;
}

const listWords = (ns: number[]) => (ns.length === 2 ? `${ns[0]} and ${ns[1]}` : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

function gatedNote(steps: number[], canAsk: boolean): string {
  const one = steps.length === 1;
  const which = one ? `step ${steps[0]}` : `steps ${listWords(steps)}`;
  // D101: never "don't ask", never what one yes covers (that stays in pre-bash-skills' gate logic).
  // D118 a: a step whose ask was denied is not run again that turn (the lab's agent retried a push three times).
  if (!canAsk) {
    return one
      ? `    This session can't ask the person, so don't run ${which} (it can't be undone), not even after a yes in chat; show them the command to run themselves.`
      : `    This session can't ask the person, so don't run ${which} (they can't be undone), not even after a yes in chat; show them the commands to run themselves.`;
  }
  const retry = ` If they say no, don't retry this turn; ask them to run ${one ? 'it' : 'them'}.`;
  return one
    ? `    Claude Code will ask the person before ${which} (it can't be undone); wait for that.${retry}`
    : `    Claude Code will ask the person before step ${steps[0]} (${which} can't be undone); wait for that.${retry}`;
}

/** What a tests or query check shows by default: "step n passing" already says it. */
const PLAIN_SHOWS = new Set(['the tests pass', 'rows come back']);

function checkText(c: Candidate, values: Record<string, string>, skill: Pick<ParsedSkill, 'check' | 'checkShows' | 'meta'> = c.skill): { text: string; shows: string | null } | null {
  const s = skill;
  if (!s.check) return null;
  const shows = s.checkShows ? prose(fillParams(s.checkShows, values)) : s.meta['check-tool'] ? 'READY' : null;
  return { text: flat(fillParams(s.check, values)), shows };
}

/** 1b: a personal skill's lessons from its own folder (4.16); none for a skill that isn't in one. */
function lessonsOf(c: Candidate): Lesson[] {
  return c.ref.scope === 'personal' && c.ref.dir ? readLessons(c.ref.dir) : [];
}

/** 1b: the anchors gone where the candidate was found (4.18; local file reads only). Phase 2 (4.13): a job cue's block may scan the CLI (its own 150 ms); a compaction's (SessionStart) reads only the cache. */
function goneOf(c: Candidate, scan: boolean, until?: number): Anchor[] {
  return c.here ? goneAnchors(c.skill, c.here.checkout, c.here.env ?? process.env, { scan, deadline: Math.min(until ?? Infinity, Date.now() + WIDE_SCAN_MS) }) : [];
}

/**
 * canAsk: interactive entry, permission_mode in hostFacts.askModes, host claude (4.15 step 5).
 * 1b: `lessons` (default: the skill folder's) end the block, guardrail-kind first (4.16); `gone` (default: the
 * anchors gone where the candidate was found) opens it with the out-of-date line (4.18). Both count toward 1,200:
 * lessons are the second thing cut, oldest first; guardrail-kind lessons and the out-of-date line never are.
 */
export function runBlock(c: Candidate, ctx: { values: Record<string, string>; notes: string[]; probes: ProbeResult[]; canAsk: boolean; header: 'job' | 'compact'; lastFail: { step: number; at: string } | null; lessons?: Lesson[]; gone?: Anchor[]; anchorDeadline?: number; marks?: RecallMark[] }): string {
  // Part 7: a step the person's learning goes against shows its way (or is marked to leave out); never cut.
  const marks = ctx.marks ?? [];
  const s = withFixes(c.skill, marks);
  const name = nameOf(c);
  const ood = outOfDateLine(name, ctx.gone ?? goneOf(c, ctx.header === 'job', ctx.anchorDeadline));
  const opening = ood ? [`[trail] ${ood}`] : [];
  // A lesson is information the person kept (J07), filled like the steps; one edited by hand to skip the ask, or to
  // hold a refused or gated command, is left out (D88, D101, 4.14 step 3: lessonRefused).
  const kept = (ctx.lessons ?? lessonsOf(c)).map((l) => ({ ...l, text: fillParams(l.text, ctx.values) })).filter((l) => !lessonRefused(l.text));
  const guardLines = lessonLines(kept.filter(isGuardrailLesson)).map((l) => `  ${l}`);
  const lessonRest = lessonLines(kept.filter((l) => !isGuardrailLesson(l))).map((l) => `  ${l}`);
  const owner = `${OWNER[c.ref.scope] ?? 'yours'}, v${prose(s.meta.version || '1', 12)}, ${whenWords(c)}`;
  const header = ctx.header === 'compact'
    ? `[trail] You were partway through skill ${name} when the conversation was compacted. Its steps (${owner}):`
    : `[trail] Skill ${name} fits (${owner}).${ctx.lastFail ? ` Last time step ${ctx.lastFail.step} failed; watch its output.` : ''} Start from these exact steps, in order:`;

  const failed = ctx.probes.filter((p) => !p.ok).map((p) => `  ready: ${prose(p.why ?? p.probe)}.${p.fix ? ` ${prose(p.fix)}` : ''}`);
  const passedWords = ctx.probes.filter((p) => p.ok).map((p) => probePassWords(p.probe)).filter((w): w is string => !!w);
  const passed = passedWords.length ? `  ready: ${passedWords.join(', ')}` : null;
  // D116 item 5: what the person does first (a login the run fed keystrokes into, kept out of the steps).
  const before = beforeYouStart(s.meta).map((l) => `  before you start: ${prose(l)}.`);
  const checkFirst = String(s.meta['check-first'] ?? '').split(' ; ').map((x) => x.trim()).filter(Boolean).map((x) => `  check first: ${flat(x)}`);

  const groups = gatedGroups(s.steps);
  const steps: string[] = [];
  for (const st of s.steps) {
    const note = st.wait ? ' (a wait: run it in the background if it may take over 2 minutes)' : st.bg ? ' (in the background)' : '';
    const own = c.skill.steps.find((x) => x.n === st.n)?.cmd ?? st.cmd;
    steps.push(`  ${st.n} ${flat(fillParams(st.cmd, ctx.values))}${note}${stepNote(marks, st.n, fillParams(own, ctx.values))}`);
    const g = groups.find((x) => x.steps[x.steps.length - 1] === st.n);
    if (g) steps.push(gatedNote(g.steps, ctx.canAsk));
  }

  const chk = checkText(c, ctx.values, s);
  let check: string | null = null;
  if (chk) {
    const asStep = [...s.steps].reverse().find((x) => x.cmd === s.check);
    if (asStep && !s.meta['check-tool']) {
      check = chk.shows && !PLAIN_SHOWS.has(chk.shows) ? `  check: step ${asStep.n} passing is the check (it should show ${chk.shows}).` : `  check: step ${asStep.n} passing is the check.`;
    } else check = `  check: ${chk.text}${chk.shows ? ` (it should show ${chk.shows})` : ''}`;
  }
  // A line edited by hand to hold a command the risk rules refuse is left out.
  const fails = s.ifFails.filter((l) => !neverSave(l)).slice(0, 2).map((l) => `  If it fails: ${prose(l)}`);
  const notes = ctx.notes.map((n) => `  ${prose(n)}`);
  const footer = `  If a step fails, fix that step and say so. End with "Used skill ${name}".`;
  const follow = markLines(marks).map((l) => `  ${prose(l, 400)}`);

  const build = (o: { notes: boolean; fails: number; passed: boolean; lessons: number }) => [
    ...opening, header, ...failed, ...(o.passed && passed ? [passed] : []), ...before, ...checkFirst, ...steps, ...(check ? [check] : []), ...follow,
    ...fails.slice(0, o.fails), ...(o.notes ? notes : []), footer, ...guardLines, ...lessonRest.slice(lessonRest.length - o.lessons),
  ].join('\n');
  const all = lessonRest.length;
  for (const o of [
    { notes: true, fails: 2, passed: true, lessons: all }, { notes: false, fails: 2, passed: true, lessons: all },
    ...Array.from({ length: all }, (_, i) => ({ notes: false, fails: 2, passed: true, lessons: all - 1 - i })),
    { notes: false, fails: 1, passed: true, lessons: 0 }, { notes: false, fails: 1, passed: false, lessons: 0 },
  ]) {
    const block = build(o);
    if (block.length <= RUN_BLOCK_MAX) return block;
  }
  return [...opening, `[trail] Skill ${name} fits this ask, but its steps are too long to show here. Run trail skills show ${name} and start from them.`].join('\n');
}

/** A GET with curl or wget: no other method, no body, no upload. */
const HTTP_GET = /^(?:curl|wget)\s/;
const HTTP_WRITES = /\s(?:-X\s*(?!GET\b)\w|--request\s*(?!GET\b)\w|-d\b|--data\b|--data-\w+|-F\b|--form\b|-T\b|--upload-file\b|--post-\w+|--method=(?!GET\b))/i;

/**
 * D116 item 1: the check is a step that only reads (a status, a view, a log, a GET, a tests or query run), so a
 * status question may run it. A push (it is the step that moved the branch), anything gated, or a command
 * that changes things is not: that skill gets no check line.
 */
export function readOnlyCheck(s: Pick<ParsedSkill, 'check' | 'steps' | 'meta'>): boolean {
  const cmd = String(s.check ?? '').trim();
  if (!cmd) return false;
  if (s.meta['check-tool']) return true;
  if (gatedKind(cmd) || s.steps.some((x) => x.cmd === s.check && x.gated)) return false;
  const fam = checkFamilyOf(cmd, s.meta.job ?? null);
  if (fam) return fam !== 'push';
  if (HTTP_GET.test(cmd)) return !HTTP_WRITES.test(` ${cmd}`);
  return commandKind(cmd) === 'look';
}

/** The check line for a status question; '' when the skill has no check, or none that only reads (D116 item 1). */
export function checkLine(c: Candidate, values: Record<string, string>): string {
  if (!readOnlyCheck(c.skill)) return '';
  const chk = checkText(c, values);
  const name = nameOf(c);
  if (!chk) return '';
  return `[trail] To check ${name}: ${chk.text}${chk.shows ? ` (it should show ${chk.shows})` : ''}. Answer from what it shows; don't run any other step.`;
}

/** D106: a check that shows a `{version}` param, filled with a literal version: what credit expects it to show. */
function checkVersionOf(c: Candidate, values: Record<string, string>): { checkVersion?: string } {
  const name = /^\{([A-Za-z_]\w*)\}$/.exec(String(c.skill.checkShows ?? '').trim())?.[1];
  const v = name && c.skill.params.some((p) => p.name === name && p.shape === 'version') ? values[name] : undefined;
  const m = v === undefined ? null : /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(v.trim());
  return m ? { checkVersion: m[1]! } : {};
}

/** The SkillInjection recorded for a block or check line (live: true for job, name and compact cues). */
export function injectionFor(c: Candidate, values: Record<string, string>, cue: SkillInjection['cue'], epoch: number, now: Date = new Date()): SkillInjection {
  const s = c.skill;
  const block = cue !== 'check';
  const tool = s.meta['check-tool'];
  return {
    injId: `i-${randomBytes(3).toString('hex')}`,
    skillId: c.ref.id || s.meta.trail,
    name: c.ref.name || s.name,
    epoch,
    at: now.toISOString(),
    cue,
    params: { ...values },
    steps: block ? s.steps.map((st) => fillParams(st.cmd, values)) : [],
    gated: block ? s.steps.filter((st) => st.gated).map((st) => ({ step: st.n, kind: st.gated! })) : [],
    check: s.check ? fillParams(s.check, values) : null,
    ...(tool ? { checkTool: tool } : {}),
    ...checkVersionOf(c, values),
    runId: null,
    live: block,
    // 1b (R30): the asks phrase a job cue fired on, by its sha only.
    ...(cue === 'job' && typeof c.phraseSha === 'string' && /^[0-9a-f]{8}$/.test(c.phraseSha) ? { phraseSha: c.phraseSha } : {}),
  };
}

/** g4's open issue 4 (D71 d): the ready probes that failed for a block ride on its injection, for the use line (never counted against the skill). */
export function withReadyFailed(inj: SkillInjection, probes: ProbeResult[]): SkillInjection {
  const failed = probes.filter((p) => !p.ok).map((p) => p.probe);
  return failed.length ? { ...inj, readyFailed: failed } : inj;
}

/** 'trail: using skill <name> (v<n>, worked <Mon D>)'. */
export function useNotice(c: Candidate): string {
  const when = c.state?.lastWorked ? `worked ${dayWords(c.state.lastWorked)}` : `saved ${dayWords(c.state?.addedAt ?? null)}`;
  return `trail: using skill ${nameOf(c)} (v${prose(c.skill.meta.version || '1', 12)}, ${when})`;
}
