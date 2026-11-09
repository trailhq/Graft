/**
 * Phase 2's CLI bodies (design 1.2, 3.6), beside `cli-skills.ts`, which
 * registers them and prints:
 *  - `trail skills update <name> --offer <id>`: the CLI half of the update
 *    gate (`cliUpdate`); `skill_changed{op}` on a write.
 *  - `trail skills restore <name> --version <n>`: an older version back as a
 *    new one, the person's only (P28: `personAtTerminal` here, the agent
 *    guard before it).
 *  - `trail skills draft <run-id> --print` for a run whose change is offered:
 *    the change as a diff (4.7 "show me"). Writes nothing.
 *  - the versions a skill keeps, for `trail skills show`.
 *
 * Root `--version` (the CLI's own) would take `restore --version <n>`
 * before the subcommand saw it, so `cli-skills.ts` lifts that flag out of
 * argv for the restore (`liftRestoreVersion`) before commander parses.
 */
import { flatLine } from '../notes/flatten.js';
import { readRunSheet } from '../trace/runs.js';
import type { PersonCheck } from './person.js';
import type { SkillRef } from './types.js';
import { getSkillState } from './state.js';
import { listAllPersonal } from './store.js';
import { printDiff } from './skill-diff.js';
import { listVersions, restoreVersion } from './versions.js';
import { cliUpdate, replan } from './update-gate.js';
import { sessionOf } from './update-plan.js';

/** What a phase 2 command body needs of `cli-skills.ts`'s io (it fits structurally). */
export interface CliCtx {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  person: () => PersonCheck;
  track: (event: string, props: Record<string, string>) => void;
  out: (l: string) => void;
  err: (l: string) => void;
}

const one = (t: string, max = 60) => flatLine(t, max);
const personOnly = (command: string) => `Only the person can run this, in their own terminal: trail ${command}`;

/** `trail skills update <name> --offer <id>`: the exit code, after printing what `cliUpdate` returns. */
export function updateCommand(name: string, opts: { offer?: string }, x: CliCtx): number {
  if (!opts.offer) {
    x.err('✗ trail skills update takes the offer it answers: trail skills update <name> --offer <id>');
    return 1;
  }
  const r = cliUpdate(name, opts.offer, x.env, x.now());
  for (const l of r.lines) (r.code === 0 ? x.out : x.err)(l);
  // A proposal changes no file Trail reads; adopting it later is its own `skill_changed{adopted}`.
  if (r.code === 0 && r.op && !r.proposal) x.track('skill_changed', { op: r.op });
  return r.code;
}

/** 4.12: `trail skills restore <name> --version <n>`, the person only. */
export function restoreVersionCommand(name: string, version: string, x: CliCtx): number {
  const v = String(version ?? '');
  const command = `skills restore ${one(name)} --version ${/^[1-9]\d{0,5}$/.test(v) ? v : '<n>'}`;
  if (!x.person().ok) {
    x.err(personOnly(command));
    return 1;
  }
  if (!/^[1-9]\d{0,5}$/.test(v)) {
    x.err('✗ --version takes a version number: trail skills restore <name> --version <n>');
    return 1;
  }
  const ref = listAllPersonal(x.env).find((r) => r.name === name);
  if (!ref) {
    x.err(`✗ no skill called ${one(name)} · trail skills lists them`);
    return 1;
  }
  const r = restoreVersion(ref, Number(v), x.env, x.now());
  if (!r.ok) {
    x.err(r.why === 'unknown' ? `✗ ${one(name)} keeps no v${v} · see what it keeps: trail skills show ${one(name)}`
      : r.why === 'busy' ? '✗ the skill store is busy (another trail command is changing it). Try again.'
        : r.why === 'link' ? `✗ ${one(name)}'s folder in Trail's home is a link, so Trail won't write through it`
          : `✗ Trail couldn't bring back v${v} of ${one(name)}; it is as it was`);
    return 1;
  }
  x.out(`✓ ${one(name)} has v${v}'s steps again, as v${r.version} · go back: trail skills restore ${one(name)} --version ${r.version - 1}`);
  x.track('skill_changed', { op: 'restore-version' });
  return 0;
}

/**
 * 4.7 "show me": for a run whose change Trail offered (the pending update or drift offer of the run's session), the
 * change as a diff of the file as it is now. null for any other run: `draft` prints 1a's draft (a split's new skill
 * is one).
 */
export function draftFoldText(runId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const sheet = readRunSheet(runId, env);
    const st = sheet ? sessionOf(sheet, env) : null;
    const po = st?.pendingOffer;
    if (!sheet || !po || po.runId !== runId || (po.moment !== 'update' && po.moment !== 'drift') || !po.fold || po.fold.op === 'split') return null;
    const r = replan(po.fold.skillId, runId, po.fold.op, env, { st });
    if (!r) return null;
    const diff = printDiff(r.current, r.text, [`${po.name}/SKILL.md now`, `${po.name}/SKILL.md v${r.next.meta.version}`]);
    return diff || null;
  } catch {
    return null;
  }
}

/** For `trail skills show`: the versions kept and a change waiting beside a hand-edited file; null when neither. */
export function versionsLine(ref: SkillRef, env: NodeJS.ProcessEnv = process.env): string | null {
  const kept = listVersions(ref);
  const proposed = getSkillState(ref.id, env)?.proposed;
  const parts: string[] = [];
  if (kept.length) parts.push(`older versions kept: ${kept.map((v) => `v${v}`).join(', ')}; bring one back in your own terminal: trail skills restore ${one(ref.name)} --version <n>`);
  if (proposed && typeof proposed.version === 'number') parts.push(`a change waits beside your edited file in .versions/proposed-v${proposed.version}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The CLI's own `-v, --version` is read anywhere on the command line, so it would print Trail's version for
 * `trail skills restore <name> --version <n>`. For that one command the flag is taken out of argv before commander
 * parses, and its value handed to the restore. `{ argv }` alone for any other command.
 */
export function liftRestoreVersion(argv: readonly string[]): { argv: string[]; version?: string } {
  const a = [...argv];
  const s = a.indexOf('skills');
  if (s < 0 || a[s + 1] !== 'restore') return { argv: a };
  for (let i = s + 2; i < a.length; i++) {
    if (a[i] === '--') break;
    if (a[i] === '--version') {
      const v = a[i + 1] ?? '';
      a.splice(i, v && !v.startsWith('-') ? 2 : 1);
      return { argv: a, version: v.startsWith('-') ? '' : v };
    }
    if (a[i]!.startsWith('--version=')) {
      const v = a[i]!.slice('--version='.length);
      a.splice(i, 1);
      return { argv: a, version: v };
    }
  }
  return { argv: a };
}
