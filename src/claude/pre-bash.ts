/**
 * PreToolUse on Bash: the hook that runs before every shell command the agent
 * runs, as its own entry point.
 *
 * It must cost next to nothing, so the shim sends `pre-bash` here rather than
 * to hooks.js, and this file imports nothing at load time: node:fs comes from
 * `process.getBuiltinModule` (an ESM `import ... from 'node:fs'` alone costs
 * Node several ms), and hook-layers.ts is loaded only when there is a decision
 * to send. None of the graph, telemetry and learnings code the other hooks
 * share. It fails open: bad stdin, an error, or a decision that isn't well
 * formed all leave it silent with exit 0, so the command runs as if Trail
 * weren't here. A check that can wedge every shell command is worse than none.
 *
 * The learned-skills part (the agent guard, the save gate, the one ask
 * before a step that can't be undone) lives in pre-bash-skills.ts and is
 * loaded only past `skillsPrefilter`: a command that says `skills` or names
 * a Trail hook script, or a session with a gate file. It writes (receipts,
 * asked marks), so only the copy that answers runs it: the repo's copy
 * stands down first when the `~/.claude` copy covers the event. Every other
 * command pays one regex and one stat. `preBash` (the kept guardrails)
 * only decides: it writes nothing, and only a well-formed answer reaches
 * the host.
 */
import type * as Fs from 'node:fs';
import type * as Path from 'node:path';
import type * as Os from 'node:os';
import type * as Crypto from 'node:crypto';

/** What the hook can answer: Claude Code's PreToolUse permission decision and its reason. */
export interface PreBashDecision {
  permissionDecision: 'allow' | 'ask' | 'deny';
  reason: string;
}

const DECISIONS = new Set(['allow', 'ask', 'deny']);

/**
 * The decision for one Bash call, or null to let it run untouched. Phase 0:
 * always null. Never throws.
 */
/** A commit, a push or a PR: the commands `trail check` runs before (pre-bash-check.ts). One regex for every other command. */
// git's own options may come first: `git -C app push`, `git -c user.name="A B" commit`, `git --no-pager commit`.
export const SHIP_COMMAND = /\b(?:git(?:\s+(?:-[cC]\s*(?:[^\s"']|"[^"]*"|'[^']*')+|--[\w-]+(?:=\S+)?))*\s+(?:commit|push)|gh\s+pr\s+create)\b/;

export function preBash(_input: unknown, _dir: string): PreBashDecision | null {
  return null;
}

/** trace/host.ts's Cursor and Antigravity keys, which it checks before Codex's (a test holds the two checks together). */
const NOT_CODEX_KEYS = ['conversation_id', 'generation_id', 'cursor_version', 'workspace_roots', 'conversationId', 'artifactDirectoryPath', 'workspacePaths'];

/**
 * detectHost(input).host === 'codex', without loading trace/host.ts (the fast path loads nothing it needn't). Read
 * only for a decision about to be sent.
 */
export function codexPayload(input: unknown): boolean {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const p = input as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined && p[k] !== null;
    const raw = has('transcript_path') ? p.transcript_path : p.transcriptPath;
    const path = typeof raw === 'string' ? raw.replace(/\\/g, '/') : '';
    const file = path.slice(path.lastIndexOf('/') + 1);
    if (NOT_CODEX_KEYS.some(has) || path.includes('/.cursor/') || path.includes('/agent-transcripts/') || path.includes('/.gemini/antigravity')) return false;
    return has('turn_id') || /^rollout-.*\.jsonl(\.zst)?$/.test(file) || path.includes('/.codex/sessions/');
  } catch {
    return false;
  }
}

/**
 * The hook's stdout for `input`: the decision in Claude Code's PreToolUse
 * shape, or '' when there is none, `decide` throws, or what it returns isn't
 * a decision the host understands.
 *
 * Codex (P37, P38): its hooks can't ask (an `ask` fails the hook run and the
 * command runs, D17), so an ask goes out as a deny with the same reason; and
 * an `allow` without `updatedInput` drops the hook's whole output there, so
 * Trail never sends one. The deny is the whole output.
 */
export function preBashOutput(input: unknown, dir: string, decide: (input: unknown, dir: string) => PreBashDecision | null = preBash): string {
  try {
    const d = decide(input, dir);
    if (!d || typeof d !== 'object' || !DECISIONS.has(d.permissionDecision) || typeof d.reason !== 'string' || !d.reason) return '';
    let decision = d.permissionDecision;
    if (decision !== 'deny' && codexPayload(input)) {
      if (decision === 'allow') return '';
      decision = 'deny';
    }
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: d.reason } });
  } catch {
    return '';
  }
}

/**
 * A warning the agent reads before the command runs, with no decision: the
 * command goes through as it would have. Claude Code takes it as context;
 * Codex has no such field, so it gets nothing.
 */
export function preBashContext(input: unknown, text: string): string {
  if (!text || codexPayload(input)) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });
}

/** Shell tools by host: Claude Code's Bash (and PowerShell), Cursor's Shell, Copilot CLI's bash. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell']);

/**
 * The command of a shell call, in Claude Code's and Cursor's shape
 * (`tool_name`, `tool_input.command`) or Copilot CLI's (`toolName`,
 * `toolArgs` as JSON text or an object), or null when the payload isn't a
 * shell call. Copilot may run this hook for every tool whatever the matcher
 * says, so the hook checks for itself.
 */
export function shellCommand(input: unknown): string | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const p = input as Record<string, unknown>;
    const name = typeof p.tool_name === 'string' ? p.tool_name : typeof p.toolName === 'string' ? p.toolName : '';
    if (!SHELL_TOOLS.has(name.toLowerCase())) return null;
    let args: unknown = p.tool_input ?? p.toolArgs;
    if (typeof args === 'string') args = JSON.parse(args);
    const command = args && typeof args === 'object' ? (args as { command?: unknown }).command : undefined;
    return typeof command === 'string' && command ? command : null;
  } catch {
    return null;
  }
}

/** node:fs without an ESM import of it: Node 20.16 and later hand it over for free. */
async function nodeFs(): Promise<typeof Fs> {
  return typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:fs') : await import('node:fs');
}

/** The longest the payload may take to arrive. Hosts write it at once and close stdin; this bounds one that doesn't, well inside the 5 s the hook is given. */
export const STDIN_WAIT_MS = 2000;
/** A payload over this is read to its end and dropped: no shell command worth checking is this long. */
export const STDIN_MAX_BYTES = 2 * 1024 * 1024;

/**
 * stdin to its end, or null for a terminal (a person, not a host), an
 * oversized payload or a read error. A read that is still waiting after
 * STDIN_WAIT_MS sits in a thread Node joins before exiting, so no timer or
 * exit() gets past it: the process ends outright instead, and the command's
 * `|| exit 0` (settings-merge.ts failOpen) makes that a clean exit.
 */
function readStdin(fs: typeof Fs): Promise<string | null> {
  try {
    if (fs.fstatSync(0).isCharacterDevice()) return Promise.resolve(null);
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let size = 0;
    const timer = setTimeout(() => process.kill(process.pid, 'SIGKILL'), STDIN_WAIT_MS);
    const finish = (text: string | null) => {
      clearTimeout(timer);
      done(text);
    };
    const next = (): void => {
      fs.read(0, buf, 0, buf.length, null, (err, n) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'EAGAIN') return void setTimeout(next, 5);
        if (err && code !== 'EOF') return finish(null);
        if (err || !n) return finish(size > STDIN_MAX_BYTES ? null : Buffer.concat(chunks).toString('utf8'));
        size += n;
        if (size <= STDIN_MAX_BYTES) chunks.push(Buffer.from(buf.subarray(0, n)));
        else chunks.length = 0;
        next();
      });
    };
    next();
  });
}

/** The hook payload on stdin as an object, or null for anything else. */
async function readInput(): Promise<Record<string, unknown> | null> {
  try {
    const seam = process.env.GRAFT_TEST_STDIN;
    const text = seam !== undefined ? seam : await readStdin(await nodeFs());
    if (text === null) return null;
    const input: unknown = JSON.parse(text);
    return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `trail keep` waits for the person's answer (init/keep-gate.ts). Its check
 * is loaded only for a command that says `keep`, so no other shell command
 * pays for it, and only in the copy that answers: it writes the receipt.
 */
async function keepReply(input: Record<string, unknown>, dir: string, standsDown: () => Promise<boolean>): Promise<string> {
  const command = shellCommand(input);
  if (command === null || !/\bkeep\b/.test(command)) return '';
  // 1b (R11): the check writes the keep receipt, so the copy that stands down does so before it runs (1a rule 15).
  if (await standsDown()) return '';
  const [{ keepDecision }, { isTestHome }] = await Promise.all([import('../init/keep-gate.js'), import('../skills/host-facts.js')]);
  // b7: the receipt's time is Trail's clock (TRAIL_TEST_NOW in a test home only, 0 rule 10), the one `trail keep` reads it with.
  const fixed = process.env.TRAIL_TEST_NOW ? new Date(process.env.TRAIL_TEST_NOW) : null;
  const now = fixed && !Number.isNaN(fixed.getTime()) && isTestHome(process.env) ? fixed : new Date();
  return preBashOutput(input, dir, (i, d) => keepDecision(i, d, process.env, now));
}

/**
 * What the agent guard reads as a Trail hook script (risk.ts HOOK_SCRIPT), widened: a shim by name or glob, a
 * path under `.claude/helpers/`, a `claude/<module>.js` of the package. Every command the guard denies passes this
 * (a test holds them together). Bounded quantifiers only: the command can be 2 MB.
 */
const HOOK_SCRIPT = /(?:trail|graft)-hooks?|hooks?[*?[\]]{0,8}\.cjs|\.claude\/helpers\/|claude\/[\w-]{1,64}\.js/i;

/**
 * 1b (3.3): `timeout` with a duration, for the sure-fail guardrail. Design 3.3's `\btimeout\s+(-\S+\s+)*\d`, widened
 * so a signal name after `-s` (`timeout -s KILL 5m x`) reaches the guard too. Bounded: the command can be 2 MB.
 */
const TIMEOUT_RUN = /\btimeout\s+(?:-\S{1,40}\s+(?:[A-Za-z]{2,10}\s+)?){0,8}\d/;

/** gate-file.ts gateFilePath without loading it: the same file name for the same id (a test holds them equal). */
export function gateFilePathFast(input: Record<string, unknown>, env: NodeJS.ProcessEnv): string | null {
  const raw = [input.session_id, input.sessionId, input.conversation_id].find((v): v is string => typeof v === 'string' && v !== '');
  if (raw === undefined) return null;
  const path = process.getBuiltinModule('node:path') as typeof Path;
  const os = process.getBuiltinModule('node:os') as typeof Os;
  const crypto = process.getBuiltinModule('node:crypto') as typeof Crypto;
  const id = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(raw) ? raw : `h-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  const home = env.TRAIL_HOME ? path.resolve(env.TRAIL_HOME) : path.join(os.homedir(), '.trail');
  return path.join(home, 'sessions', `${id}.gate.json`);
}

/**
 * Design 1.7: whether the skills part has anything to look at, decided without loading it. The command
 * (read as the agent guard reads it: quotes and backslashes don't change the words) says `skills` or names a
 * Trail hook script, or this session has a gate file (a run block with a step that can't be undone is live).
 * Every other shell command pays one regex and one stat.
 */
export function skillsPrefilter(input: Record<string, unknown>, command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const words = command.replace(/\\\n/g, '').replace(/["'\\]/g, '');
    if (/\bskills\b/i.test(words) || HOOK_SCRIPT.test(words) || TIMEOUT_RUN.test(words)) return true;
    const gate = typeof process.getBuiltinModule === 'function' ? gateFilePathFast(input, env) : null;
    return gate !== null && (process.getBuiltinModule('node:fs') as typeof Fs).existsSync(gate);
  } catch {
    return false;
  }
}

/** The shim's entry: `node trail-hooks.cjs pre-bash`. Never rejects. `decide` is preBash; tests pass their own. */
export async function main(event = 'pre-bash', decide: (input: unknown, dir: string) => PreBashDecision | null = preBash): Promise<void> {
  try {
    // trail's own headless Claude calls run with this set, like every hook.
    if (process.env.TRAIL_NO_HOOKS === '1') return;
    const input = await readInput();
    const command = input ? shellCommand(input) : null;
    if (!input || command === null) return;
    const cwd = typeof input.cwd === 'string' ? input.cwd : '';
    const dir = process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
    // Registered in the repo and in ~/.claude, Claude Code runs both: one
    // answers. Copilot CLI runs only the repo's, so the payload decides first.
    const standsDown = async () => (await import('./hook-layers.js')).globalCopyCovers(event, process.argv[1], undefined, undefined, input);
    if (SHIP_COMMAND.test(command)) {
      // It writes (the session's checked mark), so only the copy that answers runs it.
      if (await standsDown()) return;
      const { shipCheck } = await import('./pre-bash-check.js');
      const decision = shipCheck(input, dir, command);
      const reply = decision && 'warn' in decision ? preBashContext(input, decision.warn) : preBashOutput(input, dir, () => decision);
      if (reply) return void process.stdout.write(reply);
    }
    if (skillsPrefilter(input, command)) {
      // The skills part writes (receipts, asked marks): only the copy that answers runs it.
      if (await standsDown()) return;
      const { preBashSkills } = await import('./pre-bash-skills.js');
      const decision = await preBashSkills(input, dir, process.env, command);
      const reply = preBashOutput(input, dir, () => decision);
      if (reply) return void process.stdout.write(reply);
    }
    const reply = preBashOutput(input, dir, decide) || (await keepReply(input, cwd, standsDown));
    if (!reply || (await standsDown())) return;
    process.stdout.write(reply);
  } catch {
    // Never stand in the way of a command over our own failure.
  }
}
