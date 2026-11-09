/**
 * D117 (3), J16 wins: outside a repo Trail knows (it has `.trail/`, or its key is in `~/.trail/repos/index.json`),
 * the global hooks keep no pool and make no offers; walls and guardrails still apply everywhere. Made-up repos only.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { readWalls } from '../src/trace/wall-state.js';
import { writeEveryRepo } from '../src/notes/every-repo.js';
import { guardrailLearning } from '../src/notes/guardrails.js';
import { repoKnown } from '../src/trace/known-repo.js';
import { poolPath } from '../src/trace/pool.js';
import {
  agentRuns, at, box, calling, done, finish, one, pathWithoutTimeout, postBashFailHook, promptHook, release, reply, resultOf, session, SHOP, startHook, stateOf, stopHook, timeoutSeen, type Box,
} from './claude-skills-journey-fixtures.js';
import { tmpRepo } from './helpers.js';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('repoKnown: a checkout with .trail/, or a key in the index (a root, an alias either side); nothing else', () => {
  const root = tmpRepo('known-1b');
  made.push(root);
  const env = { HOME: join(root, 'home'), TRAIL_HOME: join(root, 'trail-home') };
  const repo = join(root, 'repo');
  mkdirSync(join(env.TRAIL_HOME, 'repos'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  assert.equal(repoKnown('github.com/acme/plain', repo, env), false, 'no index, no .trail');
  assert.equal(repoKnown(null, '', env), false);
  writeFileSync(join(env.TRAIL_HOME, 'repos', 'index.json'), JSON.stringify({ aliases: { 'local/x': 'github.com/acme/aliased' }, roots: { '0f0f0f': 'github.com/acme/rooted' } }));
  assert.equal(repoKnown('github.com/acme/rooted', null, env), true, 'a root');
  assert.equal(repoKnown('github.com/acme/aliased', null, env), true, 'an alias target');
  assert.equal(repoKnown('local/x', null, env), true, 'an alias');
  assert.equal(repoKnown('github.com/acme/plain', repo, env), false);
  mkdirSync(join(repo, '.trail'));
  assert.equal(repoKnown('github.com/acme/plain', repo, env), true, '.trail/ in the checkout');
  rmSync(join(repo, '.trail'), { recursive: true });
  writeFileSync(join(repo, '.trail'), 'a file, not a folder');
  assert.equal(repoKnown('github.com/acme/plain', repo, env), false);
  // A home folder that is a work tree: its .trail is the Trail home itself, not a Trail checkout.
  const homeTree = join(root, 'dotfiles');
  mkdirSync(join(homeTree, '.git'), { recursive: true });
  symlinkSync(env.TRAIL_HOME, join(homeTree, '.trail'));
  assert.equal(repoKnown('local/dotfiles', homeTree, { ...env, TRAIL_HOME: join(homeTree, '.trail') }), false);
  writeFileSync(join(env.TRAIL_HOME, 'repos', 'index.json'), 'not json');
  assert.equal(repoKnown('github.com/acme/rooted', null, env), false, 'a broken index knows nothing');
});

/** A box whose index doesn't name the shop: a repo Trail never ran in, reached by its global hooks. */
function plainBox(tag: string): Box {
  const b = box(tag);
  writeFileSync(join(b.trail, 'repos', 'index.json'), JSON.stringify({ aliases: {}, roots: {} }));
  return b;
}

async function threeReleases(b: Box): Promise<Record<string, any> | null> {
  for (const [day, v] of [[25, '1.4.1'], [26, '1.4.2']] as const) {
    const s = session(b);
    await startHook(s, at(day, 0));
    await release(s, day, v, { failedFirst: true });
    reply(s, at(day, 40), `Published ${v}: npm shows it.`);
    await stopHook(s, at(day, 41), `Published ${v}: npm shows it.`);
  }
  const s = session(b);
  await startHook(s, at(27, 0));
  await release(s, 27, '1.4.3');
  reply(s, at(27, 40), 'Published 1.4.3: npm shows it.');
  const out = one(await stopHook(s, at(27, 41), 'Published 1.4.3: npm shows it.'));
  assert.equal(stateOf(s).runs.length > 0, true, 'the runs are still folded');
  return out;
}

test('J16 through the hooks: in a repo Trail never ran in, three releases keep no pool and make no offer', async () => {
  const b = plainBox('j16-plain');
  try {
    assert.equal(await threeReleases(b), null, 'no offer');
    assert.ok(!existsSync(poolPath(SHOP, { TRAIL_HOME: b.trail })), 'no pool for the plain repo');
  } finally {
    done(b);
  }
});

test('J16 control: the same days in a repo with .trail/ make the offer, and in one the index names', async () => {
  const b = plainBox('j16-dottrail');
  try {
    mkdirSync(join(b.repo, '.trail'));
    assert.equal((await threeReleases(b))?.decision, 'block');
    assert.ok(existsSync(poolPath(SHOP, { TRAIL_HOME: b.trail })));
  } finally {
    done(b);
  }
  const k = plainBox('j16-indexed');
  try {
    writeFileSync(join(k.trail, 'repos', 'index.json'), JSON.stringify({ aliases: {}, roots: { '1a2b3c': SHOP } }));
    assert.equal((await threeReleases(k))?.decision, 'block');
  } finally {
    done(k);
  }
});

const DOCKER_ERR = 'Exit code 1\n--- FAIL: TestOrders (0.01s)\npanic: rootless Docker not found [recovered]\nFAIL\tacme/shop/orders\t0.412s';
const GO_TEST = 'go test -tags integration ./...';
const FIXED = 'DOCKER_HOST=unix://$HOME/.colima/default/docker.sock go test -tags integration ./...';
/** A machine where Trail still finds a `timeout` (a system folder of 4.11, or Windows' System32) can't show a deny. */
const SYSTEM_TIMEOUT = timeoutSeen();

test('J16: walls and guardrails still apply in a repo Trail never ran in: the fix comes, the hit is noted, the deny holds; no repair offer', async () => {
  const b = plainBox('j16-walls');
  try {
    const bin = join(b.root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'colima'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'colima'), 0o755);
    b.env.PATH = `${bin}${delimiter}${pathWithoutTimeout()}`;
    for (const day of [10, 14]) {
      const s = session(b);
      await promptHook(s, at(day, 0), 'run the integration tests');
      const id = calling(s, at(day, 10), GO_TEST);
      resultOf(s, at(day, 10), id, DOCKER_ERR, true);
      const ctx = String(one(await postBashFailHook(s, at(day, 10), GO_TEST, id, DOCKER_ERR))?.hookSpecificOutput?.additionalContext ?? '');
      assert.match(ctx, /rootless Docker not found/, `day ${day}: the catalog's fix comes`);
      await agentRuns(s, at(day, 20), FIXED, () => ({ out: 'ok  \tacme/shop/orders\t0.512s' }));
      assert.equal(await finish(s, day, 'Tests pass.'), null, `day ${day}: no offer`);
    }
    assert.equal(readWalls({ TRAIL_HOME: b.trail }).classes['docker-rootless']?.seen.length, 2, 'the hits are noted (walls apply everywhere)');
    if (!SYSTEM_TIMEOUT) {
      writeEveryRepo(guardrailLearning('timeout-missing', 'every repo', 'on 6 days', new Date(2026, 9, 1)), 'no-timeout.md', { TRAIL_HOME: b.trail });
      const s = session(b);
      await promptHook(s, at(17, 0), 'run the tests');
      const denied = await agentRuns(s, at(17, 10), 'timeout 60 npm test');
      assert.equal(denied.decision?.hookSpecificOutput?.permissionDecision, 'deny', 'the guardrail holds');
    }
  } finally {
    done(b);
  }
});
