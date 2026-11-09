/**
 * Shared pieces of the b7 review's hook tests (not a test file itself): the
 * J06 day, the asked release-npm save, the ~/.claude copy registered beside
 * the repo's, one whole turn of hooks, and the one-object check.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRuns, at, calling, cli, finish, one, postBashFailHook, preBashHook, promptHook, release, reply, resultOf, session, skillsKept, startHook, stopHook,
  type Box, type Session,
} from './claude-skills-journey-fixtures.js';
import { readInitRecord } from '../src/init/init-record.js';
import { writeLesson } from '../src/skills/lessons.js';

export const readInitRecordOf = (b: Box) => readInitRecord('github.com/acme/shop', { TRAIL_HOME: b.trail });
export const ctxOf = (out: string) => String(one(out)?.hookSpecificOutput?.additionalContext ?? '');
export const startContext = async (s: Session, iso: string, source = 'startup') => ctxOf(await startHook(s, iso, source));

/** release-npm kept on Oct 20 the asked way ("save this as a skill"), as J07 starts. */
export async function releaseKept(b: Box): Promise<string> {
  const s0 = session(b);
  await release(s0, 20, '1.4.0');
  await finish(s0, 20, 'Published 1.4.0.');
  const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctxOf(await promptHook(s0, at(20, 60), 'save this as a skill'))) ?? [];
  const add = `trail skills add ${name} --run ${runId}`;
  await agentRuns(s0, at(20, 70), add, cli(b, at(20, 70), add));
  assert.deepEqual(skillsKept(b), [name]);
  return name!;
}

/** One release from the skill's block, then the person's correction and the fix. */
export async function correctedRelease(b: Box, name: string, day: number, version: string): Promise<Session> {
  const s = session(b);
  assert.match(ctxOf(await promptHook(s, at(day, 0), `publish ${version}`)), new RegExp(`^\\[trail\\] Skill ${name} fits`));
  await agentRuns(s, at(day, 10), 'npm run build', () => ({ out: 'built' }));
  await agentRuns(s, at(day, 20), `npm publish acme-cli-${version}.tgz --access public`, () => ({ out: `+ acme-cli@${version}` }));
  await agentRuns(s, at(day, 30), 'npm view acme-cli version', () => ({ out: version }));
  await finish(s, day, `Published ${version}.\nUsed skill ${name}`);
  await promptHook(s, at(day, 60), "no, it didn't push the tag");
  await agentRuns(s, at(day, 70), 'git push origin --tags', () => ({ out: `To github.com:acme/shop.git\n * [new tag]         v${version} -> v${version}` }));
  await finish(s, day, 'Pushed the tag.', 80);
  return s;
}

/** The quoted line a directive asks the agent to say: what sits between the first `: "` and the last `"`. */
export const saidQuote = (context: string, lead: RegExp) => {
  const line = context.split('\n').find((l) => lead.test(l)) ?? '';
  return line.slice(line.indexOf(': "') + 3, line.lastIndexOf('"'));
};

/** The ~/.claude copy registered for `events` too (Claude Code then runs both): its shim finds the package. */
export function globalCopy(b: Box, events: Record<string, string>): string {
  const helpers = join(b.home, '.claude', 'helpers');
  mkdirSync(helpers, { recursive: true });
  const shim = join(helpers, 'trail-hooks.cjs');
  writeFileSync(shim, '// finds @trailhq/trail-code\n');
  const hooks: Record<string, unknown> = {};
  for (const [hostEvent, ours] of Object.entries(events)) hooks[hostEvent] = [{ matcher: hostEvent === 'SessionStart' ? '' : 'Bash', hooks: [{ type: 'command', command: `node "${shim}" ${ours} || exit 0`, timeout: 5 }] }];
  writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  return shim;
}

/** Each hook wrote nothing or exactly one JSON object (1a's guarantee), and nothing threw. */
export function oneOrNothing(out: string, what: string): Record<string, any> | null {
  if (out === '') return null;
  try {
    return JSON.parse(out);
  } catch {
    assert.fail(`${what}: not one JSON object: ${out.slice(0, 300)}`);
  }
}

/** Start, prompt, a timeout command, a failed command on a known wall, Stop: every hook of a turn, in order. */
export async function wholeTurn(b: Box, day: number, label: string): Promise<void> {
  const s = session(b);
  oneOrNothing(await startHook(s, at(day, 0)), `${label} start`);
  oneOrNothing(await promptHook(s, at(day, 5), 'run the integration tests'), `${label} prompt`);
  const t = calling(s, at(day, 10), 'timeout 60 npm test');
  const pre = oneOrNothing(await preBashHook(s, at(day, 10), 'timeout 60 npm test', t), `${label} pre-bash`);
  resultOf(s, at(day, 10), t, pre ? 'denied' : 'Tests: 12 passed', !!pre);
  const GO = 'go test -tags integration ./...';
  const ERR = 'Exit code 1\npanic: rootless Docker not found [recovered]\nFAIL';
  const id = calling(s, at(day, 20), GO);
  resultOf(s, at(day, 20), id, ERR, true);
  oneOrNothing(await postBashFailHook(s, at(day, 21), GO, id, ERR), `${label} post-bash-fail`);
  reply(s, at(day, 30), 'Docker is not running.');
  oneOrNothing(await stopHook(s, at(day, 31), 'Docker is not running.'), `${label} stop`);
}

export const DOCKER_ERR = 'Exit code 1\n--- FAIL: TestOrders (0.01s)\npanic: rootless Docker not found [recovered]\nFAIL\tacme/shop/orders\t0.412s';
export const GO_TEST = 'go test -tags integration ./...';
export const FIXED = 'DOCKER_HOST=unix://$HOME/.colima/default/docker.sock go test -tags integration ./...';

/** One J06 day: the docker wall, then the same command with Colima's socket passes; what Stop answered. */
export async function dockerDay(s: Session, day: number): Promise<Record<string, any> | null> {
  await promptHook(s, at(day, 0), 'run the integration tests');
  await agentRuns(s, at(day, 10), GO_TEST, () => ({ out: DOCKER_ERR, failed: true }));
  await agentRuns(s, at(day, 20), FIXED, () => ({ out: 'ok  \tacme/shop/orders\t0.512s' }));
  return finish(s, day, 'Tests pass.');
}

export function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** A kept wall lesson (every repo, the way a moment-3 yes keeps one), its id. */
export function wallLessonKept(b: Box, wall: 'docker-rootless', text: string): string {
  const path = writeLesson({ id: '', skill: null, at: '2026-10-01', text, kind: 'lesson', src: 'repair', wall }, 'github.com/acme/shop', { TRAIL_HOME: b.trail });
  return /^id: "?(l-[0-9a-f]+)"?$/m.exec(readFileSync(path, 'utf8'))![1]!;
}

