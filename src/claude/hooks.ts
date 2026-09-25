import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { globalHelpersDir } from '../hosts/claude-global.js';
import { toPosixPath } from '../util/paths.js';
import { readWiring } from './stats.js';
import { formatBlastRadius, relevantRetrieval, formatOrientation } from './format.js';
import { indexFreshness, staleBanner } from '../context/check.js';
import { patchStats, readStats, acquireLock, readSession, writeSession, resolveContextDir } from './state.js';
import { graftCliPath, claudeScriptPath } from './paths.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { flushClosedSessions, summarizeSession } from '../telemetry/sessions.js';
import { hasSavingsTally, lastAssistantTurn, lastTurnBilling } from './tally.js';
import { scopeOf, scopesOfGraph } from '../graph/scopes.js';
import { classifyToolUse, isMcpToolName, isGraftMcpTool, parseSavings, recordToolUse, type ToolKind } from './session-metrics.js';

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

/** The settings files inside the repo itself — what `graft init` writes to. */
function repoSettingsFiles(dir: string): string[] {
  return [join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json')];
}

/**
 * Every settings file Claude Code merges hook definitions from, for a session
 * rooted at `dir`. The per-repo file is not the only place graft's hooks can be
 * installed: declaring them once at the user level wires every repo on the
 * machine at once, and such a repo has no `.claude/settings.json` at all.
 */
function hookSettingsFiles(dir: string): string[] {
  const user = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return [...repoSettingsFiles(dir), join(user, 'settings.json')];
}

/** One spelling for a file however it was named: symlinks resolved when it exists,
 * absolute either way, and case-folded where the filesystem is. */
function canonicalPath(p: string): string {
  let out: string;
  try { out = realpathSync(p); } catch { out = resolve(p); }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** The user-level shim, where hosts/claude-global.ts installs it. */
function userShimPath(): string {
  return join(globalHelpersDir(homedir()), 'graft-hooks.cjs');
}

/** Does this hook command name the user-level shim? Its command is written in posix
 * form on every platform (see hosts/claude-global.ts), so both spellings count. */
function namesUserShim(command: string, userShim: string): boolean {
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const c = fold(command);
  return c.includes(fold(userShim)) || c.includes(fold(toPosixPath(userShim)));
}

/**
 * The graft hook entry for `event` in `files`, as the pair Claude Code fires it on:
 * the settings event it sits under and its matcher (`''` when it has none). Matched
 * on the command's tail — `graft-hooks.cjs" post-edit` — because two entries share
 * a settings event (`post-edit` and `tool-savings` are both PostToolUse). `copy`
 * picks which of the two installs the entry belongs to: 'user' wants the one whose
 * command names the user-level shim, 'repo' any other.
 */
function graftHookEntry(
  files: string[], event: string, copy: 'repo' | 'user', userShim: string,
): { event: string; matcher: string } | null {
  const tail = new RegExp(`graft-hooks\\.cjs"?\\s+${event.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?:\\s|$)`);
  for (const file of files) {
    let settings: any;
    try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const [key, blocks] of Object.entries(settings?.hooks ?? {})) {
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        for (const h of block?.hooks ?? []) {
          if (typeof h?.command !== 'string' || !tail.test(h.command)) continue;
          if ((copy === 'user') !== namesUserShim(h.command, userShim)) continue;
          return { event: key, matcher: typeof block?.matcher === 'string' ? block.matcher : '' };
        }
      }
    }
  }
  return null;
}

/**
 * Is this process the user-level copy of a hook the repo already runs itself?
 *
 * `graft init` wires a repo in its own `.claude/settings.json`, and since #276 also
 * under `~/.claude` — the floor that keeps graft alive in a worktree whose
 * `.gitignore` swallowed the repo files. Claude Code runs every matching entry, so
 * a repo that carries both copies (the common case: settings.json tracked, so every
 * worktree has it) fires each hook twice. That is not just noise: two `graft ask`
 * children race on every prompt and the pack is injected twice, `recordToolUse`
 * counts every read and every `[graft]` footer twice, so `graft stats` and the
 * session summary report double, and the SessionStart orientation lands twice.
 *
 * The repo's copy is the one to keep — it is the one the user ran `graft init`
 * for — so the user-level copy stands down when it can be sure the repo's copy
 * fires on exactly the same occasions: the repo shim exists, a repo settings file
 * runs it for this event by a command of its own (not one that names the user-level
 * shim, or both copies would be this process and both would stand down), and that
 * entry sits under the same settings event with the same matcher as the user-level
 * entry. Same strings, so nothing here depends on how Claude Code interprets a
 * matcher; a repo wired by an older graft — fewer hooks, or the narrower PostToolUse
 * matcher from before 0.16 — keeps the user-level copy for whatever the two do not
 * agree on, and a missing repo shim or settings (the worktree case the floor exists
 * for) leaves it running exactly as before. Every mismatch errs toward the old
 * double run, never toward silence.
 *
 * One occasion it cannot see: a `graft init` in a live session, whose new repo
 * entries Claude Code loads on restart — which init already asks for.
 *
 * Only the Claude Code user-level shim ever stands down. Codex's user-level hooks
 * call a shim of the same name with the same event args, but Claude's repo hooks
 * never run in a Codex session, so a shim anywhere else is left alone.
 *
 * `shimPath` is `process.argv[1]` in the hook process: the shim file node was
 * asked to run, which is how a process tells which of the two entries launched it.
 */
export function shadowedByRepoHook(dir: string, event: string, shimPath: string | undefined): boolean {
  if (!shimPath) return false;
  const userShim = userShimPath();
  if (canonicalPath(shimPath) !== canonicalPath(userShim)) return false;
  if (!existsSync(join(dir, '.claude', 'helpers', 'graft-hooks.cjs'))) return false;
  const repo = graftHookEntry(repoSettingsFiles(dir), event, 'repo', userShim);
  if (!repo) return false;
  const user = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const mine = graftHookEntry([join(user, 'settings.json')], event, 'user', userShim);
  return mine !== null && mine.event === repo.event && mine.matcher === repo.matcher;
}

/** The timeout on one settings file's graft hook entry for `event`, or null if it
 * can't be read (no settings file, hand-edited shape, unparseable JSON). */
function hookTimeoutIn(file: string, event: string): number | null {
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as any;
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

/**
 * The budget this hook is actually running under, or null when no settings file
 * declares one.
 *
 * The smallest declared timeout wins rather than the nearest, because when more
 * than one file declares the hook Claude Code runs every matching entry, each
 * under its own budget. The user-level copy stands down where the repo runs its
 * own (see shadowedByRepoHook), but this lookup does not ask which entry it is
 * in: the smallest budget fits either, and guessing high is the expensive
 * mistake — an overrunning child gets the whole hook SIGKILLed, so `emit()` and
 * `writeSession()` never run and the turn silently gets no retrieval at all.
 * Guessing low only shortens one query.
 */
function installedHookTimeout(dir: string, event: string): number | null {
  let smallest: number | null = null;
  for (const file of hookSettingsFiles(dir)) {
    const timeout = hookTimeoutIn(file, event);
    if (timeout === null) continue;
    if (smallest === null || timeout < smallest) smallest = timeout;
  }
  return smallest;
}

/**
 * Append `--dir <contextDir>` for the hooks' own `graft ask`/`graft check`
 * children — the one place in this file that spawns the CLI itself rather
 * than reading `graft/` off disk (which already resolves through
 * `resolveContextDir` inside `util/state.ts` and `claude/stats.ts`). A no-op
 * when `GRAFT_DIR` isn't set, so an unconfigured repo's spawned CLI sees
 * byte-identical argv to before this existed.
 */
function withContextDirArg(dir: string, args: string[]): string[] {
  return process.env.GRAFT_DIR ? [...args, '--dir', resolveContextDir(dir)] : args;
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
function checkStaleCount(dir: string): number {
  const r = graftJson(dir, withContextDirArg(dir, ['check', '.', '--json']));
  const g = r?.graph ?? {};
  return (g.changed?.length ?? 0) + (g.added?.length ?? 0) + (g.removed?.length ?? 0);
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
  patchStats(dir, { dirty: true, staleCount: checkStaleCount(dir), lastFile: basename(file) });
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

/**
 * PostToolUse on a retrieval tool. Two jobs, both a pure parse of the payload the
 * hook already received (no re-run):
 *
 *   1. Score the usage mix: classify the tool as a graft retrieval or a source
 *      read (Read/Grep/Glob) and bump the session's `graftReads`/`sourceReads`.
 *      Until this ran, those counters were never incremented, so
 *      `session_summary` telemetry shipped 0/0 for every session.
 *   2. Sum any `[graft] tokens saved ≈ N` footers in the output into the running
 *      `savedTokens` total, so the statusline's `~N tok saved` reflects the
 *      session across CLI and MCP.
 *
 * A `[graft]` footer is itself proof graft ran, so it also counts as a graft
 * read even when the tool name alone (a bare `Bash`) couldn't say so. A graft use
 * also flags the turn (`turnUsedGraft`) so the Stop hook's tally can resolve
 * whether the reply told the user what it saved. Stays a no-op on the
 * Write/Edit/unrelated-Bash majority: nothing to classify and no footer means
 * nothing is written.
 */
function handleToolUse(input: any, dir: string): void {
  recordToolUse(dir, input?.session_id || 'default',
    { ...classifyAndScore(input?.tool_name, input?.tool_input?.command, () => input?.tool_response ?? input), host: 'claude-code' });
}

/**
 * Classify a tool use and, only when it could carry a graft footer, parse the
 * savings out of its (lazily-serialised) output.
 *
 * Source reads (Read/Grep/Glob) never print a `[graft]` footer, and their output
 * is a whole file or every match — serialising and regexing that on every read
 * is the expensive, pointless case the widened PostToolUse matcher would
 * otherwise hit. So skip `payload()` entirely for them. For anything else, a
 * footer is itself proof graft ran (a bare `Bash graft …` the name couldn't
 * classify), so its presence upgrades the kind to 'graft'.
 */
function classifyAndScore(
  toolName: string | undefined,
  command: string | undefined,
  payload: () => unknown,
): { kind: ToolKind | null; savedTokens: number } {
  let kind = classifyToolUse(toolName, command);
  if (kind === 'source') return { kind, savedTokens: 0 };
  const savedTokens = parseSavings(JSON.stringify(payload() ?? ''));
  if (savedTokens > 0) kind = 'graft';
  return { kind, savedTokens };
}

/**
 * Cursor `postToolUse` (https://cursor.com/docs/hooks). Same job as
 * {@link handleToolUse} but over Cursor's payload shape: `tool_output` holds the
 * JSON-stringified result (a Shell `graft …` call's footer lives in its stdout),
 * and the session key is `conversation_id`. MCP graft calls are skipped here —
 * `afterMCPExecution` owns them, and counting both would double the graft tally.
 * The skip covers both the prefixed (`MCP:graft_find_code`) and bare
 * (`graft_find_code`) tool-name shapes, so the guard — not just the installed
 * matcher — is what prevents the double count.
 */
function handleCursorPostTool(input: any, dir: string): void {
  const toolName = String(input?.tool_name ?? '');
  if (isMcpToolName(toolName) || isGraftMcpTool(toolName)) return; // handled by handleCursorMcp
  const command = input?.tool_input?.command ?? input?.tool_input?.cmd;
  recordToolUse(dir, cursorSessionId(input),
    { ...classifyAndScore(toolName, command, () => input?.tool_output ?? input?.tool_response ?? input), host: 'cursor' });
}

/**
 * Cursor `afterMCPExecution`: fires only for MCP tools, so a graft tool is
 * recognised by its name and its savings read out of `result_json`. This is the
 * one place graft MCP calls are counted for Cursor.
 */
function handleCursorMcp(input: any, dir: string): void {
  const toolName = String(input?.tool_name ?? '');
  if (!isGraftMcpTool(toolName)) return;
  const savedTokens = parseSavings(JSON.stringify(input?.result_json ?? input?.result ?? input ?? ''));
  recordToolUse(dir, cursorSessionId(input), { kind: 'graft', savedTokens, host: 'cursor' });
}

/** Cursor keys a chat by `conversation_id` (its `session_id` equivalent). */
function cursorSessionId(input: any): string {
  return input?.conversation_id || input?.session_id || 'default';
}

/**
 * At turn end: what did this turn's input tokens actually cost?
 *
 * Deliberately ungated, unlike {@link countTallyTurn}: the blended rate has to
 * describe the session, and graft turns are not a fair sample of it — they are
 * the long, tool-heavy, cache-warm ones. Sampling only those would report a
 * cheaper token than the session really pays.
 *
 * Accumulates the pair, never the ratio, so the rate re-blends every turn. A
 * turn already billed (a duplicate Stop, or a Stop racing the transcript write)
 * is skipped on its uuid.
 */
function sampleTurnCost(input: any, dir: string): void {
  try {
    const id = input?.session_id || 'default';
    const billing = lastTurnBilling(input?.transcript_path);
    if (!billing) return;
    const s = readSession(dir, id);
    if (billing.uuid === s.lastBillingUuid) return;
    s.inputCostMicros = (s.inputCostMicros ?? 0) + billing.costMicros;
    s.inputTokensBilled = (s.inputTokensBilled ?? 0) + billing.tokens;
    s.lastBillingUuid = billing.uuid;
    writeSession(dir, id, s);
  } catch {
    // A billing estimate is never worth failing the graph sync over.
  }
}

/**
 * At turn end: did the reply the user just read say what graft saved?
 *
 * Runs only on turns the tool-savings hook flagged, so a conversational turn
 * costs nothing. A turn we cannot observe — a host whose Stop hook names no
 * transcript, an unreadable file, or a Stop that fires before the final prose
 * is on disk — is counted in NEITHER total: the ratio these two numbers form
 * has to mean "of the turns we could check", not "of the turns we tried to".
 */
function countTallyTurn(input: any, dir: string): void {
  try {
    const id = input?.session_id || 'default';
    const s = readSession(dir, id);
    if (!s.turnUsedGraft) return;
    const turn = lastAssistantTurn(input?.transcript_path);
    // Same reply as last time we looked: no new prose has landed, so this Stop
    // is a duplicate or a race with the transcript write. Drop the turn rather
    // than judge it on a stale message.
    if (!turn || turn.uuid === s.lastTallyUuid) {
      writeSession(dir, id, { ...s, turnUsedGraft: false });
      return;
    }
    s.graftTurns = (s.graftTurns ?? 0) + 1;
    if (hasSavingsTally(turn.text)) s.reportedTurns = (s.reportedTurns ?? 0) + 1;
    s.turnUsedGraft = false;
    s.lastTallyUuid = turn.uuid;
    writeSession(dir, id, s);
  } catch {
    // A turn-end metric is never worth failing the graph sync over.
  }
}

function handleStop(input: any, dir: string): void {
  sampleTurnCost(input, dir);
  countTallyTurn(input, dir);
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
    const child = spawn(process.execPath, [syncRun, dir], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
}

export async function main(event: string, shimPath: string | undefined = process.argv[1]): Promise<void> {
  const input = readStdin();
  const dir = projectDir(input);

  // The repo's own hook is about to do (or is doing) exactly this; see shadowedByRepoHook.
  if (shadowedByRepoHook(dir, event, shimPath)) return;

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
      const idx = readFileSync(join(resolveContextDir(dir), 'INDEX.md'), 'utf8');
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

  if (event === 'tool-savings') { handleToolUse(input, dir); return; }

  if (event === 'cursor-post-tool') { handleCursorPostTool(input, dir); return; }

  if (event === 'cursor-mcp') { handleCursorMcp(input, dir); return; }

  // Cursor closes a chat: force-close THIS conversation into a bucketed
  // `session_summary` now (its file's mtime is fresh, so the idle sweep would
  // skip it). Attributed to Cursor. The idle sweep stays on Claude's
  // session-start, whose Stop fires per turn and so has no real end signal.
  if (event === 'cursor-session-end') { summarizeSession(dir, cursorSessionId(input), { host: 'cursor' }); return; }

  if (event === 'stop') { handleStop(input, dir); return; }

  if (event === 'post-edit-sync') { await handlePostEdit(input, dir); handleStop(input, dir); return; }

  if (event === 'prompt') {
    const prompt = String(input?.prompt ?? '').trim();
    if (prompt.length < MIN_PROMPT_CHARS) return;
    // Pointers-only, small, gated. No --source: per-prompt injected tokens are
    // fresh full-price input on every turn (unlike the cached SessionStart
    // orientation), so the pack carries locators, never inlined code — the agent
    // pulls spans itself via `graft ask --source` when a pointer looks right.
    // relevantRetrieval then drops the pack entirely when the prompt barely
    // overlaps the top hit or when every hit was already injected this session.
    const askArgs = withContextDirArg(dir, ['ask', prompt, '.', '--json', '-n', '3']);
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
