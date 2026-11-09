/**
 * D99: in a lab home (`$HOME/.trail-lab` plus TRAIL_LAB_INTERACTIVE=1, D26) a
 * headless run's prompts (`entrypoint: sdk-cli`, what `claude -p` writes) are
 * the person's, so an asked save can go live headless. Anywhere else an sdk
 * row is never typed, as in phase 0. Made-up repos and prompts only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTypedByPerson, readNewEvents, typedText } from '../src/trace/claude.js';
import { typedPrompt, typedSha } from '../src/trace/typed.js';
import { jsonl, typed } from './trace-fixtures.js';
import {
  agentRuns, at, box, cli, done, heldKept, lastCli, one, promptHook, release, reply, session, skillsKept, startHook, stopHook,
} from './claude-skills-journey-fixtures.js';

/** A person home and a Trail home of its own; `marker` writes `$HOME/.trail-lab`, `on` sets the switch. */
function homeEnv(marker: boolean, on: boolean): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'trail-d99-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  if (marker) writeFileSync(join(home, '.trail-lab'), '');
  const env: NodeJS.ProcessEnv = { HOME: home, TRAIL_HOME: join(root, 'trail-home'), ...(on ? { TRAIL_LAB_INTERACTIVE: '1' } : {}) };
  return { env, root };
}

const SDK_ROW = () => typed('pull and publish 2.0.1', { entrypoint: 'sdk-cli', promptSource: 'sdk' });

test('an sdk-cli row is not typed with the switch but no marker, with the marker but no switch, or in a normal home', () => {
  for (const [marker, on, what] of [[false, true, 'switch, no marker'], [true, false, 'marker, no switch'], [false, false, 'a normal home']] as const) {
    const { env, root } = homeEnv(marker, on);
    try {
      assert.equal(typedText(SDK_ROW(), env), '', what);
      assert.equal(isTypedByPerson(SDK_ROW(), env), false, what);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // The default env is this process's, which is no lab home.
  assert.equal(isTypedByPerson(SDK_ROW()), false);
});

test('an sdk-cli row is typed in a lab home with the switch; flags and wrappers still decide', () => {
  const { env, root } = homeEnv(true, true);
  try {
    assert.equal(typedText(SDK_ROW(), env), 'pull and publish 2.0.1');
    assert.equal(isTypedByPerson(SDK_ROW(), env), true);
    assert.equal(isTypedByPerson(typed('a summary', { entrypoint: 'sdk-cli', isCompactSummary: true }), env), false);
    assert.equal(isTypedByPerson(typed('anything', { entrypoint: 'sdk-ts', origin: { kind: 'channel' } }), env), false);
    assert.equal(isTypedByPerson(typed('<command-name>/plan</command-name>', { entrypoint: 'sdk-cli' }), env), false);
    // The event stream reads it with the env it is given.
    const tx = join(root, 't.jsonl');
    writeFileSync(tx, jsonl([SDK_ROW()]));
    assert.deepEqual(readNewEvents(tx, join(root, 'c1.json'), { env }).filter((e) => e.kind === 'typed').map((e) => (e as { text: string }).text), ['pull and publish 2.0.1']);
    assert.deepEqual(readNewEvents(tx, join(root, 'c2.json')).filter((e) => e.kind === 'typed'), [], 'without the lab env: not typed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the typed hash of a lab sdk row is the one the prompt hook takes from its payload', () => {
  const { env, root } = homeEnv(true, true);
  try {
    for (const words of ['save this as a skill', '  save   this as a skill\n', 'pull and publish 2.0.1']) {
      const row = typed(words, { entrypoint: 'sdk-cli', promptSource: 'sdk' });
      assert.equal(typedSha(typedText(row, env)), typedSha(typedPrompt(words)!), JSON.stringify(words));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const HEADLESS = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };

/** A release, then "save this as a skill" and the agent's add, in a headless-shaped transcript. */
async function askedSave(b: ReturnType<typeof box>, cliEnv: Record<string, string>): Promise<{ name: string | null; denied: boolean }> {
  const s = session(b);
  await startHook(s, at(27, 0));
  await release(s, 27, '1.4.3');
  reply(s, at(27, 40), 'Published 1.4.3: npm shows it.');
  await stopHook(s, at(27, 41), 'Published 1.4.3: npm shows it.');
  const asked = one(await promptHook(s, at(27, 60), 'save this as a skill'));
  const m = /trail skills add ([a-z0-9-]+) --run (r-\d{4}-[0-9a-f]+)/.exec(asked?.hookSpecificOutput?.additionalContext ?? '');
  if (!m) return { name: null, denied: false };
  const cmd = `trail skills add ${m[1]} --run ${m[2]}`;
  const add = await agentRuns(s, at(27, 70), cmd, cli(b, at(27, 70), cmd, cliEnv));
  return { name: m[1]!, denied: add.decision?.hookSpecificOutput?.permissionDecision === 'deny' };
}

test('end to end: an asked save in a headless transcript (sdk-cli) saves in a lab home', async () => {
  const lab = { ...HEADLESS, TRAIL_LAB_INTERACTIVE: '1' };
  const b = box('d99-lab', { env: lab, row: { entrypoint: 'sdk-cli', promptSource: 'sdk' } });
  try {
    writeFileSync(join(b.home, '.trail-lab'), '');
    const r = await askedSave(b, lab);
    assert.ok(r.name, 'the prompt hook gave the add directive');
    assert.equal(r.denied, false);
    assert.equal(lastCli()?.exit, 0, lastCli()?.lines.join('\n'));
    assert.deepEqual(lastCli()?.saved, { from: 'asked', scope: 'personal' });
    assert.deepEqual(skillsKept(b), [r.name]);
    assert.deepEqual(heldKept(b), []);
  } finally {
    done(b);
  }
});

test('end to end: the same headless transcript is held, never live, outside a lab home', async () => {
  // The hooks run interactive (so the gate is on), but the transcript's rows are sdk-cli: no line is the person's.
  for (const [marker, on, what] of [[false, false, 'a normal home'], [false, true, 'switch, no marker'], [true, false, 'marker, no switch']] as const) {
    const env: Record<string, string> = { CLAUDE_CODE_ENTRYPOINT: 'cli', ...(on ? { TRAIL_LAB_INTERACTIVE: '1' } : {}) };
    const b = box(`d99-${marker}-${on}`, { env, row: { entrypoint: 'sdk-cli', promptSource: 'sdk' } });
    try {
      if (marker) writeFileSync(join(b.home, '.trail-lab'), '');
      const r = await askedSave(b, env);
      assert.ok(r.name, `${what}: the prompt hook still reads its own payload`);
      assert.deepEqual(skillsKept(b), [], `${what}: nothing live`);
      assert.deepEqual(heldKept(b), [r.name], `${what}: held for the person`);
    } finally {
      done(b);
    }
  }
  // Headless and no lab home: no person, nothing kept at all.
  const b = box('d99-headless', { env: HEADLESS, row: { entrypoint: 'sdk-cli' } });
  try {
    const r = await askedSave(b, HEADLESS);
    assert.equal(r.name, null, 'no directive in a headless session');
    assert.deepEqual(skillsKept(b), []);
    assert.deepEqual(heldKept(b), []);
  } finally {
    done(b);
  }
});
