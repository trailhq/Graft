/**
 * What a compiled skill's check shows (design 4.5 step 3), and D106: a check
 * whose shown fact is a version takes the `{version}` param the steps use.
 *
 * A check that reads a version (`npm view <pkg> version`, `git ls-remote
 * --tags`, a tag or release lookup, or any check that printed a version) can
 * only prove a release when it knows which version to expect. "Shows the new
 * version" can never be checked, so the run is never marked checked. The
 * version is a `{version}` param a step names (`npm version 1.4.0`), else,
 * for steps that bump or publish from package.json (`npm version patch`,
 * `npm publish`), package.json's version after the bump. With neither, no
 * step ties the check to this release and compile refuses (`no-check`).
 *
 * Pure: no files, no clock.
 */
import type { CheckFamily, RunCall } from '../trace/types.js';
import type { CompiledSkill, ParamDef } from './types.js';
import { pushShows } from './compile-words.js';

/** A tag or release lookup, anywhere in the check's command. */
const VERSION_LOOKUP = /\bgit\s+ls-remote\b[^;&|\n]*\s(?:--tags\b|refs\/tags\/|v?\d+\.\d+)|\bgh\s+release\s+(?:view|list)\b|\bgit\s+tag\s+(?:-l|--list|--points-at|--contains)\b|\bgit\s+describe\b[^;&|\n]*\s--tags\b/;
const BARE_VERSION = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/;
/** A bump that writes the next version into package.json, and a publish that reads it from there. */
const FROM_PACKAGE = /\b(?:npm|pnpm)\s+version\s+(?:major|minor|patch|premajor|preminor|prepatch|prerelease)\b|\byarn\s+version\s+--(?:major|minor|patch)\b|\b(?:npm|pnpm|yarn(?:\s+npm)?)\s+publish\b/;
const SAFE_DIR = /^[\w./@+-]*$/;

/** The version a check call printed: its CheckHit's, else an output that is one version alone. */
export function shownVersion(c: RunCall): string | undefined {
  return c.check?.facts.version ?? BARE_VERSION.exec(c.tail ?? '')?.[1];
}

/** A check whose shown fact is a version. Tests and pushes are steps that double as the check, never a version read. */
export function versionShaped(c: RunCall, fam: CheckFamily | null): boolean {
  if (fam === 'npm-view') return true;
  if (fam === 'tests' || fam === 'push' || c.tool) return false;
  return VERSION_LOOKUP.test(c.cmd ?? '') || shownVersion(c) !== undefined;
}

/**
 * The `{version}` param a version check shows, and the params with it. A version param the steps use, the one the
 * check printed first; else a step that bumps or publishes from package.json gives `{version}`, read from that
 * folder's package.json when the check runs (a `{version}` the check alone wrote takes that default). Null: no
 * step names or makes the version.
 */
export function versionTie(steps: Array<{ cmd: string; cwd: string | null }>, params: ParamDef[], shown: string | undefined): { name: string; params: ParamDef[] } | null {
  const used = params.filter((p) => p.shape === 'version' && steps.some((s) => s.cmd.includes(`{${p.name}}`)));
  if (used.length) return { name: (used.find((p) => shown !== undefined && p.seen.includes(shown)) ?? used[0]!).name, params };
  const from = steps.find((s) => FROM_PACKAGE.test(s.cmd));
  if (!from || !SAFE_DIR.test(from.cwd ?? '')) return null;
  const def = `$(node -p "require('./${from.cwd ? `${from.cwd.replace(/\/+$/, '')}/` : ''}package.json').version")`;
  const inCheck = params.find((p) => p.shape === 'version');
  if (inCheck) return { name: inCheck.name, params: params.map((p) => (p === inCheck ? { ...p, default: def } : p)) };
  return { name: 'version', params: [...params, { name: 'version', shape: 'version', default: def, seen: shown ? [shown] : [] }] };
}

/** Step 3: what the check shows. `version`: the tied param's name (D106). */
export function checkShowsFor(fam: CheckFamily | null, checkCall: RunCall | null, params: CompiledSkill['params'], version: string | null): string | null {
  if (!checkCall) return null;
  if (version) return `{${version}}`;
  const hasParam = (n: string) => params.some((p) => p.name === n);
  return ({
    'npm-view': hasParam('version') ? '{version}' : 'the new version',
    deploy: checkCall.check?.facts.state ?? 'success',
    'ls-remote': hasParam('sha') ? '{sha}' : 'the pushed commit',
    tests: 'the tests pass',
    query: 'rows come back',
    'gh-checks': 'all checks pass',
    push: pushShows(checkCall.check?.facts.branch, params),
  } as Record<CheckFamily, string>)[fam!] ?? null;
}
