import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionBody, cursorRule, kiroSteering, windsurfRule } from '../src/hosts/instructions.js';

test('canonical body names the three essentials', () => {
  const b = instructionBody();
  assert.match(b, /^## Graft — repo context graph/m);
  assert.match(b, /graft ask "/);
  assert.match(b, /graft\/INDEX\.md/);
  assert.match(b, /graft build/);
  assert.match(b, /every occurrence|enumerate with grep/i, 'teaches the exhaustive-task grep rule');
  assert.match(b, /callers/, 'teaches the callers/callees/impact commands');
  assert.match(b, /truncated/i, 'tells the agent to follow up on truncated spans');
  assert.match(b, /graft grep/, 'routes sweeps to graft grep');
  assert.match(b, /graft map/, 'tells the agent to orient with graft map before exploring');
  assert.match(b, /\[scope\/\]/, 'teaches the [scope/] label on multi-scope/monorepo hits');
  assert.match(b, /--in <scope>\//, 'teaches narrowing with ask --in <scope>/');
  assert.match(b, /local, regenerable cache/, 'graft/ is a cache, not a committed artifact (#80)');
  assert.match(b, /gitignored/, 'tells the agent the graph is not in git (#80)');
  assert.doesNotMatch(b, /through git/, 'must not claim git carries the graph (#80)');
  assert.ok(!/\bhook|statusline\b/i.test(b), 'no host-specific machinery in the shared body');
});

test('cursor rule has alwaysApply frontmatter and the body', () => {
  const r = cursorRule();
  assert.match(r, /^---\ndescription: .+\nalwaysApply: true\n---\n/);
  assert.ok(r.includes(instructionBody()));
});

test('kiro steering has inclusion: always frontmatter and the body', () => {
  const r = kiroSteering();
  assert.match(r, /^---\ninclusion: always\n---\n/);
  assert.ok(r.includes(instructionBody()));
});

test('windsurf rule has trigger: always_on frontmatter and the body', () => {
  const r = windsurfRule();
  assert.match(r, /^---\ntrigger: always_on\n---\n/);
  assert.ok(r.includes(instructionBody()));
});
