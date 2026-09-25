/**
 * Claude Code transport: runs the unmodified `claude` binary in headless mode
 * (`claude -p`), so `graft build --deep` can run on the user's own Claude
 * subscription instead of an API key.
 *
 * Why a process and not an SDK. Anthropic lets an end user sign in to the
 * unmodified Claude Code binary with their own subscription, but a third-party
 * tool may not collect, store or intermediate Claude.ai credentials or session
 * tokens (https://code.claude.com/docs/en/legal-and-compliance, "Authentication
 * and credential use"). So graft never reads `~/.claude/.credentials.json` or a
 * keychain entry, never holds an OAuth token, and never calls the API itself: it
 * launches `claude -p`, writes the prompt to its stdin and parses the JSON it
 * prints. Claude Code owns the sign-in end to end.
 *
 * Isolation. A bare `claude -p` loads the user's and the project's settings, so
 * every call would run their hooks (a SessionEnd hook that writes a session log,
 * desktop notifications, graft's own hooks recursing into graft), start their MCP
 * servers and read CLAUDE.md. Each call therefore:
 *   - loads no settings files, MCP servers, tools or skills, and saves no session
 *     (see {@link claudeArgs});
 *   - replaces Claude Code's agent prompt with the caller's system messages;
 *   - runs in a fresh, empty temp directory, never the repo being indexed;
 *   - drops the variables that tie a process to a parent Claude Code session
 *     (see {@link childEnv}) and turns off claude.ai MCP connectors.
 * `--bare` would cover most of this in one flag, but it accepts only
 * ANTHROPIC_API_KEY, which defeats the point.
 *
 * Mapping. Only the one-shot shape graft sends is supported: system messages plus
 * one user message. The `tool` and `json` response formats become `--json-schema`,
 * and the validated `structured_output` comes back as the forced tool call (or as
 * JSON text), the way the Anthropic adapter returns them. `temperature`,
 * `maxTokens` and cache breakpoints have no `claude -p` equivalent and are
 * dropped. A multi-turn or tool-loop request throws.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transportRetries } from "./types.js";
import type { ChatModel, ChatRequest, ChatResponse, ToolCall, Usage } from "./types.js";

const PROVIDER = "claude-code";

/** Used when a request carries no system message, so Claude Code's own agent
 * prompt (tools, environment, working directory) is never what the model sees. */
const DEFAULT_SYSTEM = "You are a helpful assistant.";

/** Matches the Anthropic SDK's default request timeout. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** One `claude` invocation. */
export interface ClaudeRun {
  bin: string;
  args: string[];
  /** Written to the child's stdin, which is then closed. */
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ClaudeRunResult {
  /** Null when the child was killed by a signal (a timeout included). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Launches `claude` and collects its output. Tests inject a fake so no real process starts. */
export type ClaudeRunner = (run: ClaudeRun) => Promise<ClaudeRunResult>;

/** Launches `claude` with inherited stdio and resolves to its exit code (login, setup-token). */
export type InteractiveRunner = (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

/** The `claude` executable: `GRAFT_CLAUDE_CODE_BIN`, else `claude` on PATH. */
export function claudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.GRAFT_CLAUDE_CODE_BIN || "claude";
}

function timeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.GRAFT_CLAUDE_CODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

/** The default {@link ClaudeRunner}: `spawn` with no shell, stdin piped, killed on timeout. */
export const spawnClaude: ClaudeRunner = (run) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(run.bin, run.args, {
      cwd: run.cwd,
      env: run.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, run.timeoutMs);
    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
    };
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      if (settled) return;
      finish();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      finish();
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    // A child that exits before reading all of stdin raises EPIPE here; its exit
    // status and output already say what went wrong.
    child.stdin.on("error", () => {});
    child.stdin.end(run.input);
  });

/** The default {@link InteractiveRunner}: the child owns the terminal, graft sees only the exit code. */
export const spawnInteractive: InteractiveRunner = (bin, args, env) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { env, shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });

/**
 * Arguments for one headless call. Each isolation flag was checked against Claude
 * Code 2.1.281 by running it in a directory holding canary hooks, an MCP server and
 * a CLAUDE.md, with a control run that loaded them:
 *   - `--setting-sources ""` loads no user, project or local settings, so none of
 *     their hooks run;
 *   - `--strict-mcp-config` with no `--mcp-config` starts no MCP servers;
 *   - `--tools ""` offers the model no tools (structured output still works);
 *   - `--disable-slash-commands` loads no skills;
 *   - `--no-session-persistence` writes no transcript under `~/.claude/projects`.
 * The prompt is not an argument: it goes to stdin, since file contents can be large.
 */
export function claudeArgs(o: { model: string; system: string; schema?: Record<string, unknown> }): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    o.model,
    "--system-prompt",
    o.system,
    ...(o.schema ? ["--json-schema", JSON.stringify(o.schema)] : []),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

/**
 * Variables that tie a process to the Claude Code session graft was started from.
 * Inherited, they would mark the child as nested inside that session, hand it the
 * session's messaging socket and token, or carry over its effort level.
 *
 * Sign-in variables (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR)
 * are deliberately not here. They pass through untouched and unread: how Claude
 * Code signs in is the user's choice, not graft's.
 */
export const SCRUBBED_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
] as const;

/** The environment every `claude` child runs with. */
export function childEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const k of SCRUBBED_ENV) delete env[k];
  // claude.ai connectors are MCP servers too; without this each call fetches the list.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return env;
}

/** A failed call. `transient` failures are retried; the rest reach the caller at once. */
export class ClaudeCodeError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = "ClaudeCodeError";
  }
}

/**
 * The subscription's usage window or credit is spent. Never retried: every further
 * call would fail the same way until the reset. The message starts with
 * "Claude Code usage limit reached", which the deep pass's failure gate treats as
 * terminal (`ai/failure.ts`).
 */
export class ClaudeCodeUsageLimitError extends Error {
  constructor(detail: string) {
    super(
      `Claude Code usage limit reached: ${detail}. Graft stopped instead of retrying; ` +
        "re-run `graft build --deep` after the limit resets, and it resumes from what is cached.",
    );
    this.name = "ClaudeCodeUsageLimitError";
  }
}

/** Claude Code's wording when a subscription window or credit is spent ("You've hit your session limit · resets 3pm"). */
const USAGE_LIMIT = /you['’]ve hit your|usage limit|(?:session|weekly|5-hour|7-day) limit|out of (?:extra )?usage/i;
/** Not signed in, or the sign-in was rejected. */
const SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token (?:has )?(?:expired|revoked)|\b401\b|authentication[_ ]error/i;
/** Worth another try: overload, server errors, rate limits, dropped connections. */
const TRANSIENT = /overloaded|\b(?:429|5\d\d)\b|rate[_ ]limit|internal server error|service unavailable|bad gateway|econnreset|econnrefused|etimedout|eai_again|socket hang up|fetch failed|network/i;

/** Turn a failed call's detail into the error the caller sees. */
export function classifyFailure(detail: string, apiStatus?: number | null): Error {
  const text = detail.trim() || "claude -p failed with no output";
  if (USAGE_LIMIT.test(text)) return new ClaudeCodeUsageLimitError(text);
  if (SIGNED_OUT.test(text)) {
    return new ClaudeCodeError(`Claude Code is not signed in (${text}). Run \`graft auth login\`.`, false);
  }
  const transient = TRANSIENT.test(text) || (typeof apiStatus === "number" && (apiStatus === 429 || apiStatus >= 500));
  return new ClaudeCodeError(`claude -p: ${text}`, transient);
}

/** The fields of `claude -p --output-format json` that graft reads. */
interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  api_error_status?: number | null;
  total_cost_usd?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** The result object from stdout: the whole of it, or else its last line that is one. */
export function parseResult(stdout: string): ClaudeResult | undefined {
  const isResult = (v: unknown): v is ClaudeResult =>
    !!v && typeof v === "object" && (v as ClaudeResult).type === "result";
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(stdout.trim());
  if (isResult(whole)) return whole;
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = tryParse(lines[i].trim());
    if (isResult(v)) return v;
  }
  return undefined;
}

function tail(s: string, lines = 5): string {
  return s.trim().split("\n").slice(-lines).join(" | ");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeUsage(u: ClaudeResult["usage"]): Usage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheCreate: u?.cache_creation_input_tokens ?? 0,
  };
}

/** Exponential backoff between retries, capped at 30 s. */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt);
}

export interface ClaudeCodeChatModelOptions {
  /** A Claude Code model alias (`sonnet`, `opus`) or a full model id. */
  model: string;
  label?: string;
  /** Default: {@link claudeBin}. */
  bin?: string;
  /** Default: {@link spawnClaude}. Tests pass a fake. */
  runner?: ClaudeRunner;
  /** Per-call timeout. Default: `GRAFT_CLAUDE_CODE_TIMEOUT_MS`, else 10 minutes. */
  timeoutMs?: number;
  /** Retries for transient failures. Default: {@link transportRetries}. */
  retries?: number;
  /** Waits between retries. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Parent environment for the child. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export class ClaudeCodeChatModel implements ChatModel {
  readonly label: string;
  /** Calls that returned a result. */
  calls = 0;
  /** Sum of the `total_cost_usd` Claude Code reported. On a subscription this is the
   * API-price equivalent of the usage, not a charge. */
  totalCostUsd = 0;
  private model: string;
  private bin: string;
  private runner: ClaudeRunner;
  private timeoutMs: number;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;
  private env: NodeJS.ProcessEnv;

  constructor(opts: ClaudeCodeChatModelOptions) {
    this.model = opts.model;
    this.label = opts.label ?? `${PROVIDER}:${opts.model}`;
    this.env = opts.env ?? process.env;
    this.bin = opts.bin ?? claudeBin(this.env);
    this.runner = opts.runner ?? spawnClaude;
    this.timeoutMs = opts.timeoutMs ?? timeoutMs(this.env);
    this.retries = opts.retries ?? transportRetries();
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async create(req: ChatRequest): Promise<ChatResponse> {
    const { system, prompt } = splitMessages(req);
    const fmt = req.responseFormat ?? { kind: "text" };
    let schema: Record<string, unknown> | undefined;
    if (fmt.kind === "tool") {
      const tool = req.tools?.find((t) => t.name === fmt.name);
      if (!tool) throw new Error(`claude-code: the forced tool "${fmt.name}" is not in the request's tools`);
      schema = tool.parameters;
    } else {
      if (req.tools?.length) throw unsupported("tools the model may call freely (a tool loop)");
      if (fmt.kind === "json") schema = { type: "object" };
    }

    const args = claudeArgs({ model: this.model, system, schema });
    const result = await this.runWithRetries(args, prompt);
    return this.toResponse(result, fmt);
  }

  private async runWithRetries(args: string[], prompt: string): Promise<ClaudeResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runOnce(args, prompt);
      } catch (err) {
        const retry = err instanceof ClaudeCodeError && err.transient && attempt < this.retries;
        if (!retry) throw err;
        await this.sleep(backoffMs(attempt));
      }
    }
  }

  private async runOnce(args: string[], prompt: string): Promise<ClaudeResult> {
    // A fresh empty directory per call: no CLAUDE.md or .claude/ in reach, and the
    // repo being indexed is never Claude Code's working directory.
    const cwd = mkdtempSync(join(tmpdir(), "graft-claude-"));
    try {
      let res: ClaudeRunResult;
      try {
        res = await this.runner({
          bin: this.bin,
          args,
          input: prompt,
          cwd,
          env: childEnv(this.env),
          timeoutMs: this.timeoutMs,
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") throw new ClaudeCodeError(notInstalledMessage(this.bin), false);
        // EAGAIN, EMFILE: the machine is short of processes or file handles right now.
        throw new ClaudeCodeError(`could not start ${this.bin}: ${e.message}`, true);
      }
      if (res.timedOut) {
        throw new ClaudeCodeError(`claude -p timed out after ${Math.round(this.timeoutMs / 1000)}s`, true);
      }
      const parsed = parseResult(res.stdout);
      if (!parsed) {
        // No result object: the process crashed or was killed before it printed one.
        const detail = tail(res.stderr) || tail(res.stdout) || `exited with code ${res.code}`;
        const err = classifyFailure(detail);
        // Killed by a signal (the OOM killer, a stray SIGTERM): worth another try.
        if (res.code === null && err instanceof ClaudeCodeError) throw new ClaudeCodeError(err.message, true);
        throw err;
      }
      if (parsed.is_error || parsed.subtype !== "success" || res.code !== 0) {
        throw classifyFailure(parsed.result || parsed.subtype || tail(res.stderr), parsed.api_error_status);
      }
      return parsed;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  private toResponse(r: ClaudeResult, fmt: NonNullable<ChatRequest["responseFormat"]>): ChatResponse {
    this.calls++;
    if (typeof r.total_cost_usd === "number") this.totalCostUsd += r.total_cost_usd;

    let text = r.result ?? "";
    let toolCalls: ToolCall[] = [];
    if (fmt.kind === "tool" && isObject(r.structured_output)) {
      toolCalls = [{ id: r.session_id ?? `${PROVIDER}-${this.calls}`, name: fmt.name, args: r.structured_output }];
      text = "";
    } else if (fmt.kind === "json" && isObject(r.structured_output)) {
      text = JSON.stringify(r.structured_output);
    }

    return {
      text,
      toolCalls,
      usage: normalizeUsage(r.usage),
      stopReason: r.stop_reason ?? null,
      costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
      assistant: { role: "assistant", content: text, toolCalls: toolCalls.length ? toolCalls : undefined },
    };
  }
}

function unsupported(what: string): Error {
  return new Error(
    `claude-code: ${what} is not supported. This provider runs one-shot requests ` +
      "(system messages plus one user message); use an API provider for anything else.",
  );
}

/** System messages become `--system-prompt`; the one user message becomes stdin. */
function splitMessages(req: ChatRequest): { system: string; prompt: string } {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = req.messages.filter((m) => m.role !== "system");
  if (rest.length !== 1 || rest[0].role !== "user") {
    const shape = rest.map((m) => m.role).join(", ") || "no messages";
    throw unsupported(`a conversation of [${shape}] after the system prompt`);
  }
  return { system: system.join("\n\n") || DEFAULT_SYSTEM, prompt: rest[0].content };
}

/** What to tell someone whose `claude` binary cannot be found. */
export function notInstalledMessage(bin: string): string {
  return (
    `Claude Code (\`${bin}\`) was not found. Install it (https://code.claude.com/docs/en/setup), ` +
    "then run `graft auth login`."
  );
}

/** What `claude auth status --json` says, minus anything that identifies the account. */
export interface ClaudeCodeStatus {
  installed: boolean;
  loggedIn: boolean;
  /** `claude.ai` (subscription sign-in), `oauth_token` (CLAUDE_CODE_OAUTH_TOKEN), `none`, … */
  authMethod?: string;
  /** `firstParty`, or a cloud provider such as `bedrock`. */
  apiProvider?: string;
  /** `pro`, `max`, … when signed in with a subscription. */
  subscriptionType?: string;
  /** Set when an API key takes precedence over the sign-in, e.g. `ANTHROPIC_API_KEY`. */
  apiKeySource?: string;
  /** Why the status could not be read, when it could not. */
  error?: string;
}

/**
 * Ask Claude Code whether it is signed in. Only the fields listed in
 * {@link ClaudeCodeStatus} are kept, so the email address and organization never
 * reach graft's output.
 */
export async function claudeCodeStatus(
  opts: { runner?: ClaudeRunner; bin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ClaudeCodeStatus> {
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? claudeBin(env);
  const runner = opts.runner ?? spawnClaude;
  const cwd = mkdtempSync(join(tmpdir(), "graft-claude-"));
  try {
    let res: ClaudeRunResult;
    try {
      res = await runner({ bin, args: ["auth", "status", "--json"], input: "", cwd, env: childEnv(env), timeoutMs: 30_000 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return { installed: false, loggedIn: false, error: notInstalledMessage(bin) };
      return { installed: false, loggedIn: false, error: `could not start ${bin}: ${e.message}` };
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(res.stdout) as Record<string, unknown>;
    } catch {
      const detail = tail(res.stderr) || tail(res.stdout) || `exit code ${res.code}`;
      return { installed: true, loggedIn: false, error: `could not read \`${bin} auth status\`: ${detail}` };
    }
    const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
    return {
      installed: true,
      loggedIn: raw.loggedIn === true,
      authMethod: str(raw.authMethod),
      apiProvider: str(raw.apiProvider),
      subscriptionType: str(raw.subscriptionType),
      apiKeySource: str(raw.apiKeySource),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** One line on how Claude Code will bill, e.g. "signed in with a Claude Max subscription". */
export function describeSignIn(s: ClaudeCodeStatus): string {
  if (!s.installed) return "Claude Code is not installed";
  if (!s.loggedIn) return "Claude Code is not signed in";
  if (s.apiKeySource) return `Claude Code will use the API key from ${s.apiKeySource} (billed as API usage)`;
  if (s.authMethod === "claude.ai") {
    const plan = s.subscriptionType ? `Claude ${s.subscriptionType[0].toUpperCase()}${s.subscriptionType.slice(1)}` : "Claude";
    return `signed in with a ${plan} subscription`;
  }
  if (s.authMethod === "oauth_token") return "signed in with a long-lived token from CLAUDE_CODE_OAUTH_TOKEN";
  if (s.apiProvider && s.apiProvider !== "firstParty") return `signed in through ${s.apiProvider}`;
  return `signed in (${s.authMethod ?? "unknown method"})`;
}

/**
 * Check before a deep build that Claude Code can serve it. Returns the reason it
 * cannot, pointing at `graft auth login`, or null when it can.
 */
export function preflightProblem(s: ClaudeCodeStatus): string | null {
  if (!s.installed) return s.error ?? notInstalledMessage("claude");
  if (s.error) return `${s.error}. Run \`graft auth status\` to check the sign-in.`;
  if (!s.loggedIn) return "Claude Code is not signed in. Run `graft auth login`, then re-run the build.";
  return null;
}
