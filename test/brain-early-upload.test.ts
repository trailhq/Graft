/**
 * The early upload sends the instruction file and the newest pull requests
 * before the rest of the history, so Trail's first CLAUDE.md suggestions start
 * while the full read is still on this machine. Two things make that safe, and
 * both are tested here: it is only sent to a brain that says it takes it, and
 * the full read does not ask GitHub again for threads the early one read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchExpectedRepo, pushEarlyDigest } from '../src/brain/push.js';
import { readThreads, type HistoryThread, type RepoDigest } from '../src/app/history.js';
import type { BrainLink } from '../src/brain/link.js';

const link = { brainId: 'b1', token: 'gbt_1.x', baseUrl: 'http://trail.test' } as unknown as BrainLink;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// --- only to a brain that takes it -------------------------------------------

// An older Trail ignores ?stage=early and would read the partial history as a
// whole ingest, then refuse the real one as already running. So the flag is
// read, and absent means no.
test('a brain that does not say it takes the early upload is not sent one', async () => {
  const older = await fetchExpectedRepo(link, (async () => json({ repo: { slug: 'chalk/chalk', status: 'pending' } })) as typeof fetch);
  assert.equal(older?.earlyUpload, false);

  const newer = await fetchExpectedRepo(link, (async () =>
    json({ repo: { slug: 'chalk/chalk', status: 'pending' }, early_upload: true })) as typeof fetch);
  assert.equal(newer?.earlyUpload, true);
});

test('the early upload is posted with ?stage=early and reports whether Trail took it', async () => {
  let url = '';
  const took = await pushEarlyDigest(link, { owner: 'chalk', name: 'chalk' } as RepoDigest, (async (u: string) => {
    url = u;
    return json({ early: true }, 202);
  }) as typeof fetch);
  assert.equal(took, true);
  assert.match(url, /\/api\/public\/brains\/b1\/repo\?stage=early$/);

  const ignored = await pushEarlyDigest(link, {} as RepoDigest, (async () => json({ early: false }, 202)) as typeof fetch);
  assert.equal(ignored, false, 'a brain without the CLAUDE.md step accepts and ignores it');

  const refused = await pushEarlyDigest(link, {} as RepoDigest, (async () => json({ error: 'no' }, 409)) as typeof fetch);
  assert.equal(refused, false);

  const down = await pushEarlyDigest(link, {} as RepoDigest, (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch);
  assert.equal(down, false, 'best-effort: the full upload still does everything');
});

// --- no second read of the same threads --------------------------------------

test('the full read reuses threads the early upload already fetched', async () => {
  const fetched: string[] = [];
  const fake = (async (u: string) => {
    fetched.push(u);
    if (u.includes('/pulls?state=closed')) {
      return json(u.includes('page=1') ? [{ number: 2, title: 'two' }, { number: 1, title: 'one' }] : []);
    }
    return json([{ body: 'use the whole test script', user: { login: 'dev', type: 'User' } }]);
  }) as never;

  const early: HistoryThread = { number: 2, title: 'two', body: '', mergeSha: '', comments: [{ body: 'from the early read' }] };
  const threads = await readThreads('chalk', 'chalk', 'tok', fake, 'https://api.test', 200, new Map([[2, early]]));

  assert.equal(threads.find((t) => t.number === 2)?.comments[0]?.body, 'from the early read');
  assert.ok(threads.some((t) => t.number === 1), 'the rest is still read');
  assert.ok(!fetched.some((u) => /\/(issues|pulls)\/2\/comments/.test(u)), 'no comment request for #2');
  assert.ok(fetched.some((u) => /\/(issues|pulls)\/1\/comments/.test(u)));
});
