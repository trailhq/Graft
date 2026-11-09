/**
 * Stop writes at most one JSON object, in every combination (design 3.5):
 * skills off or on, each offer channel, a Stop notice or not, an offer due
 * or not, a skill's use settled or not, and `stop_hook_active` first or
 * second. Never a block and a notice together, never a block in a turn a
 * block continued, never context on Stop. Made-up repo and prompts only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentRuns, at, box, cli, done, one, promptHook, release, reply, session, skillsKept, stateOf, stopHook, type Box, type Session,
} from './claude-skills-journey-fixtures.js';

/** Exactly one JSON object or nothing, and a well-formed Stop answer. */
function single(out: string, what: string): Record<string, any> | null {
  if (out === '') return null;
  const o = one(out); // throws on two objects or junk
  assert.equal(JSON.stringify(o), out.trim(), `${what}: one object`);
  assert.ok(!(o?.decision === 'block' && o?.systemMessage), `${what}: never a block and a notice`);
  assert.equal(o?.hookSpecificOutput, undefined, `${what}: no context on Stop`);
  if (o?.decision !== undefined) assert.equal(o.decision, 'block', what);
  return o;
}

async function stop(s: Session, day: number, sec: number, said: string, active: boolean, what: string) {
  reply(s, at(day, sec), said);
  return single(await stopHook(s, at(day, sec + 1), said, active), what);
}

type Scene = 'plain' | 'due' | 'credit';

/** Up to the Stop that matters: the 3rd costly day (`due`), a 1st day (`plain`), or a run from a kept skill (`credit`). */
async function scene(b: Box, sc: Scene, what: string): Promise<Session> {
  if (sc === 'credit') {
    const s = session(b);
    await release(s, 20, '1.4.0');
    await stop(s, 20, 40, 'Published 1.4.0.', false, what);
    const m = /trail skills add (\S+) --run (\S+)\./.exec(one(await promptHook(s, at(20, 60), 'save this as a skill'))?.hookSpecificOutput?.additionalContext ?? '');
    if (m) {
      const command = `trail skills add ${m[1]} --run ${m[2]}`;
      await agentRuns(s, at(20, 70), command, cli(b, at(20, 70), command));
    }
    const u = session(b);
    await release(u, 27, '1.4.3', { ask: 'publish 1.4.3' });
    return u;
  }
  if (sc === 'due') {
    for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2']] as const) {
      const s = session(b);
      await release(s, day, v, { failedFirst: true });
      await stop(s, day, 40, `Published ${v}.`, false, what);
    }
  }
  const s = session(b);
  await release(s, 27, '1.4.3');
  return s;
}

const CHANNELS = ['stop', 'notice', 'post-tool'] as const;

test('Stop answers with at most one object in every combination', async () => {
  let n = 0;
  for (const off of [false, true]) {
    for (const channel of CHANNELS) {
      for (const stopNotice of [false, true]) {
        for (const sc of ['plain', 'due', 'credit'] as const) {
          for (const activeFirst of sc === 'due' && channel === 'stop' && !off ? [false, true] : [false]) {
            const what = `skills ${off ? 'off' : 'on'}, ${channel}, stopNotice ${stopNotice}, ${sc}${activeFirst ? ', active first' : ''}`;
            const b = box(`one-${++n}`, { settings: off ? { skills: 'off' } : {}, env: { TRAIL_HOST_FACTS: JSON.stringify({ offerChannel: channel, stopNotice }) } });
            try {
              const s = await scene(b, sc, what);
              const said = 'Published 1.4.3: npm shows it.';
              const first = await stop(s, 27, 40, said, activeFirst, `${what}: 1st Stop`);
              if (off) assert.equal(first, null, `${what}: skills off says nothing`);
              if (activeFirst) assert.notEqual(first?.decision, 'block', `${what}: never a block under stop_hook_active`);
              const offer = off ? null : stateOf(s).pendingOffer;
              const lines = offer?.lines ?? [];
              const cont = lines.length ? `${said}\n\n${lines[0]}\n${lines[1]}` : said;
              const second = await stop(s, 27, 50, cont, !activeFirst, `${what}: 2nd Stop`);
              if (!activeFirst) assert.notEqual(second?.decision, 'block', `${what}: no second block in a continued turn`);
              if (first?.decision === 'block' && second?.decision === 'block') assert.fail(`${what}: two blocks`);
            } finally {
              done(b);
            }
          }
        }
      }
    }
  }
  assert.ok(n >= 37, `${n} combinations`);
});

test('the offer reaches the person once per channel: a block (stop), a notice (notice), or the reply (post-tool)', async () => {
  for (const channel of CHANNELS) {
    const b = box(`chan-${channel}`, { env: { TRAIL_HOST_FACTS: JSON.stringify({ offerChannel: channel }) } });
    try {
      const s = await scene(b, 'due', channel);
      const said = 'Published 1.4.3: npm shows it.';
      const pending = stateOf(s).pendingOffer;
      if (channel === 'post-tool') {
        assert.ok(pending && pending.shownAt === null, 'the passing check brought it, not shown yet');
        const out = await stop(s, 27, 40, `${said}\n\n${pending!.lines[0]}\n${pending!.lines[1]}`, false, channel);
        assert.equal(out, null);
        assert.ok(stateOf(s).pendingOffer?.shownAt, 'the reply ended with it: shown');
      } else {
        const out = await stop(s, 27, 40, said, false, channel);
        if (channel === 'stop') assert.equal(out?.decision, 'block');
        else assert.match(out?.systemMessage ?? '', /^trail: /);
      }
    } finally {
      done(b);
    }
  }
});

test('with a Stop notice, a run from a kept skill ends with the use line, and only that', async () => {
  const b = box('useline', { env: { TRAIL_HOST_FACTS: JSON.stringify({ stopNotice: true }) } });
  try {
    const s = await scene(b, 'credit', 'use line');
    assert.equal(skillsKept(b).length, 1);
    const out = await stop(s, 27, 40, 'Published 1.4.3.\nUsed skill release-npm', false, 'use line');
    assert.match(out?.systemMessage ?? '', /^trail: release-npm, \d+ commands, 0 failed \(by hand last time: \d+ commands, \d+ failed\)$/, JSON.stringify(out));
    assert.deepEqual(Object.keys(out ?? {}), ['systemMessage']);
  } finally {
    done(b);
  }
});
