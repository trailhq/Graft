/**
 * Before `git commit`, `git push` or `gh pr create`: `trail check` on the
 * branch, so the agent doesn't have to remember to run it. For now a conflict
 * with a learning is a warning: the command runs, and the agent reads what the
 * check found, once per set of conflicts. With SHIP_CHECK_STOPS on, it stops
 * the command once instead: the agent fixes the change, or says why it's right
 * in the commit message or PR and runs the same command again, which goes
 * through. Loaded by pre-bash.ts only for those commands.
 *
 * Bounded by CHECK_BUDGET_MS, well inside the 5 s the hook is given, and fails
 * open: a check that is slow, broken or has nothing to say lets the command run.
 * Like the rest of the PreToolUse path it loads only builtins and small files:
 * the check runs in a child, and the mark that lets the second try through is
 * a file beside the session's gate file.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brand, repoWiredForTrail } from '../brand.js';
import { sessionPath } from '../trace/gate-file.js';
import type { PreBashDecision } from './pre-bash.js';

/** One conflict as `trail check --json` reports it (check/types.ts CheckFinding, the fields used here). */
export interface ShipConflict {
  file: string;
  line?: number;
  verdict: string;
  summary: string;
  source: { title?: string; author?: string; path?: string };
}

/** How long the check may take before the command runs without it. */
export const CHECK_BUDGET_MS = 3500;

/**
 * Whether a conflict stops the command (once) or only warns. Off until
 * `trail check`'s matching improves: it still flags word matches as conflicts
 * (4 on PR #706, none real), and a stop on each of those costs a real commit.
 */
export const SHIP_CHECK_STOPS = false;

/** What the commit check says before a commit, push or PR: stop it once, or let it run with a warning the agent reads. */
export type ShipDecision = PreBashDecision | { warn: string };

/** The words the reason starts with, which the Stop hook's `overrode` sign looks for (note-signals.ts). */
export const SHIP_CHECK_LEAD = 'trail check found';

/** The conflicts `trail check --json` reports for the branch at `dir`, or null when it couldn't say in time. */
export function branchConflicts(dir: string, env: NodeJS.ProcessEnv = process.env): ShipConflict[] | null {
  try {
    // dist/cli.js beside this file's folder (paths.ts graftCliPath, without loading it here).
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
    const r = spawnSync(process.execPath, [cli, 'check', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: CHECK_BUDGET_MS,
      // No fetch inside a hook, no hooks of its own, and the trail command whatever name ran this.
      env: { ...env, TRAIL_NO_FETCH: '1', TRAIL_NO_HOOKS: '1', TRAIL_INVOKED_AS: 'trail' },
      windowsHide: true,
    });
    if (r.error || typeof r.stdout !== 'string' || !r.stdout.trim().startsWith('{')) return null;
    const out = JSON.parse(r.stdout) as { findings?: ShipConflict[] };
    return (out.findings ?? []).filter((f) => f.verdict === 'conflict');
  } catch {
    return null;
  }
}

/** What the command is about to do, in the reason's words. */
function shipping(command: string): string {
  return /\bgh\s+pr\s+create\b/.test(command) ? 'opening this PR' : /\bgit\s+push\b/.test(command) ? 'this push' : 'this commit';
}

/** The reason the agent reads: each conflict, then the way through (a stop) or what to do next (a warning). */
export function shipReason(conflicts: ShipConflict[], command: string, stops = SHIP_CHECK_STOPS): string {
  const one = conflicts.length === 1;
  const lines = conflicts.slice(0, 5).map((f) => {
    const who = [f.source.title, f.source.author].filter(Boolean).join(', ');
    return `- ${f.file}${f.line ? `:${f.line}` : ''}: ${f.summary}${who ? ` (${who})` : ''}`;
  });
  const old = conflicts.map((f) => f.source.path).find(Boolean);
  const replaces = old ? ` If the learning no longer holds, save a new learning that says what changed, with \`--replaces ${old.split('/').pop()}\`.` : '';
  return [
    `${SHIP_CHECK_LEAD} ${conflicts.length} conflict${one ? '' : 's'} with the team's learnings before ${shipping(command)}:`,
    ...lines,
    stops
      ? `Fix the change, or if it's right anyway, say why in the commit message or PR description and run the same command again: it goes through then.${replaces}`
      : `It goes ahead; the check can flag a word match that isn't a real conflict. Read each one: if it's real, fix the change next and tell the user; if not, carry on.${replaces}`,
  ].join('\n');
}

/** The session a payload names, as a file name: Claude Code's `session_id`, else 'default' (hook-io.ts payloadSessionId, without its load cost). */
function sessionOf(input: unknown): string {
  const p = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const raw = [p.session_id, p.sessionId, p.conversation_id].find((v): v is string => typeof v === 'string' && v !== '');
  return raw && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(raw) ? raw : 'default';
}

/**
 * The decision for a commit, push or PR command, once per set of conflicts in
 * a session: a warning (or, with `stops`, a deny), null otherwise. `check` is
 * the branch's conflicts (tests pass a stand-in).
 */
export function shipCheck(input: unknown, dir: string, command: string, check: (dir: string) => ShipConflict[] | null = branchConflicts, env: NodeJS.ProcessEnv = process.env, stops = SHIP_CHECK_STOPS): ShipDecision | null {
  try {
    // Claude Code's hooks run with no TRAIL_INVOKED_AS, so the repo says whether it's trail's, as for every other hook.
    if (brand(env) !== 'trail' && !repoWiredForTrail(dir)) return null;
    const conflicts = check(dir);
    if (!conflicts?.length) return null;
    const key = createHash('sha256')
      .update(conflicts.map((f) => `${f.file}|${f.source.path ?? f.source.title ?? ''}`).sort().join('\n'))
      .digest('hex')
      .slice(0, 16);
    const mark = sessionPath(sessionOf(input), '.ship-checks.json', env);
    let seen: string[] = [];
    try {
      seen = JSON.parse(readFileSync(mark, 'utf8')) as string[];
    } catch {
      /* none yet */
    }
    if (seen.includes(key)) return null;
    mkdirSync(dirname(mark), { recursive: true });
    writeFileSync(mark, JSON.stringify([...seen, key].slice(-20)));
    const reason = shipReason(conflicts, command, stops);
    return stops ? { permissionDecision: 'deny', reason } : { warn: reason };
  } catch {
    return null;
  }
}
