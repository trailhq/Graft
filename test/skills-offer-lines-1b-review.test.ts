/**
 * b7 review of D114 (3) for moment 4: line 2 quotes the lesson, so double
 * quotes inside it (the person typed them) become single ones, as moment 3's
 * line 2 does. Made-up skill and words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { correctionLines } from "../src/skills/offer-lines.js";

test('moment 4 line 2: the lesson in quotes holds no double quote of its own', () => {
  const [, two] = correctionLines("release-npm", 'you forgot to run "npm ci" first', 'run "npm ci" first: npm ci');
  assert.equal(two, `Add a learning to it, just for you: "run 'npm ci' first: npm ci"? (yes / no)`);
});
