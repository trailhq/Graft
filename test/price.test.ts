/** Tests for sampled host-reported input billing helpers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inputUsdPerMtok,
  turnInputCostMicros,
  turnInputTokens,
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
  // pricing these tokens at list would overstate the observed input cost roughly 10x.
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

