/**
 * What a learning says about the commands a skill runs, read without a model:
 * the tool and command preferences a person writes ("use pnpm, not npm",
 * "never run npx prisma db push", "always run make lint before git push",
 * "don't edit _schema.py by hand, run scripts/gen_schema.py"), matched
 * against a step's program and arguments.
 *
 * Precision over recall. A clause counts only when it has one of a few fixed
 * shapes and each command in it is a command for sure: in backticks, or
 * starting with a program Trail knows or a script path, with nothing but
 * arguments after it ("always run the tests" names no command, so it says
 * nothing). Whatever doesn't parse says nothing.
 *
 * Out: repeats (the learning says what a step does) and contradicts (a step
 * does what the learning forbids, or uses the tool it replaces), with the
 * step's command the learning's way when Trail can write it safely (a swap
 * between npm, pnpm, yarn and bun it knows, or a whole command for a whole
 * command), else null. Pure: no disk, no clock.
 */
import { bareCommand, simpleCommands } from '../trace/shell.js';

export interface Cmd { prog: string; args: string[] }
export type StepRule =
  | { t: 'swap'; use: Cmd; not: Cmd }
  | { t: 'never'; cmd: Cmd }
  | { t: 'never-edit'; file: string }
  | { t: 'always'; cmd: Cmd }
  | { t: 'before'; first: Cmd; then: Cmd };

/** `whole`: every sentence of the text read as rules, so a line that quotes it in full leaves nothing out. */
export interface ReadRules { rules: StepRule[]; whole: boolean }

export interface StepVerdict {
  repeats: number[];
  /** `fix`: the step's command the learning's way (its folder kept), or null when Trail can't write it safely. */
  contradicts: Array<{ step: number; fix: string | null }>;
}

/** Programs a command phrase may start with when it is not in backticks. */
const KNOWN = new Set(`npm npx pnpm pnpx yarn bun bunx deno node tsx ts-node python python3 pip pip3 pipx uv poetry pytest tox nox make cmake
cargo rustc go gradle gradlew mvn ant git gh docker podman kubectl helm terraform tofu ansible rg grep sed awk jq curl wget brew ruby bundle
rake rails gem php composer dotnet swift xcodebuild jest vitest mocha playwright tsc eslint prettier biome ruff black flake8 mypy pylint isort
pre-commit nx turbo lerna vite webpack next prisma alembic flask uvicorn gunicorn psql mysql sqlite3 aws gcloud az vercel netlify fly flyctl
heroku firebase wrangler supabase just task`.split(/\s+/));
/** Words that end a command phrase: English, never an argument. */
const STOP = new Set(`a an the to for when before after instead rather than not over by hand it them this that here there in on with so
because if unless first always never every time please then and or anymore again locally directly manually yourself any my your our their
of is are be was were tests test-suite suite`.split(/\s+/));
const SCRIPT = /^(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+$|^[\w-][\w.-]*\.(?:py|sh|bash|js|mjs|cjs|ts|rb|pl)$/;
const FILE = /^(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]{1,8}$|^(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+$/;
const ARG = /^[\w@./:=+,%{}-]+$/;
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'ruby', 'perl', 'tsx', 'ts-node']);
const EDITORS = new Set(['vim', 'vi', 'nvim', 'nano', 'emacs', 'code', 'ed']);
const PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const MAX_SENTENCE = 240;
const MAX_TEXT = 2000;

const BT = '\u0001';
const P = '(.+?)';
const RUN = String.raw`(?:use|run|call)`;
const NOT = String.raw`(?:don'?t|do not|never|avoid)`;
const EDIT = String.raw`(?:hand[- ]?edit|edit|modify|change|touch|write to)`;
const BY_HAND = String.raw`(?:\s+(?:by hand|manually|directly|yourself))?`;
const TAIL = String.raw`(?:\s+(?:here|in this repo|anymore|any more|again|instead|first|always|every time))*`;
const re = (s: string) => new RegExp(`^${s}$`, 'i');

/** One phrase as a command, or null when any word of it isn't one. Backticked text (`\u0001n\u0001`) is the person's own command. */
function cmdOf(phrase: string, ticks: string[]): Cmd | null {
  const p = phrase.trim().replace(/^["']|["']$/g, '').trim();
  const tick = new RegExp(`^${BT}(\\d+)${BT}$`).exec(p);
  const words = (tick ? ticks[Number(tick[1])] ?? '' : p).trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return null;
  const [prog, ...args] = words;
  const known = KNOWN.has(prog!) || SCRIPT.test(prog!);
  if (!(tick ? ARG.test(prog!) : known)) return null;
  if (!args.every((a) => ARG.test(a) && (tick || !STOP.has(a.toLowerCase())))) return null;
  return { prog: plainPath(prog!), args };
}

function fileOf(phrase: string, ticks: string[]): string | null {
  const p = phrase.trim().replace(/^["']|["']$/g, '').trim();
  const tick = new RegExp(`^${BT}(\\d+)${BT}$`).exec(p);
  const f = (tick ? ticks[Number(tick[1])] ?? '' : p).trim();
  return FILE.test(f) ? plainPath(f) : null;
}

const plainPath = (p: string) => p.replace(/^\.\//, '');

type Shape = { re: RegExp; make: (m: RegExpExecArray, t: string[]) => StepRule[] | null };
const both = <T>(a: T | null, b: T | null): [T, T] | null => (a && b ? [a, b] : null);

/** Shapes a whole sentence can have (the ones with a comma of their own come first). */
const SENTENCE: Shape[] = [
  // "use pnpm, not npm", "run make test instead of pytest", "prefer rg over grep"
  { re: re(String.raw`(?:always\s+)?(?:use|run|prefer)\s+${P}\s*,?\s+(?:not|never|and not|instead of|rather than|over)\s+(?:using\s+|running\s+)?${P}${TAIL}`),
    make: (m, t) => {
      const f = /^(?:hand[- ]?)?(?:editing|changing|modifying|touching)\s+(.+?)(?:\s+(?:by hand|manually|directly))?$/i.exec(m[2]!);
      if (f) {
        const c = cmdOf(m[1]!, t);
        const file = fileOf(f[1]!, t);
        return c && file ? [{ t: 'always', cmd: c }, { t: 'never-edit', file }] : null;
      }
      const p = both(cmdOf(m[1]!, t), cmdOf(m[2]!, t));
      return p ? [{ t: 'swap', use: p[0], not: p[1] }] : null;
    } },
  { re: re(String.raw`prefer\s+${P}\s+to\s+${P}`), make: (m, t) => {
    const p = both(cmdOf(m[1]!, t), cmdOf(m[2]!, t));
    return p ? [{ t: 'swap', use: p[0], not: p[1] }] : null;
  } },
  // "don't use npm, use pnpm"
  { re: re(String.raw`${NOT}\s+(?:use|run)\s+${P}\s*[,;:]?\s+(?:but\s+)?(?:use|run)\s+${P}${TAIL}`), make: (m, t) => {
    const p = both(cmdOf(m[2]!, t), cmdOf(m[1]!, t));
    return p ? [{ t: 'swap', use: p[0], not: p[1] }] : null;
  } },
  // "don't edit _schema.py by hand, run scripts/gen_schema.py"
  { re: re(String.raw`${NOT}\s+${EDIT}\s+${P}${BY_HAND}\s*[,;:]?\s+(?:but\s+|instead\s+)*${RUN}\s+${P}${TAIL}`), make: (m, t) => {
    const file = fileOf(m[1]!, t);
    const c = cmdOf(m[2]!, t);
    return file && c ? [{ t: 'never-edit', file }, { t: 'always', cmd: c }] : null;
  } },
  // "always run make lint before git push", "run lint before pushing"
  { re: re(String.raw`(?:always\s+)?run\s+${P}\s+(?:before|ahead of|prior to)\s+(?:you\s+)?(?:run\s+|running\s+)?${P}`), make: (m, t) => {
    const p = both(cmdOf(m[1]!, t), cmdOf(m[2]!, t));
    return p ? [{ t: 'before', first: p[0], then: p[1] }] : null;
  } },
  // "before git push, always run make lint"
  { re: re(String.raw`before\s+(?:you\s+)?(?:run\s+|running\s+)?${P}\s*,?\s+(?:always\s+)?run\s+${P}(?:\s+first)?`), make: (m, t) => {
    const p = both(cmdOf(m[2]!, t), cmdOf(m[1]!, t));
    return p ? [{ t: 'before', first: p[0], then: p[1] }] : null;
  } },
];

/** Shapes one clause can have once a sentence is cut at its commas. */
const CLAUSE: Shape[] = [
  { re: re(String.raw`${NOT}\s+(?:ever\s+)?(?:use|run|using|running|call)\s+${P}${TAIL}`), make: (m, t) => {
    const c = cmdOf(m[1]!, t);
    return c ? [{ t: 'never', cmd: c }] : null;
  } },
  { re: re(String.raw`${NOT}\s+${EDIT}\s+${P}${BY_HAND}`), make: (m, t) => {
    const file = fileOf(m[1]!, t);
    return file ? [{ t: 'never-edit', file }] : null;
  } },
  { re: re(String.raw`(?:always\s+)?${RUN}\s+${P}${TAIL}`), make: (m, t) => {
    const c = cmdOf(m[1]!, t);
    return c ? [{ t: 'always', cmd: c }] : null;
  } },
];

function shaped(s: string, shapes: Shape[], ticks: string[]): StepRule[] | null {
  for (const sh of shapes) {
    const m = sh.re.exec(s);
    if (!m) continue;
    const r = sh.make(m, ticks);
    if (r) return r;
  }
  return null;
}

/** The rules a learning's text says, and whether every sentence of it was read. */
export function rulesOf(text: string): ReadRules {
  const ticks: string[] = [];
  const raw = String(text ?? '').slice(0, MAX_TEXT).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/`([^`\n]{1,200})`/g, (_, c: string) => `${BT}${ticks.push(c) - 1}${BT}`);
  const sentences = raw.split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.replace(/^\s*(?:[-*·]|\d+[.)])\s+/, '').replace(/^please,?\s+/, '').replace(/[\s.!;:]+$/, '').trim()).filter(Boolean);
  const rules: StepRule[] = [];
  let whole = sentences.length > 0;
  for (const s of sentences) {
    if (s.length > MAX_SENTENCE) { whole = false; continue; }
    const one = shaped(s, SENTENCE, ticks);
    if (one) { rules.push(...one); continue; }
    const parts = s.split(/\s*,\s*|\s+and then\s+|\s+then\s+/).filter(Boolean);
    const read = parts.map((c) => shaped(c, CLAUSE, ticks));
    if (read.some((r) => r === null)) whole = false;
    for (const r of read) if (r) rules.push(...r);
  }
  return { rules, whole: whole && rules.length > 0 };
}

/* ----------------------------------------------------------- the steps */

interface Simple { prog: string; args: string[]; text: string }

/** A step's folder (`(cd api && ...)`) and the rest. */
function inFolder(cmd: string): { dir: string | null; core: string } {
  const m = /^\(cd (\S+) && (.*)\)$/.exec(cmd.trim());
  return m ? { dir: m[1]!, core: m[2]! } : { dir: null, core: cmd.trim() };
}

function simplesOf(cmd: string): Simple[] {
  return simpleCommands(inFolder(cmd).core).flatMap((text) => {
    const words = bareCommand(text).split(/\s+/).filter(Boolean).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));
    if (!words.length || words[0] === 'cd') return [];
    const [prog, ...args] = words;
    const out: Simple[] = [{ prog: plainPath(prog!), args, text }];
    // `python scripts/gen.py` is also the script run on its own.
    const at = args.findIndex((a) => !a.startsWith('-'));
    if (INTERPRETERS.has(prog!) && at >= 0 && SCRIPT.test(args[at]!)) out.push({ prog: plainPath(args[at]!), args: args.slice(at + 1), text });
    return out;
  });
}

const samePath = (a: string, b: string) => a === b || (b.includes('/') && b.endsWith(`/${a}`)) || (a.includes('/') && a.endsWith(`/${b}`));
const positional = (args: string[]) => args.filter((a) => !a.startsWith('-'));
const flags = (args: string[]) => args.filter((a) => a.startsWith('-'));

/** The simple command runs `c`: the same program, `c`'s arguments first in the same order, and every flag `c` names. */
function runs(s: Simple, c: Cmd): boolean {
  if (!(s.prog === c.prog || ((SCRIPT.test(s.prog) || SCRIPT.test(c.prog)) && samePath(s.prog, c.prog)))) return false;
  const want = positional(c.args);
  const have = positional(s.args);
  return want.every((w, i) => have[i] === w) && flags(c.args).every((f) => s.args.includes(f));
}

/** The simple command writes `file`: an in-place edit, an editor, a copy or move onto it, or a redirect into it. */
function edits(s: Simple, file: string): boolean {
  const hits = (a: string) => samePath(plainPath(a), file);
  if ((s.prog === 'sed' || s.prog === 'perl') && s.args.some((a) => /^-[a-zA-Z]*i/.test(a))) return s.args.some(hits);
  if (EDITORS.has(s.prog)) return s.args.some(hits);
  if (['cp', 'mv', 'install', 'tee'].includes(s.prog)) return s.args.length > 0 && hits(s.args[s.args.length - 1]!);
  return [...s.text.matchAll(/(?:^|[^<>&\d])\d?>>?\|?\s*([^\s&|;<>]+)/g)].some((m) => hits(m[1]!));
}

const anyRuns = (cmd: string, c: Cmd) => simplesOf(cmd).some((s) => runs(s, c));

/** `npm test` as pnpm, yarn or bun runs it; null for anything else (a flag, a sub-command Trail doesn't know the twin of). */
function pmTwin(args: string[], to: string): string[] | null {
  const [sub, ...rest] = args;
  // `bun test` is bun's own test runner, not the package's script: bun runs the script with `bun run test`.
  if ((sub === 'test' || sub === 'start') && rest.length === 0) return to === 'bun' ? ['run', sub] : [sub];
  if (sub === 'run' && rest.length >= 1 && /^[\w:.-]+$/.test(rest[0]!) && rest.slice(1).every((a) => ARG.test(a))) return ['run', ...rest];
  if ((sub === 'install' || sub === 'i') && rest.length === 0) return ['install'];
  // yarn's flag for a locked install changed between versions: no twin.
  if (sub === 'ci' && rest.length === 0) return to === 'npm' ? ['ci'] : to === 'yarn' ? null : ['install', '--frozen-lockfile'];
  return null;
}

/** The step the swap's way, or null when Trail can't write it safely: one simple command, nothing piped or chained. */
function swapFix(cmd: string, use: Cmd, not: Cmd): string | null {
  const { dir, core } = inFolder(cmd);
  // Nothing piped, chained, redirected or substituted, and no env prefix or wrapper: the words are the whole command.
  if (simpleCommands(core).length !== 1 || /[<>`$|&;]/.test(core.replace(/\{\w+\}/g, ''))) return null;
  if (core.replace(/\s+/g, ' ').trim() !== bareCommand(core)) return null;
  const s = simplesOf(core)[0];
  if (!s) return null;
  let next: string[] | null = null;
  if (!use.args.length && !not.args.length && PMS.has(use.prog) && PMS.has(not.prog) && s.prog === not.prog) {
    const twin = pmTwin(s.args, use.prog);
    next = twin ? [use.prog, ...twin] : null;
  } else if (s.prog === not.prog && s.args.join(' ') === not.args.join(' ') && (use.args.length || not.args.length)) {
    next = [use.prog, ...use.args];
  }
  if (!next) return null;
  const text = next.join(' ');
  return dir ? `(cd ${dir} && ${text})` : text;
}

/**
 * Each rule against the steps (step `n` is `steps[n - 1]`, with its {params}). A step that does what a rule forbids
 * is a contradiction, whatever another rule says of it; one that does what a rule says, a repeat.
 */
export function matchSteps(rules: StepRule[], steps: string[]): StepVerdict {
  const repeats = new Set<number>();
  const against = new Map<number, string | null>();
  // Two rules that would write one step two ways write it neither way.
  const contradict = (n: number, fix: string | null) => {
    if (!against.has(n)) against.set(n, fix);
    else if (against.get(n) !== fix) against.set(n, null);
  };
  for (const r of rules) {
    steps.forEach((cmd, i) => {
      const n = i + 1;
      if (r.t === 'swap') {
        if (anyRuns(cmd, r.not)) contradict(n, swapFix(cmd, r.use, r.not));
        else if (anyRuns(cmd, r.use)) repeats.add(n);
      } else if (r.t === 'never') {
        if (anyRuns(cmd, r.cmd)) contradict(n, null);
      } else if (r.t === 'never-edit') {
        if (simplesOf(cmd).some((s) => edits(s, r.file))) contradict(n, null);
      } else if (r.t === 'always') {
        if (anyRuns(cmd, r.cmd)) repeats.add(n);
      } else if (anyRuns(cmd, r.then)) {
        const first = steps.findIndex((x, j) => j < i && anyRuns(x, r.first));
        if (first >= 0) repeats.add(first + 1);
        else if (!anyRuns(cmd, r.first)) contradict(n, null);
      }
    });
  }
  for (const n of against.keys()) repeats.delete(n);
  return { repeats: [...repeats].sort((a, b) => a - b), contradicts: [...against].sort((a, b) => a[0] - b[0]).map(([step, fix]) => ({ step, fix })) };
}
