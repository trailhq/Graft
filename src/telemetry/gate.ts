/**
 * The single "may we send?" predicate, checked before every append and again
 * before every send.
 *
 * Four independent gates, in the order a user would expect them to win:
 *
 *   1. A key at all — dev builds and forks have none (see key.ts), so the whole
 *      subsystem is inert for anyone who did not install a published graft.
 *   2. `DO_NOT_TRACK` — the cross-tool convention (consoledonottrack.com).
 *      Honoured unconditionally: it outranks our own setting, because a user who
 *      set it machine-wide has already answered the question for every tool.
 *   3. CI — a build server is not a user. Counting it would inflate every number
 *      we care about and tell us nothing about a person.
 *   4. The user's own choice, from the `graft init` picker or
 *      `graft telemetry disable`. Default on when never set.
 *
 * Re-checked at every append rather than cached at boot, so `graft telemetry
 * disable` in one terminal takes effect in a long-lived MCP server in another
 * without a restart.
 */
import { posthogKey } from './key.js';
import { readState } from './identity.js';

export type OffReason = 'no-key' | 'do-not-track' | 'ci' | 'disabled';

/** The `DO_NOT_TRACK` convention: set and not `0`/empty means "off". */
export function doNotTrack(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.DO_NOT_TRACK;
  return v !== undefined && v !== '' && v !== '0';
}

/**
 * CI detection. `CI` covers essentially every provider; the rest are the ones
 * that historically did not set it. Deliberately generous — a false positive
 * costs one uncounted user, a false negative pollutes the dataset.
 */
export function inCi(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false') return true;
  return Boolean(
    env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE || env.CIRCLECI ||
    env.TEAMCITY_VERSION || env.JENKINS_URL || env.TF_BUILD || env.BUILD_NUMBER,
  );
}

/** Null when telemetry may run, otherwise the first gate that closed. */
export function offReason(home?: string, env: NodeJS.ProcessEnv = process.env): OffReason | null {
  if (!posthogKey()) return 'no-key';
  if (doNotTrack(env)) return 'do-not-track';
  if (inCi(env)) return 'ci';
  if (readState(home)?.enabled === false) return 'disabled';
  return null;
}

export function telemetryOn(home?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return offReason(home, env) === null;
}

/** One line for `graft telemetry status`, naming the gate that is closed so a
 *  user who thinks they disabled it can see which switch actually took. */
export function explainOff(reason: OffReason): string {
  switch (reason) {
    case 'no-key':        return 'off — this build has no telemetry key (a fork, or a local `npm run build`); nothing can be sent';
    case 'do-not-track':  return 'off — DO_NOT_TRACK is set in this environment';
    case 'ci':            return 'off — this looks like CI';
    case 'disabled':      return 'off — you disabled it (`graft telemetry enable` to turn it back on)';
  }
}
