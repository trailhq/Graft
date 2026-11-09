/**
 * "May be out of date" (design 1.3, 4.18, spec 13, J14b): what a skill's
 * steps lean on that can go away under it (a program, an npm script, a make
 * target, a helper file, a branch), and which of those are gone now.
 *
 * A gone anchor never changes the skill's status and is never charged: it
 * adds the block's first line and a word in the index. Checks are local file
 * reads only: a stat per PATH folder, package.json, the Makefile, the git
 * folder's ref files and `packed-refs` (through a worktree's `gitdir` and
 * `commondir`). No process, no network, no cache (R35): each check is under
 * 1 ms, so it runs when needed.
 *
 * Only what is sure is gone: a param, a variable, a substitution, a build
 * output or a path an earlier step makes is never an anchor; a package.json
 * that can't be read, a Makefile with `include` or a `%` rule, a file whose
 * folder is gone too, a remote this checkout never fetched, a program when
 * the hook has no PATH, or a repo with no git folder is never "gone".
 */
import { readdirSync, statSync } from 'node:fs';
import { branchGone, exists, gitOf, readSmall, type Git } from './anchors-git.js';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ParsedSkill } from './types.js';
import { flatLine } from '../notes/flatten.js';
import { leadingCds, simpleCommands } from '../trace/shell.js';
import { programWords } from '../trace/shell-words.js';
import { unquote } from '../trace/shell-scan.js';
import { FIXED_DIRS, pathDirs, programFiles } from '../trace/guard-fast.js';
import { wideGone, type WideKind } from './anchors-wide.js';

export type AnchorKind = 'program' | 'script' | 'make' | 'file' | 'branch' | WideKind;
export interface Anchor {
  kind: AnchorKind;
  name: string;
  step: number;
  /** branch: the remote the step names (a name, or the URL anchorsOf saw; goneAnchors gives back the remote's name). */
  remote?: string;
  /** script, make, file: the step's folder relative to the checkout, from its leading `cd` or `-C`. */
  dir?: string;
  /** branch: how the step uses it (words, 4.18). */
  via?: 'push' | 'push-from' | 'checkout' | 'merge';
  /** script: `yarn X`, `pnpm X`, `bun run X` also run a package's bin; gone only when node_modules/.bin lacks it too. */
  bin?: boolean;
  /** phase 2's wider kinds (anchors-wide.ts): the compose file for a service, the program for a subcommand. */
  where?: string;
}

/** J14b's words (4.18, R55). Information about the skill, never a line to say (D88). */
export const ANCHOR_COPY: Record<string, string> = {
  line: '{name} may be out of date: {what}. Check it before using it; the person can drop it with: trail forget {name}',
  more: ', and {k} more',
  push: 'it pushes to {x}, and {remote} has no {x} branch now',
  'push-from': 'it pushes from {x}, and {remote} has no {x} branch now',
  checkout: 'it checks out {x}, and there is no {x} branch here now',
  merge: 'it merges {remote}/{x}, and {remote} has no {x} branch now',
  script: 'it runs npm run {x}, and package.json has no {x} script now',
  make: 'it runs make {x}, and the Makefile has no {x} target now',
  file: 'it runs {x}, and that file is gone',
  program: "it runs {x}, and {x} isn't on PATH here",
  'ci-file': "it runs the {x} CI file, and this repo's GitHub Actions folder has no {x} now",
  service: 'it uses the {x} service, and {file} has no {x} now',
  subcommand: "it runs {prog} {x}, and this repo's {prog} has no {x} command now",
  index: '(may be out of date)',
};

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

/* ------------------------------------------------------------ finding */

/** Shell builtins and Trail itself: never a program anchor. */
const BUILTINS = new Set([
  'cd', 'export', 'source', '.', 'echo', 'printf', 'sleep', 'true', 'false', 'pwd', 'clear', 'set', 'unset', 'alias', 'wait', 'exit', 'return', ':',
  'trap', 'shopt', 'setopt', 'local', 'declare', 'typeset', 'readonly', 'test', '[', '[[', 'read', 'eval', 'exec', 'type', 'hash', 'ulimit', 'umask',
  'jobs', 'kill', 'let', 'shift', 'getopts', 'command', 'builtin', 'break', 'continue', 'trail', 'graft', 'trail-code',
  // More bash and zsh builtins, and the version managers that are shell functions: never on any PATH (review).
  'pushd', 'popd', 'dirs', 'print', 'whence', 'where', 'autoload', 'noglob', 'history', 'fc', 'disown', 'bg', 'fg', 'function', 'select',
  'coproc', 'caller', 'enable', 'mapfile', 'readarray', 'compgen', 'complete', 'bind', 'logout', 'suspend', 'times', 'bindkey', 'compdef',
  'emulate', 'rehash', 'unfunction', 'unhash', 'zle', 'zmodload', 'nvm', 'rvm', 'sdk',
]);
/** A step that runs one of these changes the PATH for what comes after it (a venv, a version manager, an env file). */
const PATH_SETTERS = new Set(['source', '.', 'eval', 'nvm', 'rvm', 'sdk', 'conda', 'pyenv', 'rbenv', 'nodenv', 'jenv', 'fnm', 'asdf', 'mise', 'direnv']);
/** `PATH=...` before a program, or as its own command. */
const PATH_ASSIGN = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*PATH\+?=/;
const INTERPRETERS = /^(?:node|python[\d.]*|bash|sh|zsh|dash|ruby|perl|deno|bun|tsx|ts-node|php|source|\.)$/;
/** Folders a build writes: a file there may not exist until a step makes it. */
const OUTPUTS = /^(?:\.\/)?(?:dist|build|out|target|\.next|node_modules|coverage|tmp)\//;
/** pnpm and yarn commands that are their own, not a script. */
const PM_OWN = new Set([
  'add', 'install', 'i', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'publish', 'pack', 'exec', 'dlx', 'x', 'init', 'link', 'unlink',
  'outdated', 'list', 'ls', 'why', 'audit', 'config', 'store', 'version', 'info', 'view', 'login', 'logout', 'whoami', 'create', 'import', 'rebuild',
  'prune', 'deploy', 'env', 'setup', 'patch', 'test', 'start', 'run', 'cache', 'workspace', 'workspaces', 'dedupe', 'licenses', 'bin', 'root', 'help',
  'set', 'tag', 'npm', 'node', 'plugin', 'constraints', 'explain', 'dlx', 'fetch', 'server', 'install-test', 'it', 'restart', 'stop',
]);
const opaque = (w: string) => /[{}$`*?]|^\s*$/.test(w);
const branchLike = (w: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(w) && !/\.\.|\/\/|\.lock$|\/$/.test(w);
const shaLike = (w: string) => /^[0-9a-f]{7,40}$/i.test(w);

interface Seen { text: string }

/** Args of `git push`: the remote, then refspecs; flags (and their values) skipped. */
/**
 * fix-lab5 (J14b): a push refspec that is one parameter (`git push origin {arg1}`, `arg1=beta:prod`) reads as the
 * value the skill recorded for it: its literal default, else the one value seen. A `$(…)` default, several values
 * seen, or anything not shaped like a branch or `src:dst` stays a parameter, so no anchor.
 */
type Vals = ReadonlyMap<string, string>;
const REFSPEC_VALUE = /^\+?[A-Za-z0-9][\w./-]{0,199}(?::[A-Za-z0-9][\w./-]{0,199})?$/;
function recordedValues(params: ParsedSkill['params']): Vals {
  const out = new Map<string, string>();
  for (const p of params ?? []) {
    const v = p.default ?? (p.seen.length === 1 ? p.seen[0] : undefined);
    if (typeof v === 'string' && REFSPEC_VALUE.test(v)) out.set(p.name, v);
  }
  return out;
}
const filled = (word: string, vals: Vals) => word.replace(/\{(\w{1,40})\}/g, (m, n: string) => vals.get(n) ?? m);

function pushAnchors(args: string[], step: number, out: Anchor[], vals: Vals = new Map()): void {
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (/^(?:--tags|--all|--mirror|--delete|-d|--prune)$/.test(a)) return;
    if (/^(?:-o|--push-option|--repo|--receive-pack|--exec)$/.test(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const [remote, ...specs] = pos;
  if (!remote || opaque(remote)) return;
  for (const raw of specs) {
    const spec = filled(raw, vals).replace(/^\+/, '');
    if (spec.startsWith(':')) continue; // a delete
    const [src, dst] = spec.includes(':') ? [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)] : [spec, spec];
    const to = dst!.replace(/^refs\/heads\//, '');
    if (to && !to.startsWith('refs/') && !opaque(to) && branchLike(to) && to !== 'HEAD' && !shaLike(to)) out.push({ kind: 'branch', name: to, step, remote, via: 'push' });
    if (spec.includes(':')) {
      const from = src!.replace(/^refs\/heads\//, '');
      if (from && !from.startsWith('refs/') && !opaque(from) && branchLike(from) && from !== 'HEAD' && !shaLike(from)) out.push({ kind: 'branch', name: from, step, remote, via: 'push-from' });
    }
  }
}

function gitAnchors(w: string[], step: number, stepDir: string | null, out: Anchor[], vals: Vals): void {
  let i = 1;
  let dir = stepDir;
  while (i < w.length && w[i]!.startsWith('-')) {
    // A git folder named some other way (`--git-dir`, `--work-tree`): its refs aren't the checkout's, so no branch anchor.
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(w[i]!)) return;
    if (w[i] === '-C') dir = joinDir(dir, w[i + 1]);
    i += /^(?:-C|-c|--namespace)$/.test(w[i]!) ? 2 : 1;
  }
  // The refs are the git folder's of the step's own folder (a submodule, a nested repo); unknown folder, no anchor.
  if (dir === null) return;
  const sub = w[i];
  const args = w.slice(i + 1);
  const from = out.length;
  if (sub === 'push') pushAnchors(args, step, out, vals);
  else if (sub === 'checkout') {
    if (args.some((a) => /^(?:-b|-B|--orphan|-p|--patch|--)$/.test(a))) return;
    const x = args.filter((a) => !a.startsWith('-'));
    if (x.length === 1 && !opaque(x[0]!) && branchLike(x[0]!) && !shaLike(x[0]!) && x[0] !== 'HEAD' && !/\.\w{1,6}$/.test(x[0]!)) out.push({ kind: 'branch', name: x[0]!, step, via: 'checkout' });
  } else if (sub === 'merge') {
    const x = args.filter((a) => !a.startsWith('-'));
    if (args.some((a) => /^(?:-m|--message|-F|--file)$/.test(a))) return;
    for (const a of x) {
      const slash = a.indexOf('/');
      if (slash <= 0 || opaque(a) || !branchLike(a)) continue;
      out.push({ kind: 'branch', name: a.slice(slash + 1), step, remote: a.slice(0, slash), via: 'merge' });
    }
  }
  if (dir) for (const a of out.slice(from)) a.dir = dir;
}

/** `npm run X`, `pnpm [run] X`, `yarn [run] X`, `bun run X`: the script, and the folder a flag names. Workspaces and filters: none. */
function scriptAnchor(w: string[], step: number, dir: string | null, out: Anchor[]): void {
  const pm = w[0]!;
  let at = dir;
  const rest: string[] = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (/^(?:-w|--workspace|--workspaces|-ws|--filter|-F|-r|--recursive|--include-workspace-root)$/.test(a) || /^--(?:workspace|filter)=/.test(a)) return;
    if (/^(?:--prefix|-C|--dir|--cwd)$/.test(a)) { at = joinDir(at, w[++i]); continue; }
    if (/^--(?:prefix|dir|cwd)=/.test(a)) { at = joinDir(at, a.slice(a.indexOf('=') + 1)); continue; }
    if (a === '--') break;
    if (a.startsWith('-')) continue;
    rest.push(a);
  }
  if (pm === 'yarn' && (rest[0] === 'workspace' || rest[0] === 'workspaces')) return;
  let name: string | undefined;
  if (pm === 'npm') name = rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : undefined;
  else if (pm === 'bun') name = rest[0] === 'run' ? rest[1] : undefined;
  else name = rest[0] === 'run' ? rest[1] : rest[0] && !PM_OWN.has(rest[0]) ? rest[0] : undefined;
  if (!name || opaque(name) || at === null) return;
  if (/\/|\.(?:[cm]?[jt]sx?|sh)$/.test(name)) return; // a file run by bun or yarn, not a script
  // npm run and pnpm run run scripts only; yarn [run] X, pnpm X and bun run X fall back to node_modules/.bin (review).
  const bin = pm === 'yarn' || pm === 'bun' || (pm === 'pnpm' && rest[0] !== 'run');
  out.push({ kind: 'script', name, step, ...(at ? { dir: at } : {}), ...(bin ? { bin: true } : {}) });
}

function makeAnchors(w: string[], step: number, dir: string | null, out: Anchor[]): void {
  let at = dir;
  const targets: string[] = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a === '-C' || a === '--directory') { at = joinDir(at, w[++i]); continue; }
    if (/^-C./.test(a)) { at = joinDir(at, a.slice(2)); continue; }
    // Another makefile: its targets aren't read here, so none of them is ever "gone".
    if (/^(?:-f|--file|--makefile)(?:=|$)/.test(a) || /^-f./.test(a)) return;
    if (/^(?:-[IoW]|--include-dir|--old-file|--what-if)$/.test(a)) { i++; continue; }
    if (a.startsWith('-') || a.includes('=')) continue;
    targets.push(a);
  }
  if (at === null) return;
  for (const t of targets) if (!opaque(t)) out.push({ kind: 'make', name: t, step, ...(at ? { dir: at } : {}) });
}

/** A folder joined to the step's folder, or null when it can't be known ($VAR, ~, absolute, a param). */
function joinDir(base: string | null, d: string | undefined): string | null {
  if (base === null || d === undefined) return null;
  const x = unquote(d);
  if (opaque(x) || isAbsolute(x) || x.startsWith('~')) return null;
  const j = join(base || '.', x);
  return j.startsWith('..') ? null : j === '.' ? '' : j;
}

/** A path the step runs that is sure to be the repo's or the person's: './x', 'x/y', '$HOME/x'. */
function fileArg(w: string): string | null {
  const x = unquote(w);
  if (x.startsWith('$HOME/')) return opaque(x.slice(5)) ? null : x;
  if (opaque(x) || isAbsolute(x) || x.startsWith('~') || x.startsWith('-') || !x.includes('/') || x.includes('..') || /^[a-z]+:\/\//i.test(x)) return null;
  return OUTPUTS.test(x) ? null : x;
}

/** The five anchor kinds in the skill's steps (4.18), each once (the first step that leans on it). */
export function anchorsOf(skill: ParsedSkill): Anchor[] {
  const out: Anchor[] = [];
  const seen: Seen = { text: '' };
  // Once a step changes the PATH (a venv, nvm use, export PATH), no later program is judged: it may be on the new one.
  let pathSet = false;
  const vals = recordedValues(skill.params);
  for (const st of skill.steps) {
    const found: Anchor[] = [];
    const { cds, rest } = leadingCds(String(st.cmd ?? ''));
    let dir: string | null = '';
    for (const c of cds) dir = joinDir(dir, c);
    for (const simple of simpleCommands(rest || '')) {
      const w = programWords(simple).map(unquote);
      const prog = w[0];
      if (PATH_ASSIGN.test(simple) || (prog !== undefined && PATH_SETTERS.has(prog))
        || (/^(?:export|declare|typeset|local)$/.test(prog ?? '') && w.some((a) => /^PATH\+?=/.test(a)))) {
        // `PATH=x tool` changes it for the tool too; `source`, `nvm use` and `export PATH=` for what follows.
        pathSet = true;
      }
      if (!prog || opaque(prog)) { seen.text += ` ${simple}`; continue; }
      if (prog.includes('/')) {
        const f = fileArg(prog);
        if (f && dir !== null && !seen.text.includes(f)) found.push({ kind: 'file', name: f, step: st.n, ...(dir ? { dir } : {}) });
      } else if (!BUILTINS.has(prog) && !PATH_SETTERS.has(prog)) {
        if (!pathSet) found.push({ kind: 'program', name: prog, step: st.n });
        if (prog === 'git') gitAnchors(w, st.n, dir, found, vals);
        else if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'bun') scriptAnchor(w, st.n, dir, found);
        else if (prog === 'make' || prog === 'gmake') makeAnchors(w, st.n, dir, found);
      }
      if (INTERPRETERS.test(prog)) {
        const first = w.slice(1).find((a) => !a.startsWith('-'));
        const flagged = w.slice(1, first ? w.indexOf(first) : w.length).some((a) => /^-(?:e|c|p|m|-eval|-print|[a-z]*c)$/.test(a));
        const f = first && !flagged ? fileArg(first) : null;
        if (f && dir !== null && !seen.text.includes(f)) found.push({ kind: 'file', name: f, step: st.n, ...(dir ? { dir } : {}) });
      }
      seen.text += ` ${simple}`;
    }
    for (const a of found) if (!out.some((x) => keyOf(x) === keyOf(a))) out.push(a);
  }
  return out;
}

const keyOf = (x: Anchor) => (x.kind === 'program' ? `program|${x.name}` : `${x.kind}|${x.name}|${x.remote ?? ''}|${x.dir ?? ''}|${x.via ?? ''}`);

/* ------------------------------------------------------------ checking */


const VERSION_DIRS = ['.volta/bin', '.bun/bin', '.cargo/bin', 'go/bin', '.pyenv/shims', '.local/share/mise/shims'];

/** The hook's PATH, 4.11's fixed folders and the version managers' folders (R35). */
function programDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || homedir();
  const dirs = pathDirs(env);
  for (const d of FIXED_DIRS) {
    if (d.startsWith('$HOME')) dirs.push(join(home, d.slice('$HOME'.length)));
    else if (!d.includes('$USER')) dirs.push(d);
    else if (env.USER && /^[A-Za-z0-9._-]{1,64}$/.test(env.USER) && !/^\.{1,2}$/.test(env.USER)) dirs.push(d.replace('$USER', env.USER));
  }
  try {
    for (const v of readdirSync(join(home, '.nvm', 'versions', 'node'))) dirs.push(join(home, '.nvm', 'versions', 'node', v, 'bin'));
  } catch { /* no nvm */ }
  for (const d of VERSION_DIRS) dirs.push(join(home, d));
  return [...new Set(dirs)];
}

/** On Windows a program is git.exe or npm.cmd, and no file has an exec bit: any regular file of those names counts. */
function onPath(name: string, dirs: string[], env: NodeJS.ProcessEnv): boolean {
  const names = programFiles(name, env);
  const win = process.platform === 'win32';
  return dirs.some((d) => names.some((n) => {
    try {
      const st = statSync(join(d, n));
      return st.isFile() && (win || (st.mode & 0o111) !== 0);
    } catch {
      return false;
    }
  }));
}

/** Scripts in the nearest package.json from `dir` up to the checkout; null when none can be read. */
function scriptsNear(checkout: string, dir: string): Record<string, unknown> | null {
  const top = resolve(checkout);
  for (let d = resolve(top, dir); ; d = dirname(d)) {
    const text = readSmall(join(d, 'package.json'));
    // The nearest one decides: one there that can't be read (too big, not a file) is not sure, never its parent's.
    if (text === null && exists(join(d, 'package.json'))) return null;
    if (text !== null) {
      try {
        const pkg = JSON.parse(text) as { scripts?: unknown };
        return pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Record<string, unknown> : {};
      } catch {
        return null;
      }
    }
    if (d === top || !d.startsWith(top + sep) || dirname(d) === d) return null;
  }
}

const TARGET_LINE = /^([^\s:#=][^:#=]*?)\s*::?(?!=)/;
/**
 * Has the Makefile a target X? null when it can't be known: no Makefile, the one make reads first can't be read here,
 * an include, a % rule, a target named by a variable, `define` or `$(eval` (any could make X).
 */
function makeHas(dir: string, name: string): boolean | null {
  const file = ['GNUmakefile', 'makefile', 'Makefile'].find((f) => exists(join(dir, f)));
  const text = file ? readSmall(join(dir, file)) : null;
  if (text === null) return null;
  let found = false;
  for (const line of text.split('\n')) {
    if (/^\s*-?s?include\s/.test(line) || /^\s*define\s/.test(line) || line.includes('$(eval') || line.includes('${eval')) return null;
    const m = TARGET_LINE.exec(line);
    if (!m) continue;
    const targets = m[1]!.trim().split(/\s+/);
    if (targets.some((t) => t.includes('%') || t.includes('$'))) return null;
    if (targets.includes(name)) found = true;
  }
  return found;
}

/**
 * `yarn X` that isn't a script: gone only when a node_modules/.bin from the step's folder up to the checkout is there
 * and none has X. No node_modules/.bin at all (not installed yet) is not sure.
 */
function binGone(checkout: string, dir: string, name: string): boolean {
  const top = resolve(checkout);
  let any = false;
  for (let d = resolve(top, dir); ; d = dirname(d)) {
    const bin = join(d, 'node_modules', '.bin');
    if (exists(bin)) {
      any = true;
      if (exists(join(bin, name))) return false;
    }
    if (d === top || !d.startsWith(top + sep) || dirname(d) === d) return any;
  }
}

/** Local file checks only: stat, package.json, Makefile, the git ref files. No process, no network, no cache (R35). */
export function goneAnchors(skill: ParsedSkill, cwd: string, env: NodeJS.ProcessEnv, opts: { scan?: boolean; deadline?: number } = {}): Anchor[] {
  const out: Anchor[] = [];
  let dirs: string[] | null = null;
  const gits = new Map<string, Git | null>();
  const gitAt = (dir: string) => {
    const at = resolve(cwd, dir);
    if (!gits.has(at)) gits.set(at, gitOf(at));
    return gits.get(at)!;
  };
  const home = env.HOME || homedir();
  for (const a of anchorsOf(skill)) {
    try {
      if (a.kind === 'program') {
        // No PATH, no check: the fixed folders alone miss /usr/bin.
        if (!String(env.PATH ?? '').trim()) continue;
        dirs ??= programDirs(env);
        if (!onPath(a.name, dirs, env)) out.push(a);
      } else if (!cwd) {
        continue;
      } else if (a.kind === 'script') {
        const scripts = scriptsNear(cwd, a.dir ?? '');
        if (scripts && !Object.prototype.hasOwnProperty.call(scripts, a.name) && (!a.bin || binGone(cwd, a.dir ?? '', a.name))) out.push(a);
      } else if (a.kind === 'make') {
        if (makeHas(resolve(cwd, a.dir ?? ''), a.name) === false) out.push(a);
      } else if (a.kind === 'file') {
        const inHome = a.name.startsWith('$HOME/');
        const p = inHome ? join(home, a.name.slice(6)) : resolve(cwd, a.dir ?? '', a.name);
        // A sparse checkout leaves files out on purpose: a repo file there is never sure to be gone.
        if (!inHome && gitAt('')?.sparse) continue;
        // Gone only beside what is still there: a missing folder is as likely another layout as a deletion.
        if (!exists(p) && exists(dirname(p))) out.push(a);
      } else if (a.kind === 'branch') {
        const git = gitAt(a.dir ?? '');
        if (!git) continue;
        const r = branchGone(git, a);
        if (r?.gone) out.push({ ...a, ...(r.remote ? { remote: r.remote } : {}) });
      }
    } catch { /* a check that throws is not gone */ }
  }
  // Phase 2 (4.13): CI files, compose services, the repo's CLI subcommands; the subcommand scan only with scan: true.
  out.push(...wideGone(skill, cwd, env, { scan: opts.scan === true, ...(opts.deadline ? { deadline: opts.deadline } : {}) }));
  return out;
}

/* --------------------------------------------------------------- words */

function what(a: Anchor): string {
  const x = flatLine(a.name, 80);
  if (a.kind === 'branch') return fill(ANCHOR_COPY[a.via ?? 'push']!, { x, remote: flatLine(a.remote ?? 'the remote', 60) });
  return fill(ANCHOR_COPY[a.kind]!, { x, file: flatLine(a.where ?? 'the compose file', 80), prog: flatLine(a.where ?? 'its CLI', 40) });
}

/** What is gone, in words: the first gone anchor, then `and {k} more` (`trail skills`, 2.12). '' when none. */
export function goneWords(gone: Anchor[]): string {
  if (!gone.length) return '';
  return `${what(gone[0]!)}${gone.length > 1 ? fill(ANCHOR_COPY.more!, { k: String(gone.length - 1) }) : ''}`;
}

/** J14b's words: the first gone anchor, then `and {k} more`. '' when none. */
export function outOfDateLine(name: string, gone: Anchor[]): string {
  if (!gone.length) return '';
  const n = flatLine(name, 60);
  const more = gone.length > 1 ? fill(ANCHOR_COPY.more!, { k: String(gone.length - 1) }) : '';
  return fill(ANCHOR_COPY.line!, { name: n, what: `${what(gone[0]!)}${more}` });
}
