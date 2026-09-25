import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGraftSettings } from '../src/claude/settings-merge.js';

const SL = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-statusline.cjs"';

test('empty settings gets the full Graft blocks', () => {
  const { merged, warnings } = mergeGraftSettings({});
  assert.equal(merged.statusLine.command, SL);
  assert.equal(merged.subagentStatusLine.command, SL);
  assert.ok(Array.isArray(merged.hooks.PostToolUse));
  assert.equal(merged.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit');
  for (const e of ['PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop']) {
    assert.ok(merged.hooks[e][0].hooks[0].command.includes('graft-hooks.cjs'), `${e} wired`);
  }
  // PostToolUse carries a second graft block: the usage-mix + tokens-saved
  // accumulator over the retrieval tools (Bash `graft …`, the graft_* MCP tools)
  // and the source-read tools (Read/Grep/Glob) it scores against.
  const savings = merged.hooks.PostToolUse[1];
  assert.equal(savings.matcher, 'Bash|mcp__graft__|Read|Grep|Glob');
  assert.ok(savings.hooks[0].command.includes('tool-savings'), 'savings hook wired');
  assert.ok(merged.footerLinksRegexes.includes('graft/[\\w./-]+\\.md'));
  assert.deepEqual(warnings, []);
});

test('foreign statusLine is preserved with a warning; Graft not forced in', () => {
  const { merged, warnings } = mergeGraftSettings({ statusLine: { type: 'command', command: 'my-bar.sh' } });
  assert.equal(merged.statusLine.command, 'my-bar.sh');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /statusLine/);
});

test('a prior Graft statusLine (helper path, old command) is updated to the current command', () => {
  const { merged, warnings } = mergeGraftSettings({
    statusLine: { type: 'command', command: 'node .claude/helpers/graft-statusline.cjs' },
    subagentStatusLine: { type: 'command', command: 'node .claude/helpers/graft-statusline.cjs' },
  });
  assert.equal(merged.statusLine.command, SL);
  assert.equal(merged.subagentStatusLine.command, SL);
  assert.deepEqual(warnings, []);
});

test('statusline: false does not install a statusLine on empty settings', () => {
  const { merged } = mergeGraftSettings({}, { statusline: false });
  assert.equal(merged.statusLine, undefined);
  assert.equal(merged.subagentStatusLine, undefined);
  assert.ok(Array.isArray(merged.hooks.Stop), 'hooks still wired');
});

test('statusline: false strips a prior Graft statusLine so a user-level one can show', () => {
  const { merged } = mergeGraftSettings({
    statusLine: { type: 'command', command: SL },
    subagentStatusLine: { type: 'command', command: SL },
  }, { statusline: false });
  assert.equal(merged.statusLine, undefined);
  assert.equal(merged.subagentStatusLine, undefined);
});

test('statusline: false still leaves a foreign statusLine alone', () => {
  const { merged, warnings } = mergeGraftSettings(
    { statusLine: { type: 'command', command: 'my-bar.sh' } },
    { statusline: false },
  );
  assert.equal(merged.statusLine.command, 'my-bar.sh');
  assert.match(warnings.join('\n'), /statusLine/);
});

test('GRAFT_NO_STATUSLINE=1 skips installing a statusLine', () => {
  const prev = process.env.GRAFT_NO_STATUSLINE;
  process.env.GRAFT_NO_STATUSLINE = '1';
  try {
    const { merged } = mergeGraftSettings({});
    assert.equal(merged.statusLine, undefined);
    assert.equal(merged.subagentStatusLine, undefined);
  } finally {
    if (prev === undefined) delete process.env.GRAFT_NO_STATUSLINE;
    else process.env.GRAFT_NO_STATUSLINE = prev;
  }
});

test('existing foreign hooks are preserved; Graft appended', () => {
  const existing = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
  const { merged } = mergeGraftSettings(existing);
  // foreign block + graft's two PostToolUse blocks (post-edit, tool-savings).
  assert.equal(merged.hooks.PostToolUse.length, 3);
  assert.equal(merged.hooks.PostToolUse[0].hooks[0].command, 'mine.sh');
  assert.ok(merged.hooks.PostToolUse[1].hooks[0].command.includes('graft-hooks.cjs'));
  assert.ok(merged.hooks.PostToolUse[2].hooks[0].command.includes('graft-hooks.cjs'));
});

test('re-running is idempotent (no duplicate Graft entries or footer)', () => {
  const once = mergeGraftSettings({}).merged;
  const twice = mergeGraftSettings(once).merged;
  assert.equal(twice.hooks.PostToolUse.length, 2); // post-edit + tool-savings, not duplicated
  assert.equal(twice.hooks.Stop.length, 1);
  assert.equal(twice.footerLinksRegexes.filter((r: string) => r === 'graft/[\\w./-]+\\.md').length, 1);
});

test('foreign top-level keys survive', () => {
  const { merged } = mergeGraftSettings({ model: 'claude-sonnet-5', permissions: { allow: ['Bash(ls)'] } });
  assert.equal(merged.model, 'claude-sonnet-5');
  assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('fresh init adds the graft CLI allowlist', () => {
  const { merged } = mergeGraftSettings({});
  assert.deepEqual(merged.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('re-init does not duplicate allowlist entries', () => {
  const once = mergeGraftSettings({}).merged;
  const twice = mergeGraftSettings(once).merged;
  assert.deepEqual(twice.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('pre-existing unrelated allow entries are preserved and ours appended', () => {
  const existing = { permissions: { allow: ['Bash(ls)', 'Bash(git:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(ls)', 'Bash(git:*)', 'Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('a partially-present allowlist gains only what it lacks, in order', () => {
  const existing = { permissions: { allow: ['Bash(graft:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('pre-existing allow entries are kept and only the missing ones appended', () => {
  const existing = { permissions: { allow: ['Bash(graft:*)', 'Bash(npx graft:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

test('permissions object with no allow key gets one added; other keys preserved', () => {
  const existing = { permissions: { deny: ['Bash(rm:*)'] } };
  const { merged } = mergeGraftSettings(existing);
  assert.deepEqual(merged.permissions.deny, ['Bash(rm:*)']);
  assert.deepEqual(merged.permissions.allow, ['Bash(graft:*)', 'Bash(npx graft:*)', 'Bash(graft-dev:*)', 'Bash(node dist/cli.js:*)']);
});

/**
 * A budget raised by hand in `.claude/settings.json` is the only way to say "this
 * repo's graph needs longer than the template assumes". It could not survive: the
 * merge dropped graft's own entries whole and rewrote them from the template, and
 * `reconcileWiring()` fires that rewrite on every version bump, so the raise reverted
 * unattended with only the one-line "refreshed this repo's agent wiring" notice as a
 * trace (issue #366).
 */
const POST_EDIT = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-hooks.cjs" post-edit';
const SAVINGS = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-hooks.cjs" tool-savings';

function postToolUse(merged: any) {
  const byName: Record<string, any> = {};
  for (const entry of merged.hooks.PostToolUse) {
    for (const hook of entry.hooks ?? []) byName[String(hook.command).split(/\s+/).pop()!] = hook;
  }
  return byName;
}

test('a hand-raised hook timeout survives a refresh', () => {
  const { merged } = mergeGraftSettings({
    hooks: {
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: POST_EDIT, timeout: 20000 }] },
        { matcher: 'Bash|mcp__graft__|Read|Grep|Glob', hooks: [{ type: 'command', command: SAVINGS, timeout: 8000 }] },
      ],
    },
  });

  const hooks = postToolUse(merged);
  assert.equal(hooks['post-edit'].timeout, 20000, 'the raise is carried forward');
  // Per hook, not per event: the raise belongs to the entry it was made on.
  assert.equal(hooks['tool-savings'].timeout, 8000);
  // Still one entry per template block, so a refresh converges instead of stacking.
  assert.equal(merged.hooks.PostToolUse.length, 2);
  assert.equal(merged.hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit');
});

test('the template can still raise the floor for a repo below it', () => {
  const { merged } = mergeGraftSettings({
    hooks: {
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: POST_EDIT, timeout: 5000 }] },
      ],
    },
  });
  // Raise-only in both directions: a prior value below the template does not hold it
  // down, so a repo wired before a bump still gets the longer budget.
  assert.equal(postToolUse(merged)['post-edit'].timeout, 10000);
});

test('a raise is matched by hook name, not by the whole command', () => {
  // The helpers path differs between the repo-level and user-level installs and has
  // changed between versions, so an entry written by an older graft still has to be
  // recognised as the same hook.
  const { merged } = mergeGraftSettings({
    hooks: {
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node .claude/helpers/graft-hooks.cjs post-edit', timeout: 30000 }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'node "$HOME/.claude/helpers/graft-hooks.cjs" prompt', timeout: 25000 }] },
      ],
    },
  });
  assert.equal(postToolUse(merged)['post-edit'].timeout, 30000);
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].timeout, 25000);
});

test('a garbage prior timeout is ignored rather than carried', () => {
  for (const timeout of ['20000', null, undefined, NaN, Infinity]) {
    const { merged } = mergeGraftSettings({
      hooks: {
        PostToolUse: [
          { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: POST_EDIT, timeout }] },
        ],
      },
    });
    assert.equal(postToolUse(merged)['post-edit'].timeout, 10000, `timeout=${String(timeout)}`);
  }
});

test('a foreign hook on the same event keeps its own timeout', () => {
  const { merged } = mergeGraftSettings({
    hooks: {
      PostToolUse: [
        { matcher: 'Write', hooks: [{ type: 'command', command: 'my-linter.sh', timeout: 1 }] },
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: POST_EDIT, timeout: 20000 }] },
      ],
    },
  });
  const foreign = merged.hooks.PostToolUse.find((e: any) => e.hooks[0].command === 'my-linter.sh');
  assert.equal(foreign.hooks[0].timeout, 1);
  assert.equal(postToolUse(merged)['post-edit'].timeout, 20000);
});

test('re-running after a raise is idempotent', () => {
  const raised = {
    hooks: {
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: POST_EDIT, timeout: 20000 }] },
      ],
    },
  };
  const once = mergeGraftSettings(raised).merged;
  const twice = mergeGraftSettings(once).merged;
  assert.deepEqual(twice, once);
});
