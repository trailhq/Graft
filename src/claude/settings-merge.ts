import { isGraftEntry } from '../hosts/config-write.js';

type Json = Record<string, any>;

const SL_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-statusline.cjs"';
/** Stable marker for "this statusLine is Graft's", not the full command string —
 * an older shim path or a GRAFT_DIR wrapper still names this file. */
const GRAFT_STATUSLINE_HELPER = 'graft-statusline.cjs';
const FOOTER = 'graft/[\\w./-]+\\.md';
// Every form graft is actually invoked as. 'graft:*' covers a global install;
// the other two cover a repo working on graft itself (or any consumer running it
// from a checkout), where the binary is not on PATH under that name. A retrieval
// call that raises a permission prompt loses to grep, which never does.
const ALLOW_ENTRIES = [
  'Bash(graft:*)',
  'Bash(npx graft:*)',
  'Bash(graft-dev:*)',
  'Bash(node dist/cli.js:*)',
];

/** Where the repo-level install's shims sit, relative to whatever project is open. */
const REPO_HELPERS = '${CLAUDE_PROJECT_DIR:-.}/.claude/helpers';

/**
 * `helpers` is the directory holding `graft-hooks.cjs`, and it is a parameter for
 * one reason: the user-level install (see hosts/claude-global.ts) has to name an
 * absolute path. A `${CLAUDE_PROJECT_DIR}` command works only where a previous
 * `graft init` wrote a shim into that project — which is exactly the case the
 * global copy exists to cover, so it cannot reuse the repo form.
 */
function hookCmd(arg: string, helpers: string = REPO_HELPERS): string {
  return `node "${helpers}/graft-hooks.cjs" ${arg}`;
}

/**
 * Hook `timeout` values Claude Code writes into settings.json.
 *
 * Claude Code documents this field as **seconds** (default 600). 0.16.0 wrote
 * 8000 / 10000 / 15000 intending milliseconds; a stalled hook then blocked the
 * session for hours. These numbers are the same budgets as before, in the unit
 * the host actually reads. `hooks.ts` converts back to milliseconds when it
 * caps the `graft ask` child just under the installed hook.
 */
const POST_EDIT_TIMEOUT_S = 10;
const TOOL_SAVINGS_TIMEOUT_S = 8;
const PROMPT_TIMEOUT_S = 15;
const SESSION_TIMEOUT_S = 8;
const STOP_TIMEOUT_S = 8;

function graftBlocks(helpers?: string): Record<string, Json[]> {
  return {
    PostToolUse: [
      { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: hookCmd('post-edit', helpers), timeout: POST_EDIT_TIMEOUT_S }] },
      // Score the usage mix and sum token savings. A graft retrieval (CLI `graft …`
      // via Bash, or the `graft_*` MCP tools) prints a `[graft] tokens saved ≈ N`
      // footer this hook sums into the session total; the same hook classifies
      // Read/Grep/Glob as source reads vs graft as graft reads, which is what feeds
      // `graft stats` and the `session_summary` graft-vs-grep ratio. Broad matcher,
      // but the handler no-ops instantly unless there is something to record, so an
      // unrelated Bash or a plain Read costs only a stdin read.
      { matcher: 'Bash|mcp__graft__|Read|Grep|Glob', hooks: [{ type: 'command', command: hookCmd('tool-savings', helpers), timeout: TOOL_SAVINGS_TIMEOUT_S }] },
    ],
    // Longer budget than the other hooks: its `graft ask` is a real query, and a
    // query now brings the graph up to date first (graph/refresh.ts) — usually
    // milliseconds, but the first one after an upgrade re-parses the repo once.
    // `hooks.ts` reads this number back out of the installed settings.json at
    // runtime and caps its `graft ask` child just under it, so a repo wired before
    // this bump (8s) keeps a child that fits inside 8s. Changing the number here is
    // therefore safe on its own — but it only reaches an existing repo when someone
    // re-runs `graft init`, since that is the only caller of this function.
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('prompt', helpers), timeout: PROMPT_TIMEOUT_S }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('session-start', helpers), timeout: SESSION_TIMEOUT_S }] }],
    Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop', helpers), timeout: STOP_TIMEOUT_S }] }],
  };
}

/**
 * Is this allowlist entry one graft wrote?
 *
 * Scoped to the forms graft is actually invoked as — NOT any rule mentioning
 * "graft". A user who allowlists their own `Bash(graft-mytool:*)` keeps it; only
 * graft's own set is replaced, which is what lets a renamed entry disappear on
 * upgrade instead of accumulating beside its replacement.
 */
export function isGraftAllowEntry(entry: unknown): boolean {
  return /^Bash\((?:graft|npx graft|graft-dev|node dist\/cli\.js)(?::|\))/.test(String(entry));
}

/** Is this footer regex graft's? It points at the card tree, which is graft's alone. */
export function isGraftFooterRegex(re: unknown): boolean {
  return String(re).includes('graft/');
}

function envNoStatusline(): boolean {
  const v = process.env.GRAFT_NO_STATUSLINE;
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** True when init should write (or refresh) Graft's Claude Code statusLine. */
export function statuslineWanted(opts: { statusline?: boolean } = {}): boolean {
  return opts.statusline !== false && !envNoStatusline();
}

function isGraftStatusline(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const command = (value as Json).command;
  return typeof command === 'string' && command.includes(GRAFT_STATUSLINE_HELPER);
}

function applyStatusline(
  merged: Json,
  key: 'statusLine' | 'subagentStatusLine',
  warnings: string[],
  wanted: boolean,
  foreignWarning: string,
): void {
  const current = merged[key];
  const ours = isGraftStatusline(current);
  if (!wanted) {
    if (!current || ours) delete merged[key];
    else warnings.push(foreignWarning);
    return;
  }
  if (!current || ours) {
    merged[key] = { type: 'command', command: SL_CMD };
    return;
  }
  warnings.push(foreignWarning);
}

export function mergeGraftSettings(
  existing: Json,
  opts: { statusline?: boolean } = {},
): { merged: Json; warnings: string[] } {
  const merged: Json = { ...(existing ?? {}) };
  const warnings: string[] = [];
  const wanted = statuslineWanted(opts);

  applyStatusline(
    merged, 'statusLine', warnings, wanted,
    'Existing statusLine left untouched (a session allows only one). To use Graft, point it at .claude/helpers/graft-statusline.cjs.',
  );
  applyStatusline(
    merged, 'subagentStatusLine', warnings, wanted,
    'Existing subagentStatusLine left untouched.',
  );

  merged.hooks = { ...(merged.hooks ?? {}) };
  for (const [event, blocks] of Object.entries(graftBlocks())) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const foreign = prior.filter((e: Json) => !isGraftEntry(e)); // drop old Graft entries → idempotent
    merged.hooks[event] = [...foreign, ...blocks];
  }

  // Claude Code honors `footerLinksRegexes` only in user/managed settings, not in
  // a project file. Drop graft's own pattern so a SessionStart refresh doesn't
  // keep rewriting an inert key into `.claude/settings.json`. The user's regexes
  // stay — same shape as statusLine: we don't clear what we didn't put there.
  dropGraftFooter(merged);

  // headless/subagent runs hard-deny Bash by default; without an allowlist entry
  // `graft ask`'s own Bash calls (and the skill it installs) can't run out-of-box.
  // Same shape as the hooks merge above: drop graft's prior entries, then add the
  // current set. Append-only left a renamed invocation form in the user's settings
  // forever, with nothing able to remove it.
  merged.permissions = { ...(merged.permissions ?? {}) };
  const priorAllow = Array.isArray(merged.permissions.allow) ? merged.permissions.allow : [];
  merged.permissions.allow = [...priorAllow.filter((e: unknown) => !isGraftAllowEntry(e)), ...ALLOW_ENTRIES];

  return { merged, warnings };
}

/**
 * The hook blocks (and the footer regex Claude Code actually honors), merged into
 * a settings file with the shims addressed by absolute path — `~/.claude/settings.json`,
 * where a write reaches every project on the machine (see hosts/claude-global.ts
 * for why that copy has to exist).
 *
 * Statusline and Bash allowlist stay repo-only: a session allows exactly one
 * statusline, and taking it globally would silently outrank the user's own.
 * `footerLinksRegexes` is the other way around — Claude Code ignores it in
 * project settings, so the user file is the only place the graft card badge can
 * appear. User regexes are kept; graft's own pattern is replaced, not stacked.
 *
 * Same idempotent shape as the repo merge: graft's prior entries are dropped before
 * the current set is added, so re-running converges instead of stacking.
 */
export function mergeGraftHooks(existing: Json, helpers: string): { merged: Json } {
  const merged: Json = { ...(existing ?? {}) };
  merged.hooks = { ...(merged.hooks ?? {}) };
  for (const [event, blocks] of Object.entries(graftBlocks(helpers))) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const foreign = prior.filter((e: Json) => !isGraftEntry(e));
    merged.hooks[event] = [...foreign, ...blocks];
  }
  applyGraftFooter(merged);
  return { merged };
}

/** Drop graft's footer pattern; keep everyone else's. No-op when the key is absent. */
function dropGraftFooter(merged: Json): void {
  if (!Array.isArray(merged.footerLinksRegexes)) return;
  const kept = merged.footerLinksRegexes.filter((r: unknown) => !isGraftFooterRegex(r));
  if (kept.length === 0) delete merged.footerLinksRegexes;
  else merged.footerLinksRegexes = kept;
}

/** Replace graft's prior footer pattern, then append the current one. User regexes stay. */
function applyGraftFooter(merged: Json): void {
  const prior = Array.isArray(merged.footerLinksRegexes) ? merged.footerLinksRegexes : [];
  merged.footerLinksRegexes = [...prior.filter((r: unknown) => !isGraftFooterRegex(r)), FOOTER];
}
