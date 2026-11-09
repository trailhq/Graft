/**
 * Phase 2's journeys through the real hooks (c8): builders on top of
 * claude-skills-journey-fixtures.ts. Made-up acme/shop and acme-cli only.
 * Not a test file itself.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRuns, at, cli, finish, one, promptHook, session, skillsKept, type Box, type Session,
} from './claude-skills-journey-fixtures.js';
import { cliUpdate } from '../src/skills/update-gate.js';

export const ctxOf = (out: Record<string, any> | null): string => out?.hookSpecificOutput?.additionalContext ?? '';
export const blockOf = (out: Record<string, any> | null): string => (out?.decision === 'block' ? String(out.reason ?? '') : '');

export const envOf = (b: Box, nowIso: string): NodeJS.ProcessEnv =>
  ({ PATH: process.env.PATH, HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: nowIso, ...b.env });

/** The release steps before the publish (a skill long enough that a one-step fold passes the size gate, 4.3). */
export const PREP = ['npm ci', 'npm run lint', 'npm test', 'npm run build'];
const PREP_OUT: Record<string, string> = { 'npm ci': 'added 212 packages in 3s', 'npm run lint': 'no problems', 'npm test': 'Tests: 12 passed, 12 total', 'npm run build': 'built in 2.1s' };
export const publishOf = (v: string) => `npm publish acme-cli-${v}.tgz --access public`;

/** A release: the prep steps, `publish` (default: the kept one), then npm shows the version. `ask`: the prompt. */
export async function release5(s: Session, day: number, v: string, o: { ask?: string; publish?: Array<{ cmd: string; fail?: boolean }>; skip?: string[] } = {}): Promise<void> {
  await promptHook(s, at(day, 0), o.ask ?? `publish ${v}`);
  let t = 5;
  for (const p of PREP) {
    if (o.skip?.includes(p)) continue;
    await agentRuns(s, at(day, (t += 2)), p, () => ({ out: PREP_OUT[p]! }));
  }
  for (const p of o.publish ?? [{ cmd: publishOf(v) }]) {
    await agentRuns(s, at(day, (t += 2)), p.cmd, () => (p.fail ? { out: 'Exit code 1\nnpm error code E404\nnpm error 404 no such file', failed: true } : { out: `+ acme-cli@${v}` }));
  }
  await agentRuns(s, at(day, 30), 'npm view acme-cli version', () => ({ out: v }));
}

/** release-npm kept through "save this as a skill" on `day` (a candidate, v1). */
export async function kept(b: Box, day = 20, version = '1.4.0'): Promise<string> {
  const s = session(b);
  await release5(s, day, version);
  await finish(s, day, `Published ${version}.`);
  const [, name, runId] = /trail skills add (\S+) --run (\S+)\./.exec(ctxOf(one(await promptHook(s, at(day, 60), 'save this as a skill')))) ?? [];
  const command = `trail skills add ${name} --run ${runId}`;
  await agentRuns(s, at(day, 70), command, cli(b, at(day, 70), command));
  assert.deepEqual(skillsKept(b), [name]);
  return name!;
}

/** The two lines of a Stop block's offer: the two lines right after "with these 2 lines, ...:". */
export function offerLinesIn(block: string): [string, string] {
  const m = /:\n([^\n]+)\n([^\n]+)\n/.exec(block);
  assert.ok(m, `no offer lines in: ${block}`);
  return [m![1]!, m![2]!];
}

/** The offer id a yes directive names in its update command. */
export function updateCommandIn(text: string): string {
  const m = /Run: (trail skills update [a-z0-9-]+ --offer o-[0-9a-f]{6})\./.exec(text);
  assert.ok(m, `no update command in: ${text}`);
  return m![1]!;
}

/** `trail skills update` as the agent's shell runs it: c2's CLI half. */
export function cliUpd(b: Box, nowIso: string, command: string, sink?: { lines: string[]; code: number; proposal?: boolean }) {
  return () => {
    const m = /skills update (\S+) --offer (\S+)/.exec(command)!;
    const r = cliUpdate(m[1]!, m[2]!, envOf(b, nowIso), new Date(Date.parse(nowIso) + 1000));
    if (sink) Object.assign(sink, { lines: r.lines, code: r.code, proposal: r.proposal });
    return { out: r.lines.join('\n'), failed: r.code !== 0 };
  };
}

/** Telemetry the hooks queued for this box (GRAFT_POSTHOG_KEY set, DO_NOT_TRACK off, the queue in the box's home). */
export const TELEMETRY_ENV = { GRAFT_POSTHOG_KEY: 'phc_test_key', GRAFT_POSTHOG_HOST: 'http://127.0.0.1:9', DO_NOT_TRACK: '0' };
export function queued(b: Box): Array<[string, Record<string, string>]> {
  try {
    return readFileSync(join(b.home, '.graft', 'telemetry-queue.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).map((e) => [String(e.event), e.properties as Record<string, string>]);
  } catch {
    return [];
  }
}
const KEYS = ['moment', 'answer', 'op', 'channel', 'outcome', 'reason', 'from', 'scope'];
/** Only the skills events, with their closed values (the hooks also queue hook_ms and the common properties). */
export const skillsEvents = (b: Box) => queued(b).filter(([e]) => /^skill_/.test(e))
  .map(([e, p]) => `${e}:${KEYS.filter((k) => typeof p[k] === 'string').map((k) => p[k]).join(',')}`);

export type { Box, Session };
