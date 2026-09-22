/**
 * Tests for the dollar half of the savings estimate ({@link turnInputCostMicros}
 * + {@link dollarsSaved}). The token half lives in savings.test.ts.
 *
 * The property under test throughout is that nothing is ever invented: an
 * unknown model, an unbilled session and a zero saving all produce null, and
 * null renders as "tokens only" rather than as "$0.00".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inputUsdPerMtok,
  turnInputCostMicros,
  turnInputTokens,
  dollarsSaved,
  formatDollars,
} from '../src/context/price.js';

test('inputUsdPerMtok: known families are priced, anything else is null', () => {
  assert.equal(inputUsdPerMtok('claude-opus-5'), 5);
  assert.equal(inputUsdPerMtok('claude-opus-4-8'), 5);
  assert.equal(inputUsdPerMtok('claude-sonnet-5'), 2);
  assert.equal(inputUsdPerMtok('claude-sonnet-4-6'), 3);
  assert.equal(inputUsdPerMtok('claude-haiku-4-5'), 1);
  assert.equal(inputUsdPerMtok('claude-fable-5-1'), 10);
  assert.equal(inputUsdPerMtok('gpt-5'), null);
  assert.equal(inputUsdPerMtok(undefined), null);
});

test('turnInputCostMicros: fresh tokens cost list price', () => {
  // 1M fresh input tokens on a $5/Mtok model = $5.00 = 5,000,000 micro-dollars.
  const cost = turnInputCostMicros({
    model: 'claude-opus-5', input: 1_000_000, cacheCreate: 0, cacheRead: 0,
  });
  assert.equal(cost, 5_000_000);
});

test('turnInputCostMicros: cache writes cost 1.25x and reads a tenth', () => {
  const write = turnInputCostMicros({
    model: 'claude-opus-5', input: 0, cacheCreate: 1_000_000, cacheRead: 0,
  });
  const read = turnInputCostMicros({
    model: 'claude-opus-5', input: 0, cacheCreate: 0, cacheRead: 1_000_000,
  });
  assert.equal(write, 6_250_000);
  assert.equal(read, 500_000);
});

test('turnInputCostMicros: a cache-heavy turn is an order of magnitude cheaper than list', () => {
  // The shape of a real turn deep in a session: almost everything served from
  // cache. This is the whole reason the rate is measured rather than assumed —
  // pricing these tokens at list would overstate the saving roughly 10x.
  const usage = {
    model: 'claude-opus-5', input: 2, cacheCreate: 2_451, cacheRead: 132_972,
  };
  const cost = turnInputCostMicros(usage)!;
  const perMtok = cost / turnInputTokens(usage);
  assert.ok(perMtok > 0.5 && perMtok < 0.7, `blended rate was $${perMtok}/Mtok`);
});

test('turnInputCostMicros: an unpriced model yields null, never a guess', () => {
  assert.equal(
    turnInputCostMicros({ model: 'some-future-model', input: 100, cacheCreate: 0, cacheRead: 0 }),
    null,
  );
});

test('dollarsSaved: prices a saving at the session\'s blended rate', () => {
  // A session billed $0.60 for 1M input tokens pays $0.60/Mtok; 100k saved
  // tokens are therefore worth $0.06.
  const usd = dollarsSaved(100_000, 600_000, 1_000_000);
  assert.ok(usd !== null);
  assert.ok(Math.abs(usd - 0.06) < 1e-9, `got ${usd}`);
});

test('dollarsSaved: null until something has actually been billed', () => {
  assert.equal(dollarsSaved(100_000, undefined, undefined), null, 'turn one of a session');
  assert.equal(dollarsSaved(100_000, 0, 0), null, 'a host that exposes no transcript');
  assert.equal(dollarsSaved(0, 600_000, 1_000_000), null, 'nothing saved, nothing to price');
});

test('formatDollars: a real sub-cent saving is not rounded away to zero', () => {
  assert.equal(formatDollars(1.234), '$1.23');
  assert.equal(formatDollars(0.005), '<$0.01');
  assert.match(formatDollars(0.0001), /^<\$0\.01$/);
});

test('dollarsSaved: a non-finite accumulator never reaches a rendered surface', () => {
  assert.equal(dollarsSaved(100_000, Number.NaN, 1_000_000), null);
  assert.equal(dollarsSaved(100_000, 600_000, Number.NaN), null);
  assert.equal(dollarsSaved(Number.POSITIVE_INFINITY, 600_000, 1_000_000), null);
});
