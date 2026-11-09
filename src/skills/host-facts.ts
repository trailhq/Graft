/**
 * Every host behaviour the skills design switches on, in one place: where the
 * repeated-job offer goes, which notices reach the person, and when a
 * PreToolUse ask reaches them. The values come from `plans/host-checks.md`
 * and change only with a live check written up there.
 *
 * Test-only switches live here too, and are honoured only in a test home:
 * `$HOME/.trail-lab` exists (the lab's box writes it, D26) or TRAIL_HOME is a
 * folder other than `$HOME/.trail` (unit tests). Real homes have neither. And
 * never where Trail's files are the person's own `~/.trail` (the account's
 * home, whatever HOME says), however it is reached: a TRAIL_HOME naming it or
 * linking to it, or a marker someone put in the real HOME.
 *
 * The PreToolUse fast path imports this file, so it loads only node:path and
 * node:os; node:fs comes from `process.getBuiltinModule`, as pre-bash.ts does.
 */
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type * as Fs from 'node:fs';
import type { OfferChannel } from '../trace/types.js';
import type { Host, Tier } from '../trace/host.js';

export interface HostFacts {
  /** Where moment 2's offer goes (3.5): 'stop' = a Stop block whose reason the agent says;
   *  'notice' = a Stop systemMessage the person reads, no agent turn; 'post-tool' = the passing check's PostToolUse context. */
  offerChannel: OfferChannel;
  /** A Stop systemMessage reaches the person (needed for 'notice' and the use line). */
  stopNotice: boolean;
  /** A SessionStart systemMessage reaches the person (held notice). */
  startNotice: boolean;
  /** A UserPromptSubmit systemMessage reaches the person ("trail: using skill X"). */
  promptNotice: boolean;
  /** A UserPromptSubmit block shows its reason to the person and runs no model turn (bare "no"). */
  promptBlockShown: boolean;
  /** permission_mode values where a PreToolUse ask reaches the person, in an interactive entrypoint (D17). */
  askModes: string[];
  /** 1b (P23): a PostToolUseFailure additionalContext reaches the model. Default true until H3 says otherwise (H9 saw it arrive, D88). */
  failureContext: boolean;
  /** Phase 2 (2.10): a PostToolUse additionalContext reaches the model. Wall fixes on a passing call and the post-tool
   *  channel need it. Claude Code: yes (host-checks 4); Codex: no until HC1 says so. */
  postToolContext: boolean;
}

/** From plans/host-checks.md. A value changes only with a live check written up there (6.4). */
export const HOST_FACTS: HostFacts = Object.freeze({
  offerChannel: 'stop', stopNotice: false, startNotice: false, promptNotice: true,
  promptBlockShown: false, askModes: Object.freeze(['default', 'acceptEdits', 'plan']) as string[],
  failureContext: true, postToolContext: true,
} as HostFacts);

/**
 * Codex's (phase 2, 2.10). Every value is the safe one until its host check, written up in host-checks.md, says
 * otherwise: no ask (an `ask` from a Codex PreToolUse hook fails the hook run and the tool runs, D17), no
 * PostToolUse context until HC1, no notices until HC4.
 */
export const CODEX_FACTS: HostFacts = Object.freeze({
  offerChannel: 'stop', stopNotice: false, startNotice: false, promptNotice: false, promptBlockShown: false,
  askModes: Object.freeze([]) as unknown as string[], failureContext: false, postToolContext: false,
} as HostFacts);

const CHANNELS: ReadonlySet<string> = new Set(['stop', 'notice', 'post-tool']);
const FLAGS = ['stopNotice', 'startNotice', 'promptNotice', 'promptBlockShown', 'failureContext', 'postToolContext'] as const;

/** node:fs without an ESM import of it; null on a Node too old to hand it over. */
function nodeFs(): typeof Fs | null {
  return typeof process.getBuiltinModule === 'function' ? (process.getBuiltinModule('node:fs') as typeof Fs) : null;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** `$HOME/.trail-lab` exists. On a Node without getBuiltinModule nothing can say so: false. */
function labMarker(env: NodeJS.ProcessEnv): boolean {
  try {
    return nodeFs()?.existsSync(join(homeOf(env), '.trail-lab')) === true;
  } catch {
    return false;
  }
}

/** A path with its links followed, when it exists. */
function canonical(path: string): string {
  try {
    return nodeFs()?.realpathSync.native(path) ?? resolve(path);
  } catch {
    return resolve(path);
  }
}

/** Trail's files under this env are the account's own `~/.trail` (trailHome's rule, and the passwd home, not HOME). */
function personsOwn(env: NodeJS.ProcessEnv): boolean {
  let account: string;
  try {
    account = userInfo().homedir;
  } catch {
    account = homedir();
  }
  const used = env.TRAIL_HOME ? resolve(env.TRAIL_HOME) : join(homedir(), '.trail');
  return canonical(used) === canonical(join(account, '.trail'));
}

/**
 * $HOME/.trail-lab exists, or TRAIL_HOME is set to a folder other than $HOME/.trail (0 rule 10). Never
 * when Trail's files are the person's own ~/.trail.
 */
export function isTestHome(env: NodeJS.ProcessEnv = process.env): boolean {
  if (personsOwn(env)) return false;
  if (env.TRAIL_HOME && resolve(env.TRAIL_HOME) !== resolve(homeOf(env), '.trail')) return true;
  return labMarker(env);
}

/** TRAIL_LAB_INTERACTIVE=1 and $HOME/.trail-lab exists (D26), and not on the person's own ~/.trail. */
export function labInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRAIL_LAB_INTERACTIVE === '1' && labMarker(env) && !personsOwn(env);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Known fields of the right shape from `g`, over `base`. */
function merged(base: HostFacts, g: Record<string, unknown>): HostFacts {
  const out: HostFacts = { ...base, askModes: [...base.askModes] };
  if (typeof g.offerChannel === 'string' && CHANNELS.has(g.offerChannel)) out.offerChannel = g.offerChannel as OfferChannel;
  for (const k of FLAGS) if (typeof g[k] === 'boolean') out[k] = g[k] as boolean;
  if (Array.isArray(g.askModes) && g.askModes.every((m) => typeof m === 'string')) out.askModes = [...(g.askModes as string[])];
  return out;
}

/**
 * The facts for `host`: Codex's for 'codex', else Claude Code's (no host, as before phase 2, and every other host,
 * whose hooks don't run the skills code). In a test home only, TRAIL_HOST_FACTS (a JSON object) is merged in, keyed
 * by host (2.10): its `codex` object for Codex; for Claude its `claude` object when it has one, else the old flat
 * object. A `codex` key never reaches Claude's facts, nor a flat field Codex's. Always a copy.
 */
export function hostFacts(env: NodeJS.ProcessEnv = process.env, host?: Host): HostFacts {
  const base = host === 'codex' ? CODEX_FACTS : HOST_FACTS;
  const out: HostFacts = { ...base, askModes: [...base.askModes] };
  const raw = env.TRAIL_HOST_FACTS;
  if (!raw || !isTestHome(env)) return out;
  let given: unknown;
  try {
    given = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isObject(given)) return out;
  if (host === 'codex') return isObject(given.codex) ? merged(base, given.codex) : out;
  return merged(base, isObject(given.claude) ? given.claude : given);
}

/**
 * 4.18: the tier the skills code uses for `host`. Codex's is host.ts's CODEX_TIER, except that a test home may set
 * TRAIL_TIER_CODEX=A (the lab and c6 to c8 run the learning half on Codex before the flip). Every other host keeps
 * the tier it was detected with.
 */
export function hostTier(host: string, tier: Tier, env: NodeJS.ProcessEnv = process.env): Tier {
  return host === 'codex' && env.TRAIL_TIER_CODEX === 'A' && isTestHome(env) ? 'A' : tier;
}
