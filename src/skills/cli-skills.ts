/**
 * `trail skills` and its subcommands (design 1.7), plus the top-level
 * `trail forget`. Every command that changes something prints one plain line
 * and the command that undoes it. `skills on`, `offers on` and `keep` are the
 * person's: run by an agent (`personAtTerminal` says no), they print who may
 * run them and exit 1. This is the only module that imports the person-only
 * setters of settings.ts (a static test pins it).
 *
 * `add` is g5's CLI half (`cliAdd`): this file only prints what it returns
 * and sends `skill_saved`, because the save gate's import closure may not load
 * telemetry. Telemetry carries closed-set values only, never a name.
 */
import { homedir } from 'node:os';
import { Argument, InvalidArgumentError, type Command } from 'commander';
import { repoPlace } from '../notes/home.js';
import { flatLine } from '../notes/flatten.js';
import { track as sendEvent } from '../telemetry/track.js';
import { findPriorSheet, readRunSheet } from '../trace/runs.js';
import { compileRun, refusalWords } from './compile.js';
import { draftText, repoName } from './compile-words.js';
import { cliAdd } from './save-gate.js';
import { readSettings, setOffers, setSkillOff, setSkills, trailNow } from './settings.js';
import { forgetSkill, keepHeld, listAllPersonal, listHeld, nameTaken, personAtTerminal, restoreSkill, type PersonCheck, type PersonDeps } from './store.js';
import { readCapped } from './store-fs.js';
import { heldWords, reportLines, skillsReport, statusWords, whereWords, type SkillRow1b } from './cli-skills-report.js';
import { extrasWords, fidelityLine } from './cli-skills-report-1b.js';
import { lessonLine, readLessons } from './lessons.js';
import { runCheckout } from './run-checkout.js';
import { forgetLearning, initDraftCommand, lessonCommand, type CliOut } from './cli-skills-1b.js';
import { noteAgentForget, type Dropped } from './forget-notice.js';
import { draftFoldText, liftRestoreVersion, restoreVersionCommand, updateCommand, versionsLine } from './cli-skills-2.js';
import { stepLearnings } from './follow-learnings.js';

/** Seams for tests; production passes nothing. */
export interface SkillCliDeps {
  env?: NodeJS.ProcessEnv;
  /** The clock: default `trailNow(env)` (TRAIL_TEST_NOW in a test home only). */
  now?: () => Date;
  cwd?: () => string;
  /** Passed to the real `personAtTerminal` (TTYs, the process table), as g4's tests do. */
  personDeps?: PersonDeps;
  track?: (event: string, props: Record<string, string>) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
  exit?: (code: number) => void;
}

/** `trail skills on` says this, word for word (1.7). */
export const SKILLS_ON_LINES = [
  '✓ skills on · Trail now counts jobs you ask for on more than one day: job words and dates only, kept on this machine, nothing uploaded.',
  '  When one checks out on its 3rd day, it offers once to keep the commands that worked (at most 1 offer per session, 3 a week).',
  '  See what it counts: trail skills · stop offers: trail skills offers off · all off: trail skills off',
] as const;
export const OFFERS_OFF_LINE = 'Skill offers are off. Turn them back on: trail skills offers on';
/** 1b (R59): numbers are init's; `trail keep` keeps them, after the person typed them. */
export const KEEP_NUMBERS_LINE = 'trail keep <numbers> keeps items from trail init.';
/** A person-only command run by an agent (1.7). */
export const personOnly = (command: string) => `Only the person can run this, in their own terminal: trail ${command}`;

const one = (t: string, max = 60) => flatLine(t, max);

/** Every line break a terminal or an agent might honour. */
const BREAKS = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;
/** Controls but tab (ESC, BEL, C1) and characters nobody sees: they can rewrite a terminal or hide a marker. */
const UNSEEN = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]|[\p{Cf}\ufe00-\ufe0f]/gu;
const MARKER = /^(\s*)(?:\[(?:trail|graft|trail-code)\]\s*)+/i;
/**
 * A SKILL.md as `show` prints it: anyone can edit the file by hand, so no line of it may read as Trail's own
 * (`[trail] ...`) or carry terminal escapes. Indentation stays (it's markdown).
 */
export function shownText(text: string): string {
  return text.split(BREAKS).map((l) => l.replace(UNSEEN, '').replace(MARKER, '$1')).join('\n').trimEnd();
}
const unknownSkill = (name: string) => `✗ no skill called ${one(name)} · trail skills lists them`;
const errText = (e: unknown) => `✗ ${one(e instanceof Error ? e.message : String(e), 200).replace(/^trail:\s*/, '')}`;

interface Io {
  env: NodeJS.ProcessEnv; now: () => Date; cwd: () => string; person: () => PersonCheck;
  track: (event: string, props: Record<string, string>) => void; out: (l: string) => void; err: (l: string) => void; exit: (c: number) => void;
}

function io(d: SkillCliDeps): Io {
  const env = d.env ?? process.env;
  return {
    env,
    now: d.now ?? (() => trailNow(env)),
    cwd: d.cwd ?? (() => process.cwd()),
    person: () => personAtTerminal(env, d.personDeps ?? {}),
    track: d.track ?? ((e, p) => { sendEvent(e, p); }),
    out: d.out ?? ((l) => console.log(l)),
    err: d.err ?? ((l) => console.error(l)),
    exit: d.exit ?? ((c) => { process.exitCode = c; }),
  };
}

/** Runs a command body; a thrown store or settings error (busy, a planted link) prints and exits 1. */
const guarded = (x: Io, fn: () => void) => () => {
  try {
    fn();
  } catch (e) {
    x.err(errText(e));
    x.exit(1);
  }
};

const fail = (x: Io, line: string) => {
  x.err(line);
  x.exit(1);
};

/** Is the person at the keyboard? Otherwise print who may run `command` and exit 1. */
function personOr(x: Io, command: string): boolean {
  if (x.person().ok) return true;
  fail(x, personOnly(command));
  return false;
}

/** A personal skill by name (any repo), or a name the person turned off. */
const knownSkill = (name: string, env: NodeJS.ProcessEnv) =>
  listAllPersonal(env).some((r) => r.name === name) || readSettings(env).skillsOff.includes(name);

/** Prints a 1b command's lines (to stdout on 0, stderr on 1) and its exit code. */
function said(x: Io, r: CliOut): void {
  for (const l of r.lines) (r.code === 0 ? x.out : x.err)(l);
  if (r.code !== 0) x.exit(r.code);
}

function forget(x: Io, name: string): void {
  // 1b: a lesson or learning id, or a kept guardrail's name, before a skill's name (1.7).
  const learning = forgetLearning(name, x.cwd(), x.env);
  if (learning) {
    if (learning.code === 0 && learning.dropped) agentForgot(x, learning.dropped);
    return said(x, learning);
  }
  const r = forgetSkill(name, x.env, x.now());
  if (!r.ok) return fail(x, unknownSkill(name));
  agentForgot(x, { what: 'skill', name, back: `trail skills restore ${one(name)}` });
  x.out(`✓ ${one(name)} forgotten · bring it back: trail skills restore ${one(name)}`);
}

/** D117 (2): an agent's forget (CLAUDECODE, or a claude or pty-wrapper ancestor, as R17) is told to the person at the next Stop. */
function agentForgot(x: Io, d: Omit<Dropped, 'at'>): void {
  try {
    if (x.env.CLAUDECODE === undefined && !x.person().claudeAncestor) return;
  } catch { /* can't tell: note it, telling the person is the safe side */ }
  noteAgentForget(d, x.env, x.now());
}

function list(x: Io, json: boolean): void {
  const r = skillsReport(x.env, x.now(), x.cwd());
  if (json) x.out(JSON.stringify(r, null, 2));
  else for (const l of reportLines(r)) x.out(l);
  // Phase 2 (P27): whether the value line went out, and how; no number from it.
  if (r.value) x.track('skill_value', { channel: 'list' });
}

function show(x: Io, name: string): void {
  const ref = listAllPersonal(x.env).find((r) => r.name === name);
  if (ref) {
    const text = readCapped(ref.file);
    if (text === null) return fail(x, unknownSkill(name));
    const row = skillsReportRow(x, ref.name);
    x.out(shownText(text));
    x.out('');
    x.out(row ? `· ${whereWords(row.applies)} · ${statusWords(row)}${extrasWords(row)}` : `· ${whereWords(ref.applies)}`);
    // Phase 2 (3.6): how its last uses followed it, when the ledger has the counts.
    const fid = fidelityLine(ref.id, x.env);
    if (fid) x.out(`· ${fid}`);
    // Phase 2 (3.6): the versions it keeps, and a change waiting beside a hand-edited file.
    const versions = versionsLine(ref, x.env);
    if (versions) x.out(`· ${versions}`);
    // 1b (2.12): every lesson kept with it, oldest first.
    for (const l of readLessons(ref.dir)) x.out(`  ${lessonLine(l)}`);
    return;
  }
  const held = listHeld(x.env, x.now()).find((h) => h.name === name);
  const text = held ? readCapped(`${held.dir}/SKILL.md`) : null;
  if (!held || text === null) return fail(x, unknownSkill(name));
  x.out(shownText(text));
  x.out('');
  x.out(`· ${heldWords(held)}`);
}

function skillsReportRow(x: Io, name: string): SkillRow1b | null {
  return skillsReport(x.env, x.now(), x.cwd()).skills.find((s) => s.name === name) ?? null;
}

/** "show me" (2.1): the run compiled as an offer would keep it, printed. Writes nothing. */
function draft(x: Io, runId: string, print: boolean): void {
  if (!print) return fail(x, `✗ use --print: trail skills draft ${one(runId, 40)} --print`);
  // 1b: init's pending skill n, compiled again from its source (R24, R37).
  const init = /^init-(\d{1,2})$/.exec(runId);
  if (init) return said(x, initDraftCommand(Number(init[1]), x.cwd(), x.env, x.now()));
  // Phase 2 (4.7): a run whose change to a skill is offered prints that change as a diff.
  const fold = draftFoldText(runId, x.env);
  if (fold) return x.out(fold);
  const sheet = readRunSheet(runId, x.env);
  if (!sheet) return fail(x, `✗ no run called ${one(runId, 40)} (runs are kept 7 days)`);
  // D93: the run's own checkout, as an offer compiles it (an older sheet: the folder it is shown in, when that is it).
  const place = repoPlace(x.cwd(), x.env);
  const root = runCheckout(sheet, x.env, place.git && place.key === sheet.repoKey ? place.checkout : '');
  const scope = { repoKeys: [sheet.repoKey], checkout: root, env: x.env };
  const opts = {
    repoRoot: root, home: x.env.HOME || homedir(), platform: process.platform,
    prior: findPriorSheet(sheet, x.env), applies: sheet.repoKey, now: x.now(), readSheet: (id: string) => readRunSheet(id, x.env),
    taken: (n: string) => nameTaken(n, scope) !== null,
    learnings: stepLearnings({ repoKeys: [sheet.repoKey], checkout: root, env: x.env }),
  };
  // An offer keeps a repeated job; a run with no check (an asked save) is shown the way an ask keeps it.
  let c = compileRun(sheet, { ...opts, moment: 'repeated' });
  if (!c.ok && (c.reason === 'no-check' || c.reason === 'trivial')) c = compileRun(sheet, { ...opts, moment: 'asked' });
  if (!c.ok) return fail(x, `✗ Trail can't keep that run as a skill: ${refusalWords(c.reason, c.detail)}`);
  x.out(draftText(c.skill, sheet));
}

/**
 * 4.9 step 1 for the CLI: `add` takes a name and `--run` only. Commander gives an option a parent knows (`--json` of
 * `trail skills`, a root option) to that parent wherever it is typed, so add refuses any option a parent got from the
 * command line, the same way as an unknown one: an error, nothing saved.
 */
function onlyRun(cmd: Command): void {
  for (let c = cmd.parent; c; c = c.parent) {
    for (const o of c.options) {
      if (c.getOptionValueSource(o.attributeName()) === 'cli') cmd.error(`error: unknown option '${o.long ?? o.flags}'`, { exitCode: 1, code: 'commander.unknownOption' });
    }
  }
}

function add(x: Io, name: string, runId: string): void {
  const r = cliAdd(name, runId, x.env, x.now(), x.cwd());
  for (const l of r.lines) (r.exit === 0 ? x.out : x.err)(l);
  if (r.saved) x.track('skill_saved', { from: r.saved.from, scope: r.saved.scope });
  if (r.changed) x.track('skill_changed', { op: r.changed });
  if (r.exit !== 0) x.exit(r.exit);
}

function keep(x: Io, names: string[]): void {
  if (names.every((n) => /^\d+$/.test(n))) return fail(x, KEEP_NUMBERS_LINE);
  if (names.length !== 1) return fail(x, '✗ keep one skill at a time: trail skills keep <name>');
  const name = names[0]!;
  if (!personOr(x, `skills keep ${one(name)}`)) return;
  const r = keepHeld(name, x.person(), x.env, x.now());
  if (r.ok) {
    x.out(`✓ kept ${one(name)} as one of your skills · undo: trail forget ${one(name)}`);
    x.track('skill_saved', { from: 'asked', scope: 'personal' });
    return;
  }
  if (r.reason === 'not-a-person') return fail(x, personOnly(`skills keep ${one(name)}`));
  if (r.reason === 'name-taken') return fail(x, `✗ ${one(name)} is already the name of another skill, so this one can't be kept under it`);
  fail(x, `✗ nothing held called ${one(name)}: a held skill can be kept for 24 hours after Trail shows it · see what's held: trail skills`);
}

function restore(x: Io, name: string): void {
  const r = restoreSkill(name, x.env, x.now());
  if (r.ok) return x.out(`✓ ${one(name)} is back · forget it again: trail forget ${one(name)}`);
  if (r.reason === 'name-taken') return fail(x, `✗ the name ${one(name)} is taken now, so the forgotten one can't come back under it`);
  fail(x, `✗ no forgotten skill called ${one(name)}`);
}

function offers(x: Io, state: 'on' | 'off', here: boolean): void {
  let key: string | null = null;
  if (here) {
    const place = repoPlace(x.cwd(), x.env);
    if (!place.git) return fail(x, '✗ --here needs a repo: run it inside the repo');
    key = place.key;
  }
  const flag = here ? ' --here' : '';
  const where = key ? ` in ${one(repoName(key))}` : '';
  if (state === 'on') {
    if (!personOr(x, `skills offers on${flag}`)) return;
    setOffers(true, key, x.env, x.now());
    return x.out(`✓ skill offers on${where} · stop them: trail skills offers off${flag}`);
  }
  setOffers(false, key, x.env, x.now());
  x.out(key ? `Skill offers are off${where}. Turn them back on: trail skills offers on --here` : OFFERS_OFF_LINE);
  x.track('skill_answer', { answer: 'off' });
}

function onOff(x: Io, state: 'on' | 'off', name: string | undefined): void {
  if (name === undefined) {
    if (state === 'on') {
      if (!personOr(x, 'skills on')) return;
      setSkills(true, x.env, x.now());
      for (const l of SKILLS_ON_LINES) x.out(l);
      return;
    }
    setSkills(false, x.env, x.now());
    return x.out('✓ skills off: Trail stops counting jobs, offering skills and bringing them back · turn on again: trail skills on');
  }
  if (state === 'on' && !personOr(x, `skills on ${one(name)}`)) return;
  if (!knownSkill(name, x.env)) return fail(x, unknownSkill(name));
  setSkillOff(name, state === 'off', x.env);
  x.out(state === 'off'
    ? `✓ ${one(name)} off: it stops reaching the agent · turn it back on: trail skills on ${one(name)}`
    : `✓ ${one(name)} on: it reaches the agent again · turn it off: trail skills off ${one(name)}`);
}

/** `trail skills …` and `trail forget <name>` (1.7). */
export function registerSkillCommands(program: Command, deps: SkillCliDeps = {}): void {
  const x = io(deps);
  // Phase 2: `restore --version <n>` reaches the restore, not the CLI's own --version (cli-skills-2.ts).
  let restoreAt: string | undefined;
  const lift = <F extends (argv?: readonly string[], o?: never) => unknown>(f: F) => ((argv?: readonly string[], o?: never) => {
    const l = liftRestoreVersion(argv ?? process.argv);
    restoreAt = l.version;
    return f.call(program, l.argv, o);
  }) as unknown as F;
  program.parse = lift(program.parse.bind(program) as never);
  program.parseAsync = lift(program.parseAsync.bind(program) as never);
  const skills = program
    .command('skills')
    .description("Your skills: the steps that worked, kept on this machine when you say so, brought back when you ask for the same job")
    .option('--json', 'the same facts as one JSON object')
    .action((opts: { json?: boolean }) => guarded(x, () => list(x, !!opts.json))());

  skills.command('show').description('Print a skill (or a held one) and its status').argument('<name>', 'the skill')
    .action((name: string) => guarded(x, () => show(x, name))());
  skills.command('draft').description("Print what keeping a run would save, or init's item n (init-<n>). Saves nothing").argument('<run-id>', 'the run, or init-<n>')
    .option('--print', 'print it (the only thing draft does)')
    .action((runId: string, opts: { print?: boolean }) => guarded(x, () => draft(x, runId, !!opts.print))());
  skills.command('add').description('Keep a run as a skill, after the person said yes or asked for it (what was typed decides; no flag does)')
    .argument('<name>', 'the skill name')
    .requiredOption('--run <run-id>', 'the run to keep', (v: string, prev?: string) => {
      if (prev !== undefined) throw new InvalidArgumentError('give --run once.');
      return v;
    })
    .action((name: string, opts: { run: string }, cmd: Command) => {
      onlyRun(cmd);
      guarded(x, () => add(x, name, opts.run))();
    });
  skills.command('lesson').description('Keep the learning Trail offered, after the person typed yes to it (what was typed decides; no flag does)')
    .argument('[skill]', 'the skill the learning rides with (none for one about an error)')
    .requiredOption('--offer <offer-id>', 'the offer the person said yes to', (v: string, prev?: string) => {
      if (prev !== undefined) throw new InvalidArgumentError('give --offer once.');
      return v;
    })
    .action((skill: string | undefined, opts: { offer: string }, cmd: Command) => {
      onlyRun(cmd);
      guarded(x, () => said(x, lessonCommand(skill ?? null, opts.offer, x.env, x.now())))();
    });
  skills.command('keep').description("Keep a skill Trail held because nobody said yes. Only you, in your own terminal").argument('<name...>', 'the held skill')
    .action((names: string[]) => guarded(x, () => keep(x, names))());
  skills.command('forget').description('Forget a skill (trail skills restore brings it back), or a learning by its id or name').argument('<name>', 'the skill, or the learning id or name')
    .action((name: string) => guarded(x, () => forget(x, name))());
  skills.command('restore').description('Bring back the skill you forgot last, or with --version <n> an older version of a skill (only you, in your own terminal)')
    .argument('<name>', 'the skill')
    .action((name: string) => guarded(x, () => {
      if (restoreAt === undefined) return restore(x, name);
      const code = restoreVersionCommand(name, restoreAt, x);
      if (code !== 0) x.exit(code);
    })());
  skills.command('update').description('Change a skill the way Trail showed, after the person typed yes to it (what was typed decides; no flag does)')
    .argument('<name>', 'the skill')
    .requiredOption('--offer <offer-id>', 'the offer the person said yes to', (v: string, prev?: string) => {
      if (prev !== undefined) throw new InvalidArgumentError('give --offer once.');
      return v;
    })
    .action((name: string, opts: { offer: string }, cmd: Command) => {
      onlyRun(cmd);
      guarded(x, () => {
        const code = updateCommand(name, opts, x);
        if (code !== 0) x.exit(code);
      })();
    });
  skills.command('offers').description('Turn skill offers on or off, everywhere or in this repo (--here). Only you turn them on')
    .addArgument(new Argument('<state>', 'on or off').choices(['on', 'off'])).option('--here', 'just this repo')
    .action((state: 'on' | 'off', opts: { here?: boolean }) => guarded(x, () => offers(x, state, !!opts.here))());
  skills.command('on').description('Turn skills on (only you), or one skill back on').argument('[name]', 'one skill')
    .action((name: string | undefined) => guarded(x, () => onOff(x, 'on', name))());
  skills.command('off').description('Turn skills off, or one skill').argument('[name]', 'one skill')
    .action((name: string | undefined) => guarded(x, () => onOff(x, 'off', name))());

  program.command('forget', { hidden: true }).description('Forget one of your skills (trail skills restore brings it back), or a learning by its id or name').argument('<name>', 'the skill, or the learning id or name')
    .action((name: string) => guarded(x, () => forget(x, name))());
}
