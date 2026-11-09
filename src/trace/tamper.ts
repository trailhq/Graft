/**
 * The tamper check (design 4.1): the first call that writes Trail's files or
 * the host's transcripts marks the session, and it can never save a skill.
 *
 * What counts is a write, not a mention. On this machine's real sessions a
 * rule that fired on any Bash call naming `~/.trail` or `.claude/projects/`
 * marked about a quarter of them: heredocs that only quoted the path,
 * scripts that read transcripts, and Claude Code writing its own memory files
 * under `.claude/projects/<p>/memory/`. So a Bash call tampers when:
 *
 * - a redirect (`>`, `>>`, `>|`, `&>`) targets a protected path;
 * - a program that writes its arguments (tee, cp, mv, rm, touch, sed -i, ...)
 *   or an output file (`--output`, `curl -o`) is given one, after following the call's `cd`s from the folder its shell
 *   was already in;
 * - an interpreter's own code (a heredoc body, `-c`, `-e`) passes one to a
 *   call that writes: as a literal, through a variable set to one, or as a
 *   home folder joined with `.trail`;
 * - it runs Trail's hook script by hand.
 *
 * Protected: the Trail home, the session's transcript, and everything under
 * `~/.claude/projects/` except a project's `memory/` folder. A script that
 * builds the path some other way gets through; the check raises the bar, it
 * does not close it (0 rule 13).
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EDIT_TOOLS, effectiveFolder, INTERPRETERS } from './run-calls.js';
import { gitWriteTargets } from './tamper-git.js';
import { base, OPEN_KW, scan, unquote, words } from './shell-scan.js';
import { codeWrites, programCode, SHELLS } from './tamper-code.js';
import { bareCommand, onlyTrail, programOf, simpleCommands } from './shell.js';
import { agentGuard } from '../skills/risk.js';

export interface TamperCtx {
  trailHome: string;
  transcriptPath: string;
  home?: string;
  /** The folder the agent's shell was in when the call started (the transcript entry's `cwd`). */
  folder?: string | null;
}

const HOOK_SCRIPT = /(?:trail|graft)-hooks\.cjs\b/;
/** Every form the PreToolUse agent guard reads as Trail's hook scripts run by hand (globs, helpers paths, the package's hook modules). */
const ranHookScript = (raw: string) => agentGuard(raw)?.hit === 'hook-script';

interface Place { trail: string; projects: string; transcript: string | null }
/** The protected places as written, and again with every symlink on the way resolved. */
interface Zones { as: Place; real: Place; home: string }

/** Windows paths ignore case: C:\Users\dev\.trail and c:\users\dev\.trail are one folder. */
const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const under = (p: string, dir: string) => { const a = fold(p), b = fold(dir); return a === b || a.startsWith(b + sep); };

/** `p` with its deepest existing folder resolved through symlinks: where a write to `p` really lands. */
function realOf(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch { /* not there (yet): its folder */ }
    const up = dirname(cur);
    if (up === cur) break;
    rest.push(basename(cur));
    cur = up;
  }
  return p;
}

const ZONES = new Map<string, Zones>();

function zonesOf(ctx: TamperCtx): Zones {
  const home = ctx.home ?? homedir();
  const memo = `${ctx.trailHome}\0${ctx.transcriptPath}\0${home}`;
  let z = ZONES.get(memo);
  if (!z) {
    const as: Place = { trail: resolve(ctx.trailHome), projects: resolve(home, '.claude', 'projects'), transcript: ctx.transcriptPath ? resolve(ctx.transcriptPath) : null };
    const real: Place = { trail: realOf(as.trail), projects: realOf(as.projects), transcript: as.transcript === null ? null : realOf(as.transcript) };
    z = { as, real, home };
    if (ZONES.size > 32) ZONES.clear();
    ZONES.set(memo, z);
  }
  return z;
}

function guardedIn(p: string, z: Place, wipe: boolean): boolean {
  if (under(p, z.trail) || (z.transcript !== null && fold(p) === fold(z.transcript))) return true;
  if (wipe && (under(z.trail, p) || under(z.projects, p))) return true;
  if (!under(p, z.projects)) return false;
  return relative(z.projects, p).split(sep)[1] !== 'memory';
}

/** A path Trail's record depends on, as written or through a symlink. `wipe`: also a folder that holds one (rm, mv). */
function guarded(p: string, z: Zones, wipe = false): boolean {
  return guardedIn(p, z.as, wipe) || guardedIn(realOf(p), z.real, wipe);
}

/** Shell variables this command set before a word uses them (`D=~/.trail; echo x > $D/f`). */
type Vars = Map<string, string>;

/** A word with quotes gone and `~`, `$HOME`, `$TRAIL_HOME` and the command's own variables expanded. */
function expand(word: string, z: Zones, vars?: Vars): string {
  let w = word.replace(/['"]/g, '');
  if (vars?.size) w = w.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, n: string) => vars.get(n) ?? m);
  return w.replace(/^~(?=\/|$)/, z.home)
    .replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, z.home)
    .replace(/^\$(?:TRAIL_HOME|\{TRAIL_HOME\})(?=\/|$)/, z.as.trail);
}

/**
 * A shell word or string literal as an absolute path; null for a variable the command did not set. A folder named
 * before such a variable is still a place (g5 review): `~/.trail/sessions/$SID.json` is a file in that folder.
 */
function pathOf(word: string, folder: string | null, z: Zones, vars?: Vars): string | null {
  let w = expand(word, z, vars);
  const dyn = w.search(/[$`]/);
  if (dyn >= 0) {
    const dir = w.slice(0, w.lastIndexOf('/', dyn) + 1);
    if (!dir) return null;
    w = `${dir}$`;
  }
  if (!w) return null;
  if (isAbsolute(w)) return resolve(w);
  return folder ? resolve(folder, w) : null;
}

const DECLARE = /^(?:export|declare|local|readonly|typeset)$/;

/** Records `NAME=value` words of a simple command that only assigns (or exports) them. */
function noteAssignments(simple: string, z: Zones, vars: Vars): boolean {
  const all = words(simple);
  const list = DECLARE.test(all[0] ?? '') ? all.slice(1).filter((x) => !x.startsWith('-')) : all;
  if (!list.length || !list.every((x) => /^[A-Za-z_]\w*=/.test(x))) return false;
  for (const x of list) {
    const eq = x.indexOf('=');
    vars.set(x.slice(0, eq), expand(x.slice(eq + 1), z, vars));
  }
  return true;
}

/* -------------------------------------------------------------------- shell */

/** Programs that write the paths they are given: which arguments. */
const WRITERS: Record<string, 'all' | 'last'> = {
  tee: 'all', rm: 'all', rmdir: 'all', unlink: 'all', shred: 'all', truncate: 'all', touch: 'all', mkdir: 'all', chmod: 'all', chown: 'all',
  // A link to a protected file is a way to write it under another name.
  mv: 'all', ln: 'all', cp: 'last', install: 'last', rsync: 'last',
};
const OP_WORD = /^(?:\d+|&)?(?:>>?|>\||<<?<?|<>)$/;
const OUT_REDIRECT = /^(?:\d+|&)?(?:>>?|>\|)(.*)$/s;
const INLINE_REDIRECT = /^[^'"$`(<>]+?(?:\d|&)?(?:>>?|>\|)(.+)$/s;

/** Redirect targets of one simple command (`2>&1` and `>(...)` are not files). */
function redirectTargets(w: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const m = OUT_REDIRECT.exec(w[i]!) ?? INLINE_REDIRECT.exec(w[i]!);
    if (!m) continue;
    const target = m[1] || w[++i] || '';
    if (target && !/^[&(]/.test(target)) out.push(target);
  }
  return out;
}

/** Programs whose short flag names the file they write: `curl -o f`, `sort -o f`, `wget -O f`, `tree -o f`. */
const OUT_FLAG: Record<string, string> = { curl: '-o', sort: '-o', tree: '-o', wget: '-O' };

/** Files named by `--output f`, `--output=f`, or the program's own output flag. */
function outputFiles(prog: string, w: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a.startsWith('--output=')) out.push(a.slice(9));
    else if ((a === '--output' || a === OUT_FLAG[prog]) && w[i + 1] !== undefined) out.push(w[++i]!);
  }
  return out;
}

/** Arguments that are not flags or redirects. */
function positional(w: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const a = w[i]!;
    if (OP_WORD.test(a)) { i++; continue; }
    if (/^(?:\d*[<>]|&>)/.test(a) || (a.startsWith('-') && a !== '-')) continue;
    out.push(a);
  }
  return out;
}

/** The words of a simple command with env prefixes, wrappers, `sudo` and `env A=B` gone. */
function programWordsOf(simple: string): string[] {
  let w = words(bareCommand(simple));
  while (w[0] === 'sudo' || w[0] === 'env') {
    w = w.slice(1);
    while (w.length && (/^[A-Za-z_]\w*=/.test(w[0]!) || w[0]!.startsWith('-'))) w = w.slice(1);
  }
  return w;
}

/** The folder a `tar` extracts into or the archive it creates, when it does either. */
function tarTargets(w: string[]): string[] {
  const out: string[] = [];
  const bundle = w[1] && !w[1].startsWith('-') ? w[1] : '';
  const short = w.filter((a) => /^-[A-Za-z]+$/.test(a)).join('') + bundle;
  const extract = /x/.test(short) || w.includes('--extract') || w.includes('--get');
  const create = /[cru]/.test(short) || w.includes('--create') || w.includes('--append') || w.includes('--update');
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (extract && (a === '-C' || a === '--directory') && w[i + 1]) out.push(w[i + 1]!);
    if (extract && a.startsWith('--directory=')) out.push(a.slice(12));
    if (create && (a === '-f' || a === '--file' || (/^-[A-Za-z]*f$/.test(a))) && w[i + 1]) out.push(w[i + 1]!);
    if (create && a.startsWith('--file=')) out.push(a.slice(7));
  }
  if (create && bundle.endsWith('f') && w[2]) out.push(w[2]);
  return out;
}

/* --------------------------------------------------------------------- git */

/** D59e: git writing in a protected folder (its `-C` chain, `--git-dir`, `--work-tree`, or a clone's or init's target). */
function gitWrites(w: string[], folder: string | null, z: Zones, vars?: Vars): boolean {
  return gitWriteTargets(w, folder, (word, from) => pathOf(word, from, z, vars)).some((d) => d !== null && guarded(d, z));
}

/* ------------------------------------------------------------------- xargs */

/** xargs options that take the next word (GNU and BSD). */
const XARGS_VALUE = /^(?:-[nPLdEsaSR]|--(?:max-args|max-procs|max-lines|delimiter|eof|max-chars|arg-file))$/;

/**
 * What xargs feeds the program: a path under the first protected path an earlier stage of the pipeline names
 * (`find ~/.trail/runs ... |`), else under the first absolute one, else a name in the shell's folder (`ls |`).
 */
function xargsInput(pipeIn: string[][], folder: string | null, z: Zones, vars?: Vars): string {
  let first: string | null = null;
  for (const w of pipeIn) {
    for (const a of positional(w.slice(1))) {
      const p = pathOf(a, folder, z, vars);
      if (p === null) continue;
      if (guarded(p, z)) return join(p, 'f');
      if (first === null && isAbsolute(expand(a, z, vars))) first = p;
    }
  }
  return join(first ?? folder ?? '', 'f');
}

/** D59e: `… | xargs [-I R] <writer> …` handing the listed paths (or a protected one of its own) to a program that writes. */
function xargsWrites(w: string[], pipeIn: string[][], folder: string | null, z: Zones, vars?: Vars): boolean {
  let rep: string | null = null;
  let i = 1;
  for (; i < w.length; i++) {
    const a = w[i]!;
    if (a === '--') { i++; break; }
    if (!a.startsWith('-')) break;
    if (a === '-I' || a === '-J' || a === '--replace') rep = w[++i] ?? null;
    else if (/^-[IJ]./.test(a)) rep = a.slice(2);
    else if (a.startsWith('--replace=')) rep = a.slice(10);
    else if (/^-i/.test(a)) rep = a.slice(2) || '{}';
    else if (XARGS_VALUE.test(a)) i++;
  }
  const cmd = w.slice(i).map((a) => unquote(a));
  if (!cmd.length) return false;
  const input = xargsInput(pipeIn, folder, z, vars);
  const r = rep ? unquote(rep) : null;
  const argv = r ? cmd.map((a) => (a === r ? input : a.includes(r) ? a.split(r).join('f') : a)) : [...cmd, input];
  return simpleWrites(argv, folder, z, vars);
}

/** Whether one simple command's redirects or written arguments are protected. */
function simpleWrites(w: string[], folder: string | null, z: Zones, vars?: Vars): boolean {
  const hit = (word: string, wipe = false) => {
    const p = pathOf(word, folder, z, vars);
    return p !== null && guarded(p, z, wipe);
  };
  const prog = base(w[0] ?? '');
  if (redirectTargets(w).some((t) => hit(t)) || outputFiles(prog, w).some((t) => hit(t))) return true;
  if (prog === 'git') return gitWrites(w, folder, z, vars);
  const args = positional(w.slice(1));
  const which = WRITERS[prog];
  if (which === 'all') return args.some((a) => hit(a, prog === 'rm' || prog === 'mv'));
  if (which === 'last') return args.length > 1 && hit(args[args.length - 1]!);
  if ((prog === 'sed' || prog === 'perl') && w.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return args.some((a) => hit(a));
  if ((prog === 'awk' || prog === 'gawk') && w.some((a, i) => (a === '-i' && w[i + 1] === 'inplace') || a === '--include=inplace')) return args.some((a) => hit(a));
  if (prog === 'dd') return w.some((a) => a.startsWith('of=') && hit(a.slice(3)));
  if (prog === 'tar') return tarTargets(w).some((t) => hit(t));
  if (prog === 'unzip') return w.some((a, i) => (a === '-d' && w[i + 1] !== undefined && hit(w[i + 1]!)) || (a.startsWith('-d') && a.length > 2 && hit(a.slice(2))));
  const execs = w.flatMap((a, i) => (a === '-exec' || a === '-execdir' ? [base(w[i + 1] ?? '')] : []));
  if (prog === 'find' && (w.includes('-delete') || execs.some((e) => e in WRITERS || e === 'sed' || e === 'perl'))) {
    const roots: string[] = [];
    for (const a of w.slice(1)) { if (/^[-(!]/.test(a)) break; roots.push(a); }
    return roots.some((a) => hit(a, true));
  }
  return false;
}

/* ---------------------------------------------------------------------- all */

/** A `cd` from `folder`; null when only the shell could know where it lands. */
function cdFrom(folder: string | null, simple: string, home: string): string | null {
  const next = effectiveFolder(folder ?? '/\0', simple, home);
  // No real path holds a NUL; on Windows resolve() puts a drive before the '/\0' this starts from.
  return next && !next.includes('\0') ? next : null;
}

/** Whether a Bash command writes a guarded path; `depth` bounds `bash -c` inside `bash -c`. */
function bashWrites(text: string, start: string | null, z: Zones, depth = 0, vars: Vars = new Map()): boolean {
  // `>|` (write even with noclobber) is a redirect, not a pipe.
  const raw = text.includes('>|') ? text.replace(/>\|/g, '> ') : text;
  let folder = start;
  let prev: string | null = null;
  const stack: Array<string | null> = [];
  const { segs } = scan(raw);
  // The earlier stages of the pipeline the current segment is in: what an `xargs` reads, and (as text: their words
  // unquoted and their heredoc bodies) what an interpreter or shell reading its stdin runs (g5 review).
  let pipeIn: string[][] = [];
  let piped: string[] = [];
  for (const p of segs) {
    if (p.group) {
      if (bashWrites(raw.slice(p.group.open + 1, p.group.close < 0 ? p.end : p.group.close), folder, z, depth, new Map(vars))) return true;
      pipeIn = [];
      piped = [];
      continue;
    }
    const head = raw.slice(p.start, p.end);
    const plain = !OPEN_KW.has(words(head)[0] ?? '');
    const stage: string[][] = [];
    simples: for (const [n, simple] of simpleCommands(head).entries()) {
      if (noteAssignments(simple, z, vars)) continue simples;
      const w = programWordsOf(simple);
      if (w[0] === 'cd' || w[0] === 'pushd' || w[0] === 'popd') {
        const to = w[0] === 'popd' ? (stack.length ? stack.pop()! : null)
          : w[1] === '-' ? prev
          : cdFrom(folder, `cd ${w.slice(1).filter((a) => !/^-[LPe@]+$/.test(a)).map((a) => expand(a, z, vars)).join(' ')}`, z.home);
        if (w[0] === 'pushd') stack.push(folder);
        prev = folder;
        folder = to;
        continue simples;
      }
      if (simpleWrites(w, folder, z, vars)) return true;
      const prog = base(w[0] ?? '');
      if (prog === 'xargs' && xargsWrites(w, pipeIn, folder, z, vars)) return true;
      stage.push(w);
      const shell = SHELLS.test(prog);
      if (!shell && !INTERPRETERS.test(prog)) continue;
      const code = programCode(prog, w, plain && n === 0 ? p.bodies.map(([a, b]) => raw.slice(a, b)) : [], n === 0 && piped.length ? piped.join('\n') : null);
      const literal = (v: string) => {
        const at = pathOf(v, folder, z);
        return at !== null && guarded(at, z);
      };
      if (code !== null && (shell ? depth < 2 && bashWrites(code, folder, z, depth + 1, new Map(vars)) : codeWrites(code, literal))) return true;
    }
    const fed = [...stage.map((w) => w.slice(1).map((a) => unquote(a)).join(' ')), ...p.bodies.map(([a, b]) => raw.slice(a, b))];
    piped = p.sep === '|' ? [...piped, ...fed] : [];
    pipeIn = p.sep === '|' ? [...pipeIn, ...stage] : [];
  }
  return false;
}

/** A mark `tamperOf` gives for Trail's hook script run by hand, not a write (D93: the refusal says so). */
export const isHookScriptTamper = (what: string): boolean => /^Bash (?:(?:trail|graft)-hooks\.cjs|a Trail hook script)$/.test(String(what ?? ''));

/** The first rule a call breaks, as '<tool> <path or program>'; null when none. */
export function tamperOf(name: string, input: unknown, raw: string | null, ctx: TamperCtx): string | null {
  const z = zonesOf(ctx);
  if (EDIT_TOOLS.has(name)) {
    const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const fp = typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : '';
    if (!fp) return null;
    const p = resolve(fp.replace(/^~(?=\/|$)/, z.home));
    return guarded(p, z) ? `${name} ${p}` : null;
  }
  // Codex's write_stdin (review): the keys fed to a running shell are a command line like any other.
  if (name === 'write_stdin') {
    const keys = input && typeof input === 'object' && typeof (input as { chars?: unknown }).chars === 'string' ? (input as { chars: string }).chars : '';
    if (!keys.trim()) return null;
    if (ranHookScript(keys)) return 'Bash a Trail hook script';
    return bashWrites(keys, ctx.folder ?? null, z) ? `Bash ${programOf(keys) ?? 'shell'}` : null;
  }
  if (name !== 'Bash' || raw === null) return null;
  // D116 item 2: running it by hand marks the session; reading it does not.
  if (ranHookScript(raw)) return HOOK_SCRIPT.test(raw) ? `Bash ${HOOK_SCRIPT.exec(raw)![0]}` : 'Bash a Trail hook script';
  if (onlyTrail(raw)) return null;
  return bashWrites(raw, ctx.folder ?? null, z) ? `Bash ${programOf(raw) ?? 'shell'}` : null;
}
