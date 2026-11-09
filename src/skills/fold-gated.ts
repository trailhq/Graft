/**
 * D138 (1): what a fold may change in a gated step (one that can't be undone). P7 held a changed gated step to the
 * same gated kind, so `git push origin v{version}` could become `git push origin HEAD:main` (both push-prod). Now the
 * new step must be the same command with only its arguments changed: the same program and verb, as many simple
 * commands, no force or skip flag the old step lacked (`--force`, `-f`, a `-fq` bundle, `--no-verify`, a `+refspec`),
 * and no shared branch (main, prod, ...) it didn't already name. D148 (the reading the lead accepted): no remote or
 * registry change either (a git push's remote, a URL or `user@host:` address, an image's registry host), and no
 * delete, mirror or every-ref push the old step lacked (`--delete`, `-d`, a `:ref` refspec, `--mirror`, `--all`,
 * `--prune`, `--tags`). Pure.
 */
import { programVerb } from './fidelity.js';
import { RISKY_FLAG } from './risk-delta.js';
import { STABLE_BRANCHES } from './params.js';
import { simpleCommands } from '../trace/shell.js';
import { unquote, words } from '../trace/shell-scan.js';

const wordsOf = (cmd: string): string[] => words(cmd).map((w) => unquote(w));

/** The flags a word sets, a short bundle letter by letter, `--x=y` as `--x`. */
function flagsOf(w: string): string[] {
  if (/^-[A-Za-z]{2,}$/.test(w)) return [...w.slice(1)].map((c) => `-${c}`);
  return w.startsWith('-') ? [w.split('=')[0]!] : [];
}

/** A word's branch, as a push or checkout names it: the refspec's destination, refs/heads/ and a remote's name off. */
function branchOf(w: string): string | null {
  if (w.startsWith('-')) return null;
  const dst = w.replace(/^\+/, '').split(':').at(-1)!.replace(/^refs\/heads\//, '').replace(/^(?:origin|upstream)\//, '');
  return STABLE_BRANCHES.has(dst) ? dst : null;
}

/** Flags that delete refs or widen a push past the refs it names. */
const WIDE_FLAG = /^(?:--delete|-d|--mirror|--all|--prune|--prune-tags|--tags)$/;

/** The host a word names: a URL's, an scp-style `user@host:path`'s, or an image's registry (`registry.acme.dev/shop:1`). */
function hostOf(w: string): string | null {
  const m = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(w) ?? /^[\w.-]+@([\w.-]+):/.exec(w) ?? /^((?:[a-z0-9-]+\.)+[a-z]{2,}|localhost)(?::\d+)?\//i.exec(w);
  return m ? m[1]!.toLowerCase() : null;
}

/** `git push`'s remote: the first word after `push` that isn't a flag ('' when it names none). */
function pushRemote(ws: string[]): string | null {
  const g = ws.findIndex((w, i) => w === 'push' && ws.slice(0, i).some((x) => /(?:^|\/)git$/.test(x)));
  if (g < 0) return null;
  return ws.slice(g + 1).find((w) => !w.startsWith('-')) ?? '';
}

/** Whether `next` (filled) changes only the arguments of the gated step `old` (filled): see the header. */
export function sameGatedCommand(old: string, next: string): boolean {
  try {
    if (programVerb(old) === null || programVerb(old) !== programVerb(next)) return false;
    if (simpleCommands(old).length !== simpleCommands(next).length) return false;
    const a = wordsOf(old);
    const b = wordsOf(next);
    const hadFlags = new Set(a.flatMap(flagsOf));
    if (b.flatMap(flagsOf).some((f) => RISKY_FLAG.test(f) && !hadFlags.has(f))) return false;
    if (b.some((w) => w.startsWith('+') && !a.includes(w))) return false;
    // D148: the same remote and registry, and no deletes or every-ref pushes the old step didn't make.
    if (b.flatMap(flagsOf).some((f) => WIDE_FLAG.test(f) && !hadFlags.has(f))) return false;
    if (b.some((w) => /^\+?:./.test(w) && !a.includes(w))) return false;
    const hosts = new Set(a.map(hostOf).filter(Boolean));
    if (b.some((w) => { const h = hostOf(w); return h !== null && !hosts.has(h); })) return false;
    if (pushRemote(a) !== pushRemote(b)) return false;
    const hadBranches = new Set(a.map(branchOf).filter(Boolean));
    return !b.some((w) => {
      const br = branchOf(w);
      return br !== null && !hadBranches.has(br);
    });
  } catch {
    return false;
  }
}
