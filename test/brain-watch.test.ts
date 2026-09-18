/**
 * The push now holds the line instead of handing the prompt back, so what is
 * worth testing is the thing that made holding worthwhile: that a build which
 * dies is reported, and reported at the stage it actually died at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linesFor, stagesFrom, watchBuild, type RepoState } from '../src/brain/watch.js';
import { brainUrl } from '../src/brain/signup.js';

const row = (over: Partial<RepoState> = {}): RepoState => ({
  status: 'ingesting',
  ruleCount: 0,
  commitCount: 0,
  threadCount: 0,
  ...over,
});

const stateOf = (repo: RepoState | null, id: string) => stagesFrom(repo).stages.find((s) => s.id === id)?.state;

// --- where a failure lands ---------------------------------------------------

// The one that matters. A repo read successfully and then lost in the miner
// must not report itself as unreachable: that sends someone to fix repository
// access for a problem that has nothing to do with access.
test('a build that read the history and then died fails at the miner, not the access check', () => {
  const repo = row({
    status: 'failed',
    commitCount: 412,
    threadCount: 89,
    errorMessage: 'mine repository history: parse response: unexpected end of JSON input',
  });
  assert.equal(stateOf(repo, 'reach'), 'done');
  assert.equal(stateOf(repo, 'read'), 'done');
  assert.equal(stateOf(repo, 'mine'), 'failed');
  assert.match(stagesFrom(repo).error ?? '', /unexpected end of JSON input/);
});

test('a build that never read anything fails at the access check', () => {
  const repo = row({ status: 'failed', errorMessage: 'repo not accessible' });
  assert.equal(stateOf(repo, 'reach'), 'failed');
  assert.equal(stateOf(repo, 'mine'), 'waiting');
});

test('no stage after the failed one is left looking live', () => {
  const view = stagesFrom(row({ status: 'failed', commitCount: 10 }));
  const at = view.stages.findIndex((s) => s.state === 'failed');
  assert.ok(at >= 0);
  for (const s of view.stages.slice(at + 1)) assert.equal(s.state, 'waiting');
});

test('a failure with no message still says something', () => {
  assert.equal(stagesFrom(row({ status: 'failed' })).error, 'the read stopped before it finished');
});

test('done means the rules are in the brain, not just that the row closed', () => {
  assert.equal(stagesFrom(row({ status: 'completed', commitCount: 412, ruleCount: 0 })).done, false);
  assert.equal(stagesFrom(row({ status: 'completed', commitCount: 412, ruleCount: 42 })).done, true);
});

// --- what gets printed -------------------------------------------------------

// This is a log, not a redrawn frame: a line per poll for a stage that is merely
// still running would bury the four that matter under a hundred that do not.
test('only settled stages print, and each prints once', () => {
  const printed = new Set<string>();
  const first = linesFor(stagesFrom(row({ commitCount: 412, threadCount: 89 })), printed);
  assert.equal(first.length, 2, 'reach and read have settled; mine and file have not');
  assert.match(first[1], /412 commits, 89 discussions/);
  assert.deepEqual(linesFor(stagesFrom(row({ commitCount: 412, threadCount: 89 })), printed), [], 'nothing reprints');
  const later = linesFor(stagesFrom(row({ status: 'completed', commitCount: 412, threadCount: 89, ruleCount: 42 })), printed);
  assert.equal(later.length, 2, 'mine and file settle later and print then');
  assert.match(later.join('\n'), /42 rules/);
});

// --- the watcher ------------------------------------------------------------

/** A fetch that answers with each row in turn, then repeats the last. */
function fetchSeries(rows: (Record<string, unknown> | null)[]): typeof fetch {
  let i = 0;
  return (async () => {
    const repo = rows[Math.min(i++, rows.length - 1)];
    return { ok: true, json: async () => ({ repo }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const LINK = { brainId: '8f2a1c04-0000-0000-0000-000000000000', token: 'gbt_1.sig' };
const NOW = { timeoutMs: 60_000, pollMs: 0, sleep: async () => {} };

test('the watcher holds until the brain is built', async () => {
  const lines: string[] = [];
  const outcome = await watchBuild(LINK, {
    ...NOW,
    write: (l) => lines.push(l),
    fetchImpl: fetchSeries([
      { status: 'pending', rule_count: 0, commit_count: 0, thread_count: 0 },
      { status: 'ingesting', rule_count: 0, commit_count: 412, thread_count: 89 },
      { status: 'completed', rule_count: 42, commit_count: 412, thread_count: 89 },
    ]),
  });
  assert.equal(outcome, 'completed');
  assert.match(lines.join('\n'), /reaching the repository/);
  assert.match(lines.join('\n'), /42 rules/);
});

test('the watcher reports a failure rather than waiting out the clock', async () => {
  const lines: string[] = [];
  const outcome = await watchBuild(LINK, {
    ...NOW,
    write: (l) => lines.push(l),
    fetchImpl: fetchSeries([
      { status: 'ingesting', rule_count: 0, commit_count: 412, thread_count: 0 },
      { status: 'failed', rule_count: 0, commit_count: 412, thread_count: 0, error_message: 'repo job carries no history to mine' },
    ]),
  });
  assert.equal(outcome, 'failed');
  assert.match(lines.join('\n'), /carries no history to mine/);
});

// A host that is down must not be reported as a build that failed: one is our
// problem and the other is the user's, and they lead to opposite next steps.
test('a build it could never read is unreachable, not failed', async () => {
  const outcome = await watchBuild(LINK, {
    ...NOW,
    timeoutMs: 0,
    write: () => {},
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch,
  });
  assert.equal(outcome, 'unreachable');
});

test('a build still running when the clock runs out is a timeout, not a failure', async () => {
  const outcome = await watchBuild(LINK, {
    ...NOW,
    timeoutMs: 0,
    write: () => {},
    fetchImpl: fetchSeries([{ status: 'ingesting', rule_count: 0, commit_count: 1, thread_count: 0 }]),
  });
  assert.equal(outcome, 'timed_out');
});

// --- where the browser lands -------------------------------------------------

// /brain/<id> redirects to the graph, and it redirected the moment the row
// existed — minutes before it had any rules. Every terminal signup landed on an
// empty visualisation of a brain that was building perfectly well.
test('the handoff lands on the build screen, never on an empty graph', () => {
  const url = brainUrl('8f2a1c04-0000-0000-0000-000000000000', 'https://app.trailhq.com');
  assert.ok(!url.includes('/brain/'), 'must not go to the brain route, which redirects to the graph');
  assert.match(url, /\/get-started\?step=build&brain=8f2a1c04-0000-0000-0000-000000000000$/);
});
