/**
 * One Bash call, as the commands it ran (an addition to design 4.5 step 2).
 *
 * Agents often send a small script in one call: an `echo "=== x ==="` header,
 * a `cd`, a look around, then the commands that matter, one per line or
 * chained with `;` and `&&`. A top-level newline or `;` separates commands,
 * and an `&&` link that only prints or looks can go without changing what
 * the rest does, so such a call is read part by part instead of refused as
 * multi-line. What stays is word for word what ran, so the save gate can
 * still find it (`stepMatches` matches after a newline, `;` or `&&`):
 * - steps chained with `&&` and nothing between them stay one step (design
 *   4.5: `git tag ... && git push ...`); a test that guards a step
 *   (`[ -f x ] && ...`, `grep -q`, `command -v`) stays with it;
 * - `cd X` (on its own line, as `cd X || exit 1`, or as `cd X && ...`)
 *   moves the folder of what follows, as the shell would;
 * - `set -e`, comments, echo headers and looks are left out;
 * - a step that uses a variable set earlier in the call, or that follows an
 *   `export`, `source` or `set -a`, can't run on its own: it refuses the
 *   skill, as the whole call did before;
 * - an interpreter heredoc (python3/node/... `- <<EOF`) or a multi-line
 *   inline script is work when it writes files or starts programs and a
 *   look when it only reads or prints (D51, D58 e): left out either way. A
 *   one-line inline script that starts a program is a step. Any other
 *   heredoc that is a step (a shell script, `psql <<EOF`) refuses;
 * - a loop that polls one command and sleeps between tries is that command,
 *   as a wait (D58 d);
 * - `a &` runs in the background.
 * A failed call is not split (which part failed is unknown), nor one holding
 * anything never saved (sudo, a credential file, Trail itself: the whole
 * skill is refused), and a truncated one only when what it ran holds no step
 * and no heredoc. A call that is one
 * command is left as it is.
 *
 * Pure: no files.
 */
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CallKind, JobClass, RunCall, RunSheet } from '../trace/types.js';
import { callKind, checkFamilyOf } from '../trace/checks.js';
import { envPrefix, heredocInterpreter, leadingCds, scriptKind } from '../trace/shell.js';
import { ASSIGN, OPEN_KW, base, scan, unquote, words, type Piece } from '../trace/shell-scan.js';
import { programWords } from '../trace/shell-words.js';
import { neverSave } from './never-save.js';

export interface Statement {
  /** Word for word what ran (a subshell's leading cds are in `cwd`). */
  text: string;
  /** Repo-relative folder it ran in; null outside the repo or unknown. */
  cwd: string | null;
  kind: CallKind;
  bg: boolean;
  /** It opened a heredoc. */
  heredoc: boolean;
  /** The heredoc bodies it fed, for the risk check of a step ('' when none). */
  body: string;
  /** Why this can't be a step on its own (set only for steps). */
  blocked: string | null;
  /** D58 d: a polling loop, read as the command it polled; compile writes it as the 4.5 wait. */
  wait?: LoopWait;
}

/** How a polling loop waited: until CMD prints `token`, until CMD works, or (whileOk) while it still works. */
export interface LoopWait { token: string | null; whileOk?: true }

interface Ctx { repoRoot: string; home: string; job: JobClass | null }

/** A venv's own activate by a plain path in the repo: setup known to be safe, carried into the steps chained after it. */
const VENV_ACTIVATE = /^(?:source|\.)\s+((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\/bin\/activate)$/;
const venvActivate = (head: string) => {
  const m = VENV_ACTIVATE.exec(head);
  return !!m && !m[1]!.split('/').includes('..');
};
const SETUP = /^(?:export|source|\.|set\s+(?:-\w*a|-o\s+allexport)|umask|nvm\s+use|conda\s+activate|pyenv\s+shell)\b/;
/** Shell options that change nothing for one command on its own (`set -a` is setup, not one of these). */
const IGNORED = /^(?:set(?:\s+(?:[-+][b-zA-Z]+|pipefail|errexit|nounset|xtrace|verbose))+|shopt\b.*|setopt\b.*|trap\b.*|unset\b.*|true|:)$/;
const SHELL = /^(?:ba|z|da|k)?sh$/;
/** A look that can fail and so guards what follows it in an `&&` chain. */
const GUARD = /^(?:test|\[\[?|command -v|which|grep -\w*q\w*|git diff --quiet|git diff --exit-code|git rev-parse --verify|git merge-base --is-ancestor|git cat-file -e)(?=\s|$)/;

/** The folder after `cd target`, repo-relative; null when it leaves the repo or can't be known. */
function cdTo(cwd: string | null, target: string | undefined, vars: Map<string, string>, ctx: Ctx): string | null {
  let t = unquote(target ?? '~').replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, n: string) => vars.get(n) ?? m);
  t = t.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, ctx.home);
  if (!t || t === '-' || /[$`*?]/.test(t) || (cwd === null && !isAbsolute(t))) return null;
  const rel = relative(ctx.repoRoot, resolve(join(ctx.repoRoot, cwd ?? ''), t)).split('\\').join('/');
  // A worktree under the repo is another checkout, not a folder of this one.
  return rel.startsWith('..') || isAbsolute(rel) || /(?:^|\/)\.(?:claude\/)?worktrees(?:\/|$)/.test(rel) ? null : rel;
}

/** `$NAME` or `${NAME}` outside single quotes. */
function usesVar(text: string, names: Set<string>): string | null {
  const bare = text.replace(/'[^']*'/g, "''");
  for (const m of bare.matchAll(/\$\{?([A-Za-z_]\w*)/g)) if (names.has(m[1]!)) return m[1]!;
  return null;
}

/**
 * D51, D58 e: an interpreter's heredoc program is a look when it only reads or prints and work when it
 * writes files, starts programs or uses the network: it is left out, never a step (shell.ts `scriptKind`,
 * the fold's reader too). A shell heredoc is a script of commands: a step no one can read, which refuses.
 */
function heredocKind(head: string, bodies: string, job: JobClass | null): { kind: CallKind; step: boolean } {
  const w = programWords(head);
  if (SHELL.test(base(w[0] ?? ''))) return { kind: 'step', step: true };
  const prog = heredocInterpreter(w);
  if (prog) return { kind: scriptKind(bodies, prog) === 'look' && callKind(head, job) !== 'work' ? 'look' : 'work', step: false };
  const k = callKind(head, job);
  return { kind: k, step: k === 'step' };
}

interface Link { start: number; end: number; pieces: Piece[] }

/** `cd X`, `cd X 2>/dev/null`, `cd X || exit 1`, `cd X || { echo no; exit 1; }`: the target, else undefined. */
function cdLink(s: string, l: Link): string | undefined | null {
  const w = words(s.slice(l.pieces[0]!.start, l.pieces[0]!.end)).filter((x) => !/^\d?>/.test(x) && !/^\/dev\/null$/.test(x));
  if (w[0] !== 'cd' || w.length > 2) return null;
  if (l.pieces.length > 1 && (l.pieces[0]!.sep !== '||' || l.pieces.slice(1).some((p) => callKind(s.slice(p.start, p.end), null) !== 'plumbing'))) return null;
  return w[1] === undefined ? '~' : w[1];
}

/**
 * A plain value: written into later lines, or carried as an env prefix. `$HOME` and `$PATH` stay as they
 * are, and so does a named secret's placeholder (`"${NPM_TOKEN:?set NPM_TOKEN}"`, 4.10).
 */
const plain = (v: string) => /^\$\{([A-Za-z_]\w*):\?set \1\}$/.test(unquote(v))
  || /^[\w./:@%+,=~-]*$/.test(unquote(v).replace(/\$(?:\{(?:HOME|PATH)\}|HOME\b|PATH\b)/g, ''));

/** `$NAME` and `${NAME}` outside single quotes, as their plain values. */
function writeIn(text: string, vars: Map<string, string>): string {
  if (!vars.size) return text;
  let out = '';
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\' && !single) { out += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === '$' && !single) {
      const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(text.slice(i));
      const v = m ? vars.get(m[1] ?? m[2]!) : undefined;
      if (m && v !== undefined) { out += v; i += m[0].length - 1; continue; }
    }
    out += c;
  }
  return out;
}

/** A `{ ... }` or `( ... )` group, alone or with only redirects and output filters after it: its inside. */
function groupInside(s: string, l: Link): { inner: string; subshell: boolean } | null {
  const g = l.pieces[0]!.group;
  if (!g || g.close < 0 || l.pieces[0]!.bodies.length) return null;
  if (!/^\s*(?:\d?>>?&?\s*[^\s&>]\S*(?:\s+|$))*$/.test(s.slice(g.close + 1, l.pieces[0]!.end))) return null;
  const filters = l.pieces.slice(1).every((p) => /^(?:tail|head|grep|cat|sed -n|cut|sort|uniq|wc|tr|tee)\b/.test(s.slice(p.start, p.end).trim()));
  if (!filters || (l.pieces.length > 1 && l.pieces[0]!.sep !== '|')) return null;
  return { inner: s.slice(g.open + 1, g.close), subshell: s[g.open] === '(' };
}

const SLEEP = /^sleep\s+\d+(?:\.\d+)?[smh]?$/;
const NOISE = /^(?:echo|printf|:|true)(?:\s|$)(?![^'"]*>)/;
const DEV_NULL = /(?:\s+(?:\d?>>?|&>)\s*\/dev\/null|\s+\d?>&\d)+$/;
/** `[ "$V" = "T" ]`, `[[ $V == T ]]`, `test "$V" != T`: the variable, the test and the value. */
const COMPARE = /^(?:\[\[?|test)\s+"?\$\{?([A-Za-z_]\w*)\}?"?\s+(==?|!=)\s+(['"]?)([\w.:-]{1,40})\3(?:\s+\]\]?)?$/;
/** `[ "$(CMD)" = "T" ]` in an until/while header. */
const COMPARE_SUB = /^(?:\[\[?|test)\s+"\$\(([\s\S]+)\)"\s+(==?|!=)\s+(['"]?)([\w.:-]{1,40})\3(?:\s+\]\]?)?$/;

/**
 * D58 d: a `for`, `while` or `until` loop that tries one command, sleeping between tries, until it works
 * or prints a value: that command and how it waited. Anything else in the loop (a second command, the
 * loop's own variable in the command, an `else`) and it is not a poll: null.
 */
export function pollLoop(text: string): { cmd: string; wait: LoopWait } | null {
  const segs = scan(text, false).segs;
  if (segs.length < 3 || text.slice(segs[segs.length - 1]!.start, segs[segs.length - 1]!.end).trim() !== 'done') return null;
  // Pipelines, keywords stripped: [text, the separator after it].
  const items: Array<[string, string]> = [];
  let pipe = '';
  for (const p of segs) {
    pipe += (pipe ? ' | ' : '') + text.slice(p.start, p.end).trim();
    if (p.sep === '|') continue;
    items.push([pipe, p.sep]);
    pipe = '';
  }
  const head = /^(for|while|until)\s+([\s\S]*)$/.exec(items[0]![0]);
  if (!head || items[0]![1] === '&&' || items[0]![1] === '||') return null;
  const loopVar = head[1] === 'for' ? /^([A-Za-z_]\w*)\s+in\b/.exec(head[2]!)?.[1] ?? null : null;
  if (head[1] === 'for' && !loopVar && !/^\(\(/.test(head[2]!)) return null;
  const body: Array<[string, string]> = [];
  for (const [t, sep] of items.slice(1, -1)) {
    const x = t.replace(/^(?:do|then)(?:\s+|$)/, '').trim();
    if (x) body.push([x, sep]);
  }
  let sleeps = 0;
  const rest: Array<[string, string]> = [];
  for (const [x, sep] of body) {
    if (SLEEP.test(x)) sleeps++;
    else if (/^(?:else|elif)\b/.test(x)) return null;
    else if (!NOISE.test(x) || sep === '&&' || sep === '||') rest.push([x, sep]);
  }
  if (!sleeps) return null;
  const isBreak = (x: string) => x === 'break' || /^\{(?:\s*(?:echo|printf)\b[^;]*;)*\s*break\s*;?\s*\}$/.test(x);
  let cmd: string | null = null;
  let wait: LoopWait | null = null;
  const r = rest.filter(([x]) => x !== 'fi');
  if (head[1] !== 'for') {
    if (r.length) return null;
    const cond = head[2]!.replace(/\s+$/, '');
    const sub = COMPARE_SUB.exec(cond);
    if (sub) {
      if ((head[1] === 'until') !== (sub[2] !== '!=')) return null;
      [cmd, wait] = [sub[1]!, { token: sub[4]! }];
    } else {
      const neg = /^!\s+/.test(cond);
      cmd = cond.replace(/^!\s+/, '');
      wait = (head[1] === 'until') !== neg ? { token: null } : { token: null, whileOk: true };
    }
  } else if (r.length === 2 || r.length === 3) {
    // `CMD && break`, `CMD || break`, `if CMD; then break; fi`, or `V=$(CMD)` then a test of $V and a break.
    const [a, b, c] = r as Array<[string, string]>;
    const assign = /^([A-Za-z_]\w*)=(?:"\$\(([\s\S]+)\)"|\$\(([\s\S]+)\))$/.exec(a![0]);
    if (assign && c && isBreak(c[0])) {
      const m = COMPARE.exec(b![0].replace(/^if\s+/, ''));
      if (!m || m[1] !== assign[1] || m[2] === '!=' || !(b![1] === '&&' || /^if\s/.test(b![0]))) return null;
      [cmd, wait] = [assign[2] ?? assign[3]!, { token: m[4]! }];
    } else if (!c && isBreak(b![0])) {
      const iff = /^if\s+(!\s+)?([\s\S]+)$/.exec(a![0]);
      if (iff) [cmd, wait] = [iff[2]!, iff[1] ? { token: null, whileOk: true } : { token: null }];
      else if (a![1] === '&&') [cmd, wait] = [a![0], { token: null }];
      else if (a![1] === '||') [cmd, wait] = [a![0], { token: null, whileOk: true }];
    }
  }
  if (cmd === null || wait === null) return null;
  cmd = (wait.token === null ? cmd.replace(DEV_NULL, '') : cmd).trim();
  if (!cmd || /^(?:\[|test\b)/.test(cmd) || scan(cmd).segs.some((p) => p.sep !== '|' && p.sep !== '')) return null;
  if (loopVar && usesVar(cmd, new Set([loopVar]))) return null;
  const k = callKind(cmd, null);
  return k === 'step' || k === 'look' ? { cmd, wait } : null;
}

/** The statements of `cmd`, whose leading cds the fold already read into `cwd`. */
export function statementsOf(cmd: string, cwd: string | null, ctx: Ctx): Statement[] {
  const out: Statement[] = [];
  let st = {
    folder: cwd, stack: [] as Array<string | null>, vars: new Map<string, string>(), local: new Set<string>(),
    env: new Map<string, string>(), setup: null as string | null,
  };
  const copy = () => ({ ...st, stack: [...st.stack], vars: new Map(st.vars), local: new Set(st.local), env: new Map(st.env) });

  const walk = (s: string) => {
    // Statements end at a newline, `;` or `&`; links at `&&`.
    const statements: Link[][] = [];
    let cur: Link[] = [];
    let link: Piece[] = [];
    for (const p of scan(s).segs) {
      link.push(p);
      const ends = p.nl || p.sep === ';' || p.sep === '&' || p.sep === '';
      if (ends || p.sep === '&&') { cur.push({ start: link[0]!.start, end: p.end, pieces: link }); link = []; }
      if (ends) { statements.push(cur); cur = []; }
    }
    if (link.length) cur.push({ start: link[0]!.start, end: link[link.length - 1]!.end, pieces: link });
    if (cur.length) statements.push(cur);

    for (const links of statements) {
      const last = links[links.length - 1]!.pieces;
      const bg = last[last.length - 1]!.sep === '&';
      // `a && b || c` is `(a && b) || c`: such a statement stays whole.
      const mixed = links.length > 1 && links.some((l) => l.pieces.slice(0, -1).some((p) => p.sep === '||') && cdLink(s, l) === null);
      const units = mixed ? [{ start: links[0]!.start, end: links[links.length - 1]!.end, pieces: links.flatMap((l) => l.pieces) }] : links;
      let run: Array<{ l: Link; kind: CallKind; guard: boolean; bodies: string }> = [];
      // `source .venv/bin/activate && STEP`: the activate goes into each step chained after it, word for word.
      let carry: string | null = null;
      const emit = (r: typeof run, poll?: { cmd: string; wait: LoopWait }) => {
        let text = poll ? poll.cmd : s.slice(r[0]!.l.start, r[r.length - 1]!.l.end).trim();
        const bodies = r.map((x) => x.bodies).filter(Boolean).join('\n');
        const lead = leadingCds(text);
        const here = lead.cds.reduce<string | null>((f, c) => cdTo(f, c, st.vars, ctx), st.folder);
        const hd = bodies ? heredocKind(text, bodies, ctx.job) : null;
        const kind = poll ? 'step' : r.length > 1 ? callKind(text, ctx.job) : hd ? hd.kind : r[0]!.kind;
        let blocked: string | null = null;
        if (kind === 'step') {
          text = writeIn(text, st.vars);
          const own = new Set(envPrefix(text).env.map((a) => a.slice(0, a.indexOf('='))));
          const env = [...st.env].filter(([n]) => !own.has(n)).map(([, a]) => a);
          // An env prefix goes on a simple command only: `X=1 if ...` is not shell.
          const compound = OPEN_KW.has(words(text)[0] ?? '') || /^[({!]/.test(text);
          const setup = st.setup ?? (env.length && compound ? `export ${env.join(' ')}` : null);
          if (env.length && !compound) text = `${env.join(' ')} ${text}`;
          if (carry) text = `${carry} && ${text}`;
          const v = usesVar(text, new Set([...st.local].filter((n) => !st.vars.has(n))));
          if (hd?.step) blocked = 'runs a script written inline (a heredoc)';
          else if (text.includes('\n')) blocked = 'runs over more than one line';
          else if (v) blocked = `uses $${v}, set on an earlier line`;
          else if (setup) blocked = `needs its shell set up first (\`${setup.split('\n')[0]!.slice(0, 60)}\`)`;
        }
        out.push({ text, cwd: here, kind, bg, heredoc: !!bodies, body: bodies, blocked, ...(poll ? { wait: poll.wait } : {}) });
      };
      const flush = () => {
        // A guard is kept only in front of a step.
        while (run.length && run[run.length - 1]!.guard) { const g = run.pop()!; emit([g]); }
        if (run.length) emit(run);
        run = [];
      };
      for (const l of units) {
        const head = s.slice(l.start, l.end).trim();
        if (!head || head.startsWith('#')) continue;
        const bodies = l.pieces.flatMap((p) => p.bodies.map(([a, b]) => s.slice(a, b))).join('\n');
        const w = words(s.slice(l.pieces[0]!.start, l.pieces[0]!.end));
        const group = bodies || mixed ? null : groupInside(s, l);
        if (group) {
          flush();
          const saved = group.subshell ? copy() : null;
          const from = out.length;
          walk(group.inner);
          if (saved) st = saved;
          // A block run in the background ran its lines in order: only its last step stays in the background.
          if (bg) for (let k = out.length - 1; k >= from; k--) if (out[k]!.kind === 'step') { out[k]!.bg = true; break; }
          continue;
        }
        // D58 d: a loop that polls one command is that command, as a wait.
        const poll = bodies || l.pieces.length > 1 || !/^(?:for|while|until)\s/.test(head) ? null : pollLoop(head);
        if (poll) { flush(); emit([{ l, kind: 'step', guard: false, bodies }], poll); continue; }
        const cd = bodies ? null : cdLink(s, l);
        if (cd !== null) { flush(); st.folder = cdTo(st.folder, cd, st.vars, ctx); continue; }
        if (!bodies && l.pieces.length === 1 && w[0] === 'pushd') { flush(); st.stack.push(st.folder); st.folder = cdTo(st.folder, w[1], st.vars, ctx); continue; }
        if (!bodies && l.pieces.length === 1 && w[0] === 'popd') { flush(); st.folder = st.stack.length ? st.stack.pop()! : null; continue; }
        if (!bodies && IGNORED.test(head)) continue;
        const assigns = l.pieces.length === 1 && !bodies ? (w[0] === 'export' ? w.slice(1) : w) : [];
        if (assigns.length && assigns.every((x) => ASSIGN.test(x))) {
          flush();
          for (const a0 of assigns) {
            const a = writeIn(a0, st.vars);
            const n = a.slice(0, a.indexOf('='));
            const v = a.slice(a.indexOf('=') + 1);
            st.local.add(n);
            if (plain(v)) st.vars.set(n, /^\$\{/.test(unquote(v)) ? `"${unquote(v)}"` : unquote(v)); else st.vars.delete(n);
            if (w[0] === 'export') { if (plain(v)) st.env.set(n, a); else st.setup ??= head; }
          }
          continue;
        }
        if (!bodies && !mixed && l !== units[units.length - 1] && l.pieces.length === 1 && venvActivate(head)) { flush(); carry = head; continue; }
        if (!bodies && SETUP.test(head)) { flush(); st.setup ??= head; continue; }
        if (w[0] === 'read') for (const x of w.slice(1)) if (/^[A-Za-z_]\w*$/.test(x)) st.local.add(x);
        const kind = bodies ? heredocKind(head, bodies, ctx.job).kind : callKind(head, ctx.job);
        const guard = kind === 'look' && !bodies && GUARD.test(head);
        if (kind === 'step' || guard) { run.push({ l, kind, guard, bodies }); continue; }
        flush();
        emit([{ l, kind, guard, bodies }]);
      }
      flush();
      // Later statements aren't chained to it: they need their shell set up, as before.
      if (carry) st.setup ??= carry;
    }
  };
  const s = leadingCds(String(cmd ?? '').replace(/\\\r?\n[ \t]*/g, ' ')).rest;
  if (s) walk(s);
  return out;
}

/**
 * D58 c: a call over 2,000 characters comes as its top-level pieces (g3's `parts`). Read as one call
 * again, a piece too long to keep (and a pipeline holding one) standing as `:` on a line of its own, so
 * it splits away and is left out like a file edit. Null when a piece held a secret Trail couldn't name:
 * that call refuses whole.
 */
function fromParts(c: RunCall): RunCall | null {
  const ps = c.parts ?? [];
  if (ps.some((p) => p.secret === 'refused' || (p.cmd === null && !p.long))) return null;
  const long = ps.map((p) => !!p.long);
  // A pipeline with a long piece is gone whole: the rest of it read that piece's output, or fed it.
  for (let i = 0; i < ps.length; i++) {
    if (!long[i]) continue;
    for (let k = i - 1; k >= 0 && ps[k]!.sep === '|'; k--) long[k] = true;
    for (let k = i; k < ps.length - 1 && ps[k]!.sep === '|'; k++) long[k + 1] = true;
  }
  let text = '';
  ps.forEach((p, i) => {
    text += long[i] ? ':' : p.cmd!;
    const apart = long[i] || long[i + 1];
    text += p.sep === '' ? '' : p.sep === ';' || (apart && p.sep !== '|') ? '\n' : p.sep === '&' ? ' &\n' : ` ${p.sep} `;
  });
  const { parts: _parts, ...rest } = c;
  return { ...rest, cmd: text.trim(), truncated: false, multiLine: true };
}

/** A sheet whose step calls (and check call) of more than one command are read part by part; `blocked` says why a part refuses. */
export function splitSheet(sheet: RunSheet, ctx: { repoRoot: string; home: string }): {
  sheet: RunSheet; blocked: Map<RunCall, string>; waits: Map<RunCall, LoopWait>; parts: Map<RunCall, RunCall[]>;
} {
  const blocked = new Map<RunCall, string>();
  const waits = new Map<RunCall, LoopWait>();
  const parts = new Map<RunCall, RunCall[]>();
  const calls: RunCall[] = [];
  let checkIndex = sheet.checkIndex;
  const c0 = { ...ctx, job: sheet.job };
  sheet.calls.forEach((orig, i) => {
    const isCheck = i === sheet.checkIndex;
    const c = orig.cmd === null && orig.parts?.length ? fromParts(orig) ?? orig : orig;
    const whole = (x: RunCall, check: boolean) => { if (check) checkIndex = calls.length; calls.push(x); parts.set(orig, [x]); };
    if ((c.kind !== 'step' && !isCheck) || c.failed || c.cmd === null) return whole(c, isCheck);
    // A call with anything that is never saved (sudo, a credential file, Trail itself) stays whole, so compile refuses it.
    if (neverSave(c.cmd) && !c.multiLine) return whole(c, isCheck);
    const st = statementsOf(c.cmd, c.cwd, c0);
    // Code a heredoc writes into a file is not run: only a step's heredoc counts for the risk check.
    if (st.some((x) => neverSave(x.kind === 'step' && x.body ? `${x.text}\n${x.body}` : x.text))) return whole(c, isCheck);
    if (!st.length) return whole(c, isCheck);
    // One command, as the fold read it: leave it be.
    if (st.length === 1 && st[0]!.kind === c.kind && !st[0]!.blocked && !st[0]!.wait && st[0]!.cwd === c.cwd && !c.multiLine) return whole(c, isCheck);
    if (c.truncated && st.some((x) => x.kind === 'step' || x.heredoc)) return whole(c, isCheck);
    let ck = -1;
    if (isCheck) {
      const fam = c.check?.family ?? checkFamilyOf(c.cmd, sheet.job);
      for (let k = st.length - 1; k >= 0 && ck < 0; k--) if (!st[k]!.blocked && fam && checkFamilyOf(st[k]!.text, sheet.job) === fam) ck = k;
      if (ck < 0) return whole(c, isCheck);
    }
    // A call run in the background: its steps ran in order, so only the last needs to stay in the background.
    const steps = st.filter((x) => x.kind === 'step');
    st.forEach((x, k) => {
      const sub: RunCall = {
        ...c, cmd: x.text, cwd: x.cwd, kind: x.kind, bg: (c.bg && x === steps[steps.length - 1]) || (x.bg && x.kind === 'step'),
        multiLine: x.text.includes('\n'), truncated: false,
      };
      if (k === ck) checkIndex = calls.length;
      else delete sub.check;
      if (k !== ck && k !== st.length - 1) delete sub.tail;
      if (x.blocked) blocked.set(sub, x.blocked);
      if (x.wait && k !== ck) waits.set(sub, x.wait);
      calls.push(sub);
    });
    parts.set(orig, calls.slice(calls.length - st.length));
  });
  return { sheet: { ...sheet, calls, checkIndex }, blocked, waits, parts };
}

/** `Temp` matched in any case (`[Tt][Ee]…`): Windows paths ignore it. */
const anyCase = (w: string) => w.replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
const SEG = String.raw`[^\\/\s'"\`;|&()<>,]`;
/**
 * Windows' temp folders, with either slash: the person's `AppData\Local\Temp` (as `C:\` or Git Bash's `/c/`),
 * `Windows\Temp`, `%TEMP%` and `$env:TEMP`. What follows the folder is left to the caller.
 */
export const WIN_TEMP = String.raw`(?:(?<![\w.~$-])(?:[A-Za-z]:|\/[A-Za-z])[\\/](?:${anyCase('users')}[\\/]${SEG}+[\\/]${anyCase('appdata')}[\\/]${anyCase('local')}[\\/]${anyCase('temp')}|${anyCase('windows')}[\\/]${anyCase('temp')})(?!${SEG})|%${anyCase('t')}${anyCase('e')}?${anyCase('mp')}%|\$${anyCase('env')}:${anyCase('t')}${anyCase('e')}?${anyCase('mp')}(?!\w))`;

/** A scratch file a step's output went into: `> /tmp/dev.log 2>&1`, `>> "$TMPDIR/x"`, `| tee …/scratchpad/t.log`, `> %TEMP%\x.log`. */
const SCRATCH_FILE = String.raw`(["']?)(?:(?:\/private)?\/(?:tmp|var\/folders)\/|\$\{?TMPDIR\}?\/?|[^\s'"\`;|&()<>,=]*[\\/]scratchpad[\\/]|${WIN_TEMP}[\\/]?)[^\s'"\`;|&()<>,]*\1`;
const LOG_TAIL = [new RegExp(String.raw`\s+(?:\d?>>?|&>>?)\s*${SCRATCH_FILE}$`), new RegExp(String.raw`\s*\|\s*tee(?:\s+-a)?\s+${SCRATCH_FILE}$`)];

/** Where the output went is not what ran: a trailing log into a scratch folder goes (with its `2>&1`), the step stays. */
export function stripScratchLog(text: string): string {
  let s = text.trimEnd();
  const amp = /(?<![&|>])\s&$/.test(s) ? ' &' : '';
  if (amp) s = s.slice(0, -1).trimEnd();
  let cut = false;
  for (let n = 0; n < 6; n++) {
    const bare = s.replace(/\s+\d?>&\d$/, '');
    const re = LOG_TAIL.find((r) => r.test(bare));
    if (re) { s = bare.replace(re, '').trimEnd(); cut = true; } else if (cut && bare !== s) s = bare; else break;
  }
  return cut && s ? `${s}${amp}` : text;
}
