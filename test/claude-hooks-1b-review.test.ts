/**
 * b7 review: 1b's journeys through the real hooks (`main(event)`, the
 * `GRAFT_TEST_STDIN` seam, a sandbox Trail home, the test clock and a
 * growing synthetic transcript), for the legs the build covered only in
 * unit tests, and the turns that go wrong: interrupted, compacted, a moved
 * repo, a lesson that worked again. Made-up repos, prompts and commands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRuns, at, box, calling, done, finish, grow, offersLog, one, postBashFailHook, preBashHook, promptHook, reply, resultOf, session, startHook, stateOf, stopHook,
} from './claude-skills-journey-fixtures.js';
import {
  DOCKER_ERR, FIXED, GO_TEST, correctedRelease, ctxOf, dockerDay, globalCopy, oneOrNothing, readInitRecordOf, readdirSyncSafe, releaseKept, saidQuote, startContext, wallLessonKept, wholeTurn,
} from './claude-hooks-1b-review-fixtures.js';
import { readSkillsState } from '../src/skills/state.js';
import { readWalls } from '../src/trace/wall-state.js';
import { updateInitRecord } from '../src/init/init-record.js';
import { writeEveryRepo } from '../src/notes/every-repo.js';
import { guardrailCandidate } from './init-screen-fixtures.js';

test('J14a through the hooks: two releases from the block, each corrected, make release-npm need a fix; the index says so and no block comes', async () => {
  const b = box('r1b-j14a');
  try {
    const name = await releaseKept(b);
    const s1 = await correctedRelease(b, name, 22, '1.4.1');
    const after1 = readSkillsState({ TRAIL_HOME: b.trail }).skills;
    assert.notEqual(Object.values(after1)[0]?.status, 'needs-fix', 'one correction is not a fix needed');
    void s1;
    await correctedRelease(b, name, 24, '1.4.2');
    const st = Object.values(readSkillsState({ TRAIL_HOME: b.trail }).skills)[0];
    assert.equal(st?.status, 'needs-fix', JSON.stringify(st));
    const s3 = session(b);
    const start = await startContext(s3, at(26, 0));
    assert.match(start, new RegExp(`${name} needs a fix \\((step \\d+ was )?corrected on [^)]+\\), not used`), start);
    const ask = ctxOf(await promptHook(s3, at(26, 10), 'publish 1.4.3'));
    assert.doesNotMatch(ask, /Skill \S+ fits/, 'no run block for a skill that needs a fix');
  } finally {
    done(b);
  }
});

test('J14c through the hooks: Colima stopped and gh missing before a skill run, the failed probes come first in the block, and two failed runs charge nothing', async () => {
  const { savePersonal } = await import('../src/skills/store.js');
  const { compiled } = await import('./skills-store-fixtures.js');
  const b = box('r1b-j14c');
  try {
    const GO = 'go test -tags integration ./...';
    const c = compiled('shop-integration', { job: 'tests', asks: 'run the integration tests', params: '', check: GO, 'check-shows': 'ok', ready: 'test -S $HOME/.colima/default/docker.sock ; command -v gh-not-here-x' }, {
      title: 'Run acme/shop integration tests', steps: [{ n: 1, cmd: GO, gated: null, bg: false, wait: false, from: ['toolu_01'] }], check: GO, checkShows: 'ok', checkIsStep: true, params: [],
    });
    savePersonal(c, { from: 'repeated', runId: 'r-1001-0001', consent: 'offer-yes', stepsVerified: 1, env: { HOME: b.home, TRAIL_HOME: b.trail }, now: new Date(at(1, 0)) });
    for (const day of [12, 13]) {
      const s = session(b);
      const block = ctxOf(await promptHook(s, at(day, 0), 'run the integration tests'));
      assert.match(block, /^\[trail\] Skill shop-integration fits/, block);
      const firstProbe = block.search(/docker\.sock|gh-not-here-x/);
      const firstStep = block.indexOf(GO);
      assert.ok(firstProbe > 0 && firstProbe < firstStep, `the failed probe comes before the steps:\n${block}`);
      await agentRuns(s, at(day, 10), GO, () => ({ out: 'Exit code 1\npanic: Cannot connect to the Docker daemon at unix:///var/run/docker.sock\nFAIL', failed: true }));
      await finish(s, day, 'Docker is not running here.');
      await promptHook(s, at(day, 60), 'ok, thanks');
      reply(s, at(day, 70), 'Sure.');
      await finish(s, day, 'Sure.', 71);
      assert.equal(stateOf(s).injected[0]?.readyFailed?.length ? true : false, true, 'the injection keeps its failed probes');
    }
    const st = Object.values(readSkillsState({ TRAIL_HOME: b.trail }).skills)[0];
    assert.notEqual(st?.status, 'needs-fix', `a failed probe is never charged: ${JSON.stringify(st)}`);
  } finally {
    done(b);
  }
});

test('J09 with moment 3: offers off, the repair that repeats is noted but never offered; skills off, nothing is appended or noted', async () => {
  for (const [settings, noted] of [[{ offers: 'off', offersOffAt: '2026-10-01T00:00:00.000Z' }, true], [{ skills: 'off' }, false]] as const) {
    const b = box(`r1b-j09-${settings.offers ?? 'skills-off'}`, { settings });
    try {
      assert.equal((await dockerDay(session(b), 10))?.decision, undefined);
      const s2 = session(b);
      assert.equal((await dockerDay(s2, 14))?.decision, undefined, `${JSON.stringify(settings)}: no offer on day 2`);
      const w = readWalls({ TRAIL_HOME: b.trail });
      assert.equal(!!w.classes['docker-rootless']?.seen.length, noted, JSON.stringify(settings));
      assert.equal(offersLog(b).length, 0);
    } finally {
      done(b);
    }
  }
});

test('an auto-compaction mid-turn, through the hooks: the wall hit before it comes back once after it, and is still noted in walls.json though no Stop ran before the cut', async () => {
  const { compactBoundary, compactSummary } = await import('./trace-fixtures.js');
  const b = box('r1b-compact-mid');
  try {
    const s = session(b);
    await startHook(s, at(10, 0));
    await promptHook(s, at(10, 1), 'run the integration tests');
    await agentRuns(s, at(10, 10), GO_TEST, () => ({ out: DOCKER_ERR, failed: true }));
    grow(s, [compactBoundary({ sessionId: s.sid, cwd: s.b.repo, timestamp: at(10, 12) }), compactSummary({ sessionId: s.sid, cwd: s.b.repo, timestamp: at(10, 12) })]);
    const after = await startContext(s, at(10, 13), 'compact');
    assert.equal(after.split('\n').filter((l) => /recognizes this error from Docker/.test(l)).length, 1, after);
    await agentRuns(s, at(10, 20), FIXED, () => ({ out: 'ok  \tacme/shop/orders\t0.512s' }));
    await finish(s, 10, 'Tests pass.');
    const w = readWalls({ TRAIL_HOME: b.trail }).classes['docker-rootless'];
    assert.equal(w?.seen.length, 1, JSON.stringify(w));
    assert.equal(w?.seen[0]?.epoch, 0, 'in the epoch it was hit');
    // Open for the lab: a fix after the cut is in the next epoch's run, so this repair is not counted (b2's detector).
  } finally {
    done(b);
  }
});

test('an interrupted turn: the run the next ask closes, with no Stop before it, still has its wall hit noted with its repair', async () => {
  const { interrupted } = await import('./trace-fixtures.js');
  const b = box('r1b-interrupted');
  try {
    const s = session(b);
    await promptHook(s, at(10, 0), 'run the integration tests');
    await agentRuns(s, at(10, 10), GO_TEST, () => ({ out: DOCKER_ERR, failed: true }));
    await agentRuns(s, at(10, 20), FIXED, () => ({ out: 'ok  \tacme/shop/orders\t0.512s' }));
    // The person pressed Esc: no Stop. Their next ask closes the run.
    grow(s, [{ ...interrupted(), sessionId: s.sid, cwd: s.b.repo, timestamp: at(10, 25) }]);
    await promptHook(s, at(10, 30), 'now update the changelog');
    reply(s, at(10, 40), 'Updated.');
    await finish(s, 10, 'Updated.', 41);
    const w = readWalls({ TRAIL_HOME: b.trail }).classes['docker-rootless'];
    assert.equal(w?.seen.length, 1, JSON.stringify(w));
    assert.equal(w?.fixed.length, 1, JSON.stringify(w));
  } finally {
    done(b);
  }
});

test('J07 with quotes in the correction: line 2 shows them single, the yes keeps the lesson, and it rides with the skill as the person typed it', async () => {
  const { keepLessonCli } = await import('../src/skills/lesson-gate.js');
  const { offerLinesOf } = await import('../src/skills/offer-lines.js');
  const { sayOfferLines } = await import('./claude-skills-journey-fixtures.js');
  const b = box('r1b-j07-quotes');
  try {
    const name = await releaseKept(b);
    const s = session(b);
    assert.match(ctxOf(await promptHook(s, at(22, 0), 'publish 1.4.1')), /fits/);
    await agentRuns(s, at(22, 10), 'npm run build', () => ({ out: 'built' }));
    await agentRuns(s, at(22, 20), 'npm publish acme-cli-1.4.1.tgz --access public', () => ({ out: '+ acme-cli@1.4.1' }));
    await agentRuns(s, at(22, 30), 'npm view acme-cli version', () => ({ out: '1.4.1' }));
    await finish(s, 22, `Published 1.4.1.\nUsed skill ${name}`);
    await promptHook(s, at(22, 60), 'no, you forgot to push the "v" tag');
    await agentRuns(s, at(22, 70), 'git push origin --tags', () => ({ out: 'To github.com:acme/shop.git\n * [new tag]         v1.4.1 -> v1.4.1' }));
    const stop = await finish(s, 22, 'Pushed the tag.', 80);
    assert.equal(stop?.decision, 'block', JSON.stringify(stop));
    const offer = stateOf(s).pendingOffer!;
    const lines = offerLinesOf(offer, s.tx, { HOME: b.home, TRAIL_HOME: b.trail })!;
    assert.equal((lines[1]!.match(/"/g) ?? []).length, 2, lines[1]);
    await sayOfferLines(s, 22, lines, 85);
    await promptHook(s, at(22, 100), 'yes');
    const cmd = `trail skills lesson ${name} --offer ${offer.offerId}`;
    const kept = await agentRuns(s, at(22, 110), cmd, () => {
      const r = keepLessonCli(name, offer.offerId, { HOME: b.home, TRAIL_HOME: b.trail, CLAUDE_CODE_ENTRYPOINT: 'cli', TRAIL_TEST_NOW: at(22, 111) }, new Date(at(22, 111)));
      return { out: r.line, failed: r.code !== 0 };
    });
    assert.equal(kept.decision, null);
    assert.match(kept.out, /^✓ learning added to /, kept.out);
  } finally {
    done(b);
  }
});

test('a repo moved after its skill was kept: the anchors are read in the checkout the session is in now, so a moved repo is not out of date and a gone file is', async () => {
  const { savePersonal } = await import('../src/skills/store.js');
  const { compiled } = await import('./skills-store-fixtures.js');
  const { renameSync, rmSync } = await import('node:fs');
  const b = box('r1b-moved');
  try {
    const a = join(b.root, 'code', 'shop');
    mkdirSync(join(a, '.git'), { recursive: true });
    writeFileSync(join(a, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/shop.git\n');
    writeFileSync(join(a, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(a, 'scripts'), { recursive: true });
    writeFileSync(join(a, 'scripts', 'release.sh'), '#!/bin/sh\n');
    savePersonal(compiled('release-npm', { trail: 's-7f3a2c', applies: 'github.com/acme/shop' }, {
      steps: [{ n: 1, cmd: './scripts/release.sh {version}', gated: null, bg: false, wait: false, from: ['toolu_01'] }],
    }), { from: 'repeated', runId: 'r-1001-0001', consent: 'offer-yes', stepsVerified: 1, env: { HOME: b.home, TRAIL_HOME: b.trail }, now: new Date(at(1, 0)) });
    const indexIn = async (cwd: string, day: number) => {
      const s = session(b, { payload: { cwd } });
      return (await startContext(s, at(day, 0))).split('\n').find((l) => l.startsWith('[trail] Trail skills here')) ?? '';
    };
    assert.match(await indexIn(a, 10), /release-npm/);
    assert.doesNotMatch(await indexIn(a, 10), /out of date/);
    const moved = join(b.root, 'work', 'shop');
    mkdirSync(join(b.root, 'work'), { recursive: true });
    renameSync(a, moved);
    assert.doesNotMatch(await indexIn(moved, 11), /out of date/, 'the moved checkout still has the script');
    rmSync(join(moved, 'scripts', 'release.sh'));
    assert.match(await indexIn(moved, 12), /release-npm[^·]*out of date/, 'gone in the checkout the session is in');
  } finally {
    done(b);
  }
});

test('3.5 step 2 through the hooks: a kept lesson whose fix the agent ran again is noted as worked, whether it typed $HOME or the home itself (the lesson keeps it as $HOME)', async () => {
  for (const [wall, lesson, fail, err, ok] of [
    ['docker-rootless', '"rootless Docker not found": DOCKER_HOST=unix://$HOME/.colima/default/docker.sock', GO_TEST, DOCKER_ERR, 'DOCKER_HOST=unix://$HOME/.colima/default/docker.sock go test -tags integration ./...'],
    ['docker-rootless', '"rootless Docker not found": DOCKER_HOST=unix://$HOME/.colima/default/docker.sock', GO_TEST, DOCKER_ERR, 'DOCKER_HOST=unix://HOMEDIR/.colima/default/docker.sock go test -tags integration ./...'],
  ] as const) {
    const b = box(`r1b-worked-${wall}-${ok.slice(18, 22).replace(/\W/g, '')}`);
    try {
      const id = wallLessonKept(b, wall, lesson);
      const s = session(b);
      await promptHook(s, at(15, 0), 'run the tests');
      const fid = calling(s, at(15, 10), fail);
      resultOf(s, at(15, 10), fid, err, true);
      await postBashFailHook(s, at(15, 11), fail, fid, err);
      const okCmd = ok.replace('HOMEDIR', b.home);
      const pid = calling(s, at(15, 20), okCmd);
      resultOf(s, at(15, 20), pid, 'Tests: 12 passed, 12 total');
      await finish(s, 15, 'Tests pass.');
      const worked = readWalls({ TRAIL_HOME: b.trail }).classes[wall]?.lessons[id]?.worked ?? [];
      assert.equal(worked.length, 1, `${wall} with ${okCmd}: ${JSON.stringify(readWalls({ TRAIL_HOME: b.trail }).classes[wall])}`);
    } finally {
      done(b);
    }
  }
});

