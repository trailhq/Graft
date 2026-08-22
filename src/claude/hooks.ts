import { readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, basename, isAbsolute } from 'node:path';
import { readWiring } from './stats.js';
import { formatBlastRadius, relevantRetrieval, formatOrientation } from './format.js';
import { indexFreshness, staleBanner } from '../context/check.js';
import { patchStats, readStats, acquireLock, readSession, writeSession } from './state.js';
import { graftCliPath, claudeScriptPath } from './paths.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { flushClosedSessions } from '../telemetry/sessions.js';
import { scopeOf, scopesOfGraph } from '../graph/scopes.js';

/** Prompts shorter than this never trigger retrieval — they are almost always
 * conversational ("yes go ahead", "thanks") and the coverage gate can't judge
 * them reliably with so few terms. */
const MIN_PROMPT_CHARS = 12;

function readStdin(): any {
  const seam = process.env.GRAFT_TEST_STDIN;
  const raw = seam !== undefined ? seam : safeReadFd0();
  try { return JSON.parse(raw); } catch { return {}; }
}
function safeReadFd0(): string { try { return readFileSync(0, 'utf8'); } catch { return ''; } }

function projectDir(input: any): string {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}
export function underGraft(dir: string, file: string): boolean {
  const rel = file.startsWith(dir) ? file.slice(dir.length) : file;
  return rel.replace(/^[/\\]+/, '').replace(/\\/g, '/').startsWith('graft/');
}
/** Default budget for a graft child process invoked from a hook, matching the 8s
 * the installed hook entries carry. */
const CHILD_TIMEOUT_MS = 8000;
/** Headroom left for the hook's own work (read stdin, score, write session, emit)
 * after its `graft ask` child returns. */
const HOOK_OVERHEAD_MS = 2000;
/** Floor, so a hand-edited tiny timeout can't leave the child no time at all. */
const MIN_CHILD_TIMEOUT_MS = 4000;

/**
 * How long the prompt hook may let `graft ask` run — derived from the budget that is
 * *actually installed* in this repo's `.claude/settings.json`, not from what the
 * current version of `settings-merge.ts` would install.
 *
 * A query now brings the graph up to date first, so `graft init` raises the
 * UserPromptSubmit budget to 15s to cover the one cold rebuild after an upgrade. But
 * `mergeGraftSettings` only runs during `graft init` — upgrading the npm package does
 * not re-run it. So every repo wired before that change keeps `"timeout": 8000`, and
 * hard-coding a 13s child there means Claude Code kills the hook first: `emit()` and
 * `writeSession()` never run, the turn gets no retrieval pack at all, and the SIGKILLed
 * child can't even release the build lock. Reading the installed number keeps the child
 * strictly inside whatever budget this repo really has.
 */
export function promptAskTimeout(dir: string): number {
  const installed = installedHookTimeout(dir, 'UserPromptSubmit');
  if (installed === null) return CHILD_TIMEOUT_MS - HOOK_OVERHEAD_MS;
  return Math.max(MIN_CHILD_TIMEOUT_MS, installed - HOOK_OVERHEAD_MS);
}

/** The timeout on this repo's graft hook entry for `event`, or null if it can't be
 * read (no settings file, hand-edited shape, unparseable JSON). */
function installedHookTimeout(dir: string, event: string): number | null {
  try {
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as any;
    const blocks = settings?.hooks?.[event];
    if (!Array.isArray(blocks)) return null;
    for (const block of blocks) {
      for (const h of block?.hooks ?? []) {
        if (typeof h?.command === 'string' && h.command.includes('graft-hooks.cjs') && typeof h.timeout === 'number') {
          return h.timeout;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function graftJson(dir: string, args: string[], timeout: number = CHILD_TIMEOUT_MS): any | null {
  try {
    // GRAFT_TEST_CLI is a test seam (mirrors GRAFT_TEST_STDIN/GRAFT_TEST_SYNC_RUN) so
    // tests can point the prompt hook's `graft ask`/`graft check` calls at a stub
    // script and observe the exact args it was invoked with, instead of shelling
    // out to the real CLI (which isn't built relative to the TS source under test).
    const cliPath = process.env.GRAFT_TEST_CLI ?? graftCliPath();
    const out = execFileSync(process.execPath, [cliPath, ...args],
      { cwd: dir, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch (e: any) {
    // `graft check` exits non-zero when the graph is stale (by design) but still
    // prints valid JSON to stdout; recover it from the thrown error before giving up.
    if (e && typeof e.stdout === 'string' && e.stdout.trim()) {
      try { return JSON.parse(e.stdout); } catch { /* not JSON — fall through */ }
    }
    return null;
  }
}
function emit(eventName: string, additionalContext: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } }));
}

/**
 * The absolute path of the file a PostToolUse edit touched, across host edit-tool
 * shapes:
 *   - Claude Code (`Write`/`Edit`/`MultiEdit`) states it directly as
 *     `tool_input.file_path` (already absolute).
 *   - Codex (`apply_patch`) carries the whole patch in `tool_input.command` and
 *     names the file in the patch header (`*** Add File:` / `*** Update File:`),
 *     as a repo-relative path — resolved against `dir` here. Take the first
 *     Add/Update target; that one file is enough to mark the graph dirty and
 *     draw a blast radius (the sync re-checks the whole tree anyway).
 * Returns null when neither shape yields a path, so the hook stays a clean no-op.
 */
export function editedFilePath(input: any, dir: string): string | null {
  const direct = input?.tool_input?.file_path;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const cmd = input?.tool_input?.command;
  if (typeof cmd === 'string' && cmd) {
    const m = /^\*\*\*\s+(?:Add|Update)\s+File:\s+(.+?)\s*$/m.exec(cmd);
    if (m) return isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
  }
  return null;
}

async function handlePostEdit(input: any, dir: string): Promise<void> {
  const file = editedFilePath(input, dir);
  if (!file || underGraft(dir, file)) return;
  // No `graft check` here (was: staleCount via checkStaleCount()). `check` walks
  // the whole graph, so on a large repo it can run well past this hook's timeout
  // budget — costing seconds on every single edit for a count that gets
  // overwritten anyway the moment Stop's async rebuild clears `dirty`.
  // freshnessSegment() already degrades to a plain "⚠ stale" when staleCount
  // isn't populated, so this is a silent, correct drop, not a display bug.
  patchStats(dir, { dirty: true, lastFile: basename(file) });
  const w = readWiring(dir);
  if (w) { const br = formatBlastRadius(w, file); if (br) emit('PostToolUse', br); }
}

/**
 * The "you're working in backend/, weight it" hint: on a multi-scope repo,
 * narrow the prompt hook's `ask` call to whatever scope the last-edited file
 * (`stats.lastFile`, captured at {@link handlePostEdit}) sits in.
 *
 * `lastFile` is only a basename (not a repo-relative path — see
 * `handlePostEdit`), so this is a best-effort lookup against the CURRENT
 * graph: any file node whose path ends in `/<lastFile>` (or equals it, for a
 * repo-root file). Fails soft in every direction a hook must never crash on —
 * no graph, a single-scope graph, a lastFile no longer in the graph (moved,
 * deleted, or edited before the first build), or a basename that lands in
 * more than one scope (ambiguous: could be either sub-project) all skip the
 * hint silently, logging one line to stderr so the miss is visible without
 * ever failing the hook.
 */
export function lastFileScopeHint(dir: string, lastFile: string | null | undefined): string | null {
  if (!lastFile) return null;
  try {
    const w = readWiring(dir);
    if (!w) return null;
    const scopes = scopesOfGraph(w);
    if (scopes.length <= 1) return null; // single-scope: no hint, no --in
    const matches = (w.nodes ?? []).filter(
      (n) => n.kind === 'file' && (n.path === lastFile || n.path.endsWith(`/${lastFile}`)),
    );
    if (matches.length === 0) {
      console.error(`[graft] prompt hook: lastFile "${lastFile}" not found in the graph — skipping scope hint`);
      return null;
    }
    const prefixes = new Set(matches.map((n) => scopeOf(n.path, scopes).prefix));
    if (prefixes.size > 1) {
      console.error(`[graft] prompt hook: lastFile "${lastFile}" matches more than one scope — skipping scope hint`);
      return null;
    }
    const [prefix] = prefixes;
    return prefix === '' ? null : prefix; // root scope: nothing to narrow
  } catch (e: any) {
    console.error(`[graft] prompt hook: scope hint lookup failed (${e?.message ?? e}) — skipping`);
    return null;
  }
}

/** PostToolUse on a graft retrieval tool. Its rendered output carries one (or
 * more) `[graft] tokens saved ≈ N` footers — the same numbers the agent just
 * read. Sum them and add to the session's running total so the statusline's
 * `~N tok saved` reflects what graft saved this session, across CLI and MCP.
 * Pure parse of the payload the hook already received (no re-run), and a no-op
 * unless a footer is present — so it stays cheap on unrelated Bash calls. */
function handleToolSavings(input: any, dir: string): void {
  const blob = JSON.stringify(input?.tool_response ?? input ?? '');
  let total = 0;
  for (const m of blob.matchAll(/\[graft\] tokens saved ≈ ([\d,]+)/g))
    total += Number(m[1].replace(/,/g, '')) || 0;
  if (total <= 0) return;
  const id = input?.session_id || 'default';
  const s = readSession(dir, id);
  s.savedTokens = (s.savedTokens ?? 0) + total;
  writeSession(dir, id, s);
}

function handleStop(dir: string): void {
  // sync-run.js ships next to this module inside the package, so it resolves in
  // any repo that installs graft (not just graft's own). Defensive existsSync:
  // if the package is somehow incomplete, skip rather than wedge on syncing:true.
  // GRAFT_TEST_SYNC_RUN is a test seam (mirrors GRAFT_TEST_STDIN) so tests can point
  // this at a stub file inside their own sandbox instead of writing into src/claude/.
  const syncRun = process.env.GRAFT_TEST_SYNC_RUN ?? claudeScriptPath('sync-run.js');
  if (!existsSync(syncRun)) return;
  const stats = readStats(dir);
  if (stats?.dirty && acquireLock(dir)) {
    patchStats(dir, { syncing: true });
    const child = spawn(process.execPath, [syncRun, dir], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

export async function main(event: string): Promise<void> {
  const input = readStdin();
  const dir = projectDir(input);

  if (event === 'session-start') {
    // Before anything is emitted: refresh this repo's wiring if it was written by
    // an older graft, and pick up any cached "newer version on npm" answer.
    // background:false — a hook must never touch the network; the CLI and the MCP
    // server fill that cache, this only reads it.
    const upkeep = runUpkeep(dir, runningVersion(), { background: false }).lines;
    // Roll up any session that ended since we were last here. Queue-only — the
    // hook still touches no network; the CLI or the MCP server sends it later.
    flushClosedSessions(dir);
    try {
      const idx = readFileSync(join(dir, 'graft', 'INDEX.md'), 'utf8');
      const banner = staleBanner(indexFreshness(dir)) ?? undefined;
      const orientation = formatOrientation(idx, undefined, banner);
      emit('SessionStart', upkeep.length ? `${upkeep.join('\n')}\n\n${orientation}` : orientation);
    } catch {
      // No INDEX.md (never built here). An upgrade nudge is still worth saying.
      if (upkeep.length) emit('SessionStart', upkeep.join('\n'));
    }
    return;
  }

  if (event === 'post-edit') { await handlePostEdit(input, dir); return; }

  if (event === 'tool-savings') { handleToolSavings(input, dir); return; }

  if (event === 'stop') { handleStop(dir); return; }

  if (event === 'post-edit-sync') { await handlePostEdit(input, dir); handleStop(dir); return; }

  if (event === 'prompt') {
    const prompt = String(input?.prompt ?? '').trim();
    if (prompt.length < MIN_PROMPT_CHARS) return;
    // Pointers-only, small, gated. No --source: per-prompt injected tokens are
    // fresh full-price input on every turn (unlike the cached SessionStart
    // orientation), so the pack carries locators, never inlined code — the agent
    // pulls spans itself via `graft ask --source` when a pointer looks right.
    // relevantRetrieval then drops the pack entirely when the prompt barely
    // overlaps the top hit or when every hit was already injected this session.
    const askArgs = ['ask', prompt, '.', '--json', '-n', '3'];
    // "You're working in backend/, weight it": only fires on a multi-scope
    // repo whose lastFile resolves cleanly to one scope — see lastFileScopeHint.
    const scopeHint = lastFileScopeHint(dir, readStats(dir)?.lastFile);
    if (scopeHint) askArgs.push('--in', scopeHint);
    const ask = graftJson(dir, askArgs, promptAskTimeout(dir));
    if (!ask) return;
    const id = input.session_id || 'default';
    const s = readSession(dir, id);
    s.lastQuery = prompt;
    const agent = input?.agent?.name;
    if (agent) s.perAgentQuery[agent] = prompt;
    const txt = relevantRetrieval(ask, s);
    if (txt) emit('UserPromptSubmit', txt);
    writeSession(dir, id, s);
  }
}
