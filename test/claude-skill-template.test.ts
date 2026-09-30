import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillTemplate } from '../src/claude/skill-template.js';

test('skill template preserves retrieval guidance without savings instructions', () => {
  const src = skillTemplate();
  assert.ok(src.startsWith('---\n'));
  assert.match(src, /^name: graft$/m);
  const body = src.split(/\n---\n/)[1] ?? '';
  assert.match(body, /graft ask/);
  assert.match(body, /every occurrence/i);
  assert.match(body, /graft grep/);
  assert.match(body, /graft callers/);
  assert.match(body, /--direction out/);
  assert.match(body, /--depth/);
  assert.match(body, /truncated/i);
  assert.match(body, /graft map/);
  assert.match(body, /\[scope\/\]/);
  assert.match(body, /--in <scope>\//);
  assert.doesNotMatch(body, /tokens saved/i);
  assert.doesNotMatch(body, /graft saved/i);
  assert.doesNotMatch(body, /every turn/i);
});
