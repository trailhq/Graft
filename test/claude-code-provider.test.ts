/**
 * The claude-code provider, with a fake process runner: no test here starts a real
 * `claude`. Covered: the arguments and isolation flags, the prompt on stdin, the
 * JSON-schema → tool-call mapping as graft's own callers read it, usage and cost,
 * timeout / retry / usage-limit handling, the factory and config needing no key,
 * and `graft auth` dispatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ClaudeCodeChatModel,
  ClaudeCodeError,
  ClaudeCodeUsageLimitError,
  childEnv,
  claudeArgs,
  claudeCodeStatus,
  classifyFailure,
  describeSignIn,
  parseResult,
  preflightProblem,
  type ClaudeRun,
  type ClaudeRunResult,
} from "../src/ai/llm/claude-code.js";
import { runAuth } from "../src/ai/claude-code-auth.js";
import { createChatModel, providerNeedsKey } from "../src/ai/llm/factory.js";
import { resolveConfig, DEFAULT_MODELS } from "../src/ai/providers.js";
import { LlmFailureGate, terminalReason } from "../src/ai/failure.js";
import { ChatCruxSummarizer } from "../src/ai/crux.js";
import { ChatSynthesizer } from "../src/ai/synthesize.js";
import { ChatSummarizer } from "../src/ai/summarize.js";
import { ChatNamer } from "../src/blast/name.js";
import type { ChatRequest } from "../src/ai/llm/types.js";

/** A `claude -p --output-format json` result, as Claude Code 2.1.281 prints it. */
function result(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "hello",
    stop_reason: "end_turn",
    session_id: "sess-1",
    total_cost_usd: 0.0125,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
    ...over,
  });
}

/** A runner that records each run and answers from a script, one entry per call. */
function fakeRunner(script: Array<Partial<ClaudeRunResult> | Error>) {
  const runs: ClaudeRun[] = [];
  const cwdExisted: boolean[] = [];
  const runner = async (run: ClaudeRun): Promise<ClaudeRunResult> => {
    runs.push(run);
    cwdExisted.push(existsSync(run.cwd));
    const next = script[Math.min(runs.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return { code: 0, stdout: result(), stderr: "", timedOut: false, ...next };
  };
  return { runner, runs, cwdExisted };
}

function model(script: Array<Partial<ClaudeRunResult> | Error>, over: { retries?: number; env?: NodeJS.ProcessEnv } = {}) {
  const fake = fakeRunner(script);
  const sleeps: number[] = [];
  const m = new ClaudeCodeChatModel({
    model: "sonnet",
    runner: fake.runner,
    retries: over.retries ?? 3,
    sleep: async (ms) => void sleeps.push(ms),
    env: over.env ?? { PATH: "/usr/bin" },
    timeoutMs: 1234,
  });
  return { m, sleeps, ...fake };
}

const TEXT_REQ: ChatRequest = {
  messages: [
    { role: "system", content: "You summarize code." },
    { role: "user", content: "File: src/a.ts\n\nexport const a = 1;" },
  ],
  temperature: 0,
  maxTokens: 2048,
};

/** The value that follows `flag` in argv. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// --- arguments and isolation --------------------------------------------------

test("claude-code: argv carries -p, JSON output, the model, the system prompt and every isolation flag", () => {
  const args = claudeArgs({ model: "sonnet", system: "SYS" });
  assert.equal(args[0], "-p");
  assert.equal(flagValue(args, "--output-format"), "json");
  assert.equal(flagValue(args, "--model"), "sonnet");
  assert.equal(flagValue(args, "--system-prompt"), "SYS");
  assert.equal(flagValue(args, "--setting-sources"), "", "no user, project or local settings");
  assert.equal(flagValue(args, "--tools"), "", "no tools");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--mcp-config"), "strict MCP with no config means no servers");
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(!args.includes("--bare"), "--bare only accepts ANTHROPIC_API_KEY");
  assert.ok(!args.includes("--json-schema"));
  // `--tools` is variadic: the value after its "" must be another flag, never a word.
  assert.ok(args[args.indexOf("--tools") + 2]?.startsWith("--"));
});

test("claude-code: each call runs in its own fresh temp directory, never the caller's cwd, removed afterwards", async () => {
  const { m, runs, cwdExisted } = model([{}]);
  await m.create(TEXT_REQ);
  await m.create(TEXT_REQ);
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].cwd, runs[1].cwd);
  for (const r of runs) {
    assert.notEqual(resolve(r.cwd), resolve(process.cwd()));
    assert.ok(!resolve(r.cwd).startsWith(resolve(process.cwd())), "not inside the repo either");
    assert.ok(!existsSync(r.cwd), "cleaned up after the call");
  }
  assert.deepEqual(cwdExisted, [true, true], "and existed while claude ran");
  assert.equal(runs[0].bin, "claude");
  assert.equal(runs[0].timeoutMs, 1234);
});

test("claude-code: the child env drops the parent session's variables and keeps sign-in variables untouched", () => {
  const env = childEnv({
    PATH: "/usr/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "parent",
    CLAUDE_CODE_MESSAGING_SOCKET: "/run/sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "t",
    CLAUDE_EFFORT: "xhigh",
    CLAUDE_CODE_OAUTH_TOKEN: "user-set",
    ANTHROPIC_API_KEY: "user-set",
    CLAUDE_CONFIG_DIR: "/cfg",
  });
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_EFFORT"]) {
    assert.equal(env[k], undefined, k);
  }
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "user-set");
  assert.equal(env.ANTHROPIC_API_KEY, "user-set");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

test("claude-code: GRAFT_CLAUDE_CODE_BIN and GRAFT_CLAUDE_CODE_TIMEOUT_MS configure the child", async () => {
  const fake = fakeRunner([{}]);
  const m = new ClaudeCodeChatModel({
    model: "sonnet",
    runner: fake.runner,
    env: { GRAFT_CLAUDE_CODE_BIN: "/opt/claude", GRAFT_CLAUDE_CODE_TIMEOUT_MS: "5000" },
  });
  await m.create(TEXT_REQ);
  assert.equal(fake.runs[0].bin, "/opt/claude");
  assert.equal(fake.runs[0].timeoutMs, 5000);
});

// --- prompt delivery ------------------------------------------------------------

test("claude-code: the user message goes to stdin, never argv; system messages go to --system-prompt", async () => {
  const { m, runs } = model([{}]);
  await m.create({
    messages: [
      { role: "system", content: "one" },
      { role: "system", content: "two" },
      { role: "user", content: "the file body" },
    ],
  });
  assert.equal(runs[0].input, "the file body");
  assert.ok(!runs[0].args.some((a) => a.includes("the file body")));
  assert.equal(flagValue(runs[0].args, "--system-prompt"), "one\n\ntwo");
});

test("claude-code: with no system message, Claude Code's agent prompt is still replaced", async () => {
  const { m, runs } = model([{}]);
  await m.create({ messages: [{ role: "user", content: "hi" }] });
  assert.ok(flagValue(runs[0].args, "--system-prompt"));
});

test("claude-code: multi-turn and tool-loop requests throw before starting a process", async () => {
  const { m, runs } = model([{}]);
  await assert.rejects(
    m.create({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    }),
    /one-shot requests/,
  );
  await assert.rejects(
    m.create({
      messages: [{ role: "user", content: "a" }],
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    }),
    /tool loop/,
  );
  await assert.rejects(
    m.create({
      messages: [{ role: "user", content: "a" }],
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
      responseFormat: { kind: "tool", name: "other" },
    }),
    /forced tool "other"/,
  );
  assert.equal(runs.length, 0);
});

// --- structured output ----------------------------------------------------------

test("claude-code: a forced tool becomes --json-schema, and structured_output comes back as that tool's call", async () => {
  const schema = { type: "object", properties: { nodes: { type: "array" } }, required: ["nodes"] };
  const { m, runs } = model([
    { stdout: result({ result: '{"nodes":[1]}', structured_output: { nodes: [1] }, stop_reason: "tool_use" }) },
  ]);
  const res = await m.create({
    messages: [{ role: "user", content: "go" }],
    tools: [{ name: "record_graph", description: "d", parameters: schema }],
    responseFormat: { kind: "tool", name: "record_graph" },
  });
  assert.deepEqual(JSON.parse(flagValue(runs[0].args, "--json-schema")!), schema);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, "record_graph");
  assert.deepEqual(res.toolCalls[0].args, { nodes: [1] });
  assert.equal(res.text, "");
  assert.equal(res.stopReason, "tool_use");
  assert.deepEqual(res.assistant.toolCalls, res.toolCalls);
});

test("claude-code: a tool reply without structured_output leaves the text for the callers' JSON recovery", async () => {
  const { m } = model([{ stdout: result({ result: '```json\n{"symbols":[]}\n```' }) }]);
  const res = await m.create({
    messages: [{ role: "user", content: "go" }],
    tools: [{ name: "record_symbols", description: "d", parameters: { type: "object" } }],
    responseFormat: { kind: "tool", name: "record_symbols" },
  });
  assert.deepEqual(res.toolCalls, []);
  assert.match(res.text, /symbols/);
});

test("claude-code: json format uses a permissive object schema and returns the object as JSON text", async () => {
  const { m, runs } = model([{ stdout: result({ structured_output: { a: 1 } }) }]);
  const res = await m.create({ messages: [{ role: "user", content: "go" }], responseFormat: { kind: "json" } });
  assert.deepEqual(JSON.parse(flagValue(runs[0].args, "--json-schema")!), { type: "object" });
  assert.deepEqual(JSON.parse(res.text), { a: 1 });
  assert.deepEqual(res.toolCalls, []);
});

test("claude-code: text format passes no schema and returns the result text", async () => {
  const { m, runs } = model([{ stdout: result({ result: "A short summary." }) }]);
  const res = await m.create(TEXT_REQ);
  assert.ok(!runs[0].args.includes("--json-schema"));
  assert.equal(res.text, "A short summary.");
});

test("claude-code: graft's crux, synthesis, summary and naming callers read its replies", async () => {
  const cruxModel = model([
    {
      stdout: result({
        structured_output: { symbols: [{ id: "src/a.ts#a", summary: "Holds the answer.", crux_start: 0, crux_end: 0 }] },
      }),
    },
  ]);
  const crux = new ChatCruxSummarizer(cruxModel.m);
  const syms = await crux.describeFile({
    path: "src/a.ts",
    source: "export const a = 42;",
    nodes: [{ id: "src/a.ts#a", kind: "function", signature: null, startLine: 1, endLine: 1 }],
  });
  assert.deepEqual(syms, [{ id: "src/a.ts#a", summary: "Holds the answer.", crux_start: 0, crux_end: 0 }]);
  assert.equal(crux.lastMiss, null);
  assert.match(cruxModel.runs[0].input, /id=src\/a\.ts#a/);

  const synthModel = model([
    {
      stdout: result({
        structured_output: { nodes: [{ name: "Answers", type: "concept", summary: "s", sources: ["src/a.ts"], links: [] }] },
      }),
    },
  ]);
  const nodes = await new ChatSynthesizer(synthModel.m).synthesize([{ path: "src/a.ts", summary: "sum" }]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, "Answers");

  const sumModel = model([{ stdout: result({ result: "  It holds the answer.  " }) }]);
  assert.equal(await new ChatSummarizer(sumModel.m).summarize("x", { path: "src/a.ts" }), "It holds the answer.");

  const nameModel = model([{ stdout: result({ structured_output: { names: [{ key: "k1", name: "Answer Store" }] } }) }]);
  const names = await new ChatNamer(nameModel.m).name([{ key: "k1", files: ["src/a.ts"], symbols: ["a"] }]);
  assert.equal(names.get("k1"), "Answer Store");
});

// --- usage and cost ---------------------------------------------------------------

test("claude-code: usage, stop reason and cost come from the JSON result; the label is claude-code:<model>", async () => {
  const { m } = model([{}]);
  const res = await m.create(TEXT_REQ);
  assert.deepEqual(res.usage, { input: 120, output: 30, cacheRead: 7, cacheCreate: 3 });
  assert.equal(res.stopReason, "end_turn");
  assert.equal(res.costUsd, 0.0125);
  await m.create(TEXT_REQ);
  assert.equal(m.calls, 2);
  assert.ok(Math.abs(m.totalCostUsd - 0.025) < 1e-9);
  assert.equal(m.label, "claude-code:sonnet");
});

test("claude-code: a result with no usage or cost still maps to zeros", async () => {
  const { m } = model([{ stdout: JSON.stringify({ type: "result", subtype: "success", result: "x" }) }]);
  const res = await m.create(TEXT_REQ);
  assert.deepEqual(res.usage, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  assert.equal(res.costUsd, undefined);
  assert.equal(res.stopReason, null);
});

test("claude-code: the result object is found even behind other stdout lines", () => {
  assert.equal(parseResult(`warning: something\n${result({ result: "late" })}\n`)?.result, "late");
  assert.equal(parseResult("not json"), undefined);
});

// --- failures -----------------------------------------------------------------------

test("claude-code: a timeout is retried with backoff, then reported", async () => {
  const { m, runs, sleeps } = model([{ timedOut: true, code: null, stdout: "" }], { retries: 2 });
  await assert.rejects(m.create(TEXT_REQ), /timed out after 1s/);
  assert.equal(runs.length, 3, "one call plus two retries");
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("claude-code: a transient API error is retried and the retry's answer returned", async () => {
  const { m, runs } = model([
    { code: 1, stdout: result({ is_error: true, result: "API Error: 529 Overloaded", api_error_status: 529 }) },
    { stdout: result({ result: "second time" }) },
  ]);
  const res = await m.create(TEXT_REQ);
  assert.equal(res.text, "second time");
  assert.equal(runs.length, 2);
});

test("claude-code: a process killed before printing a result is retried", async () => {
  const { m, runs } = model([{ code: null, stdout: "", stderr: "" }, {}]);
  await m.create(TEXT_REQ);
  assert.equal(runs.length, 2);
});

test("claude-code: GRAFT_LLM_RETRIES-style retries of 0 means one attempt only", async () => {
  const { m, runs } = model([{ timedOut: true, code: null, stdout: "" }], { retries: 0 });
  await assert.rejects(m.create(TEXT_REQ), ClaudeCodeError);
  assert.equal(runs.length, 1);
});

test("claude-code: a spent subscription stops at once with an actionable message, no retry", async () => {
  const { m, runs, sleeps } = model([
    { code: 1, stdout: result({ is_error: true, result: "You've hit your session limit · resets 3pm", api_error_status: 429 }) },
  ]);
  const err = await m.create(TEXT_REQ).then(
    () => assert.fail("expected a usage-limit error"),
    (e: unknown) => e as Error,
  );
  assert.ok(err instanceof ClaudeCodeUsageLimitError);
  assert.match(err.message, /usage limit reached: You've hit your session limit · resets 3pm/);
  assert.match(err.message, /re-run `graft build --deep` after the limit resets/);
  assert.equal(runs.length, 1);
  assert.deepEqual(sleeps, []);

  // The deep pass's gate treats it as terminal, and says why in subscription terms.
  assert.match(terminalReason(err.message) ?? "", /Claude subscription's usage limit/);
  const gate = new LlmFailureGate();
  gate.record(err.message);
  assert.ok(gate.stopped);
});

test("claude-code: usage-limit wordings from the Claude Code binary are all recognised", () => {
  for (const msg of [
    "You've hit your weekly limit · resets Mon 9am",
    "Claude AI usage limit reached|1790400000",
    "You're out of extra usage · resets 3pm",
    "Your org is out of usage · add funds to continue",
  ]) {
    assert.ok(classifyFailure(msg) instanceof ClaudeCodeUsageLimitError, msg);
  }
  const rate = classifyFailure("API Error: 429 rate_limit_error");
  assert.ok(rate instanceof ClaudeCodeError && rate.transient, "a plain rate limit is transient");
  const long = classifyFailure("Prompt is too long");
  assert.ok(long instanceof ClaudeCodeError && !long.transient);
});

test("claude-code: signed out is not retried and points at graft auth login", async () => {
  const { m, runs } = model([{ code: 1, stdout: result({ is_error: true, result: "Not logged in · Please run /login" }) }]);
  await assert.rejects(m.create(TEXT_REQ), /not signed in .*graft auth login/);
  assert.equal(runs.length, 1);
  assert.match(terminalReason("Claude Code is not signed in (x). Run `graft auth login`.") ?? "", /graft auth login/);
});

test("claude-code: a missing binary says how to install it and is not retried", async () => {
  const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const { m, runs } = model([enoent]);
  await assert.rejects(m.create(TEXT_REQ), /was not found\. Install it/);
  assert.equal(runs.length, 1);
});

// --- factory and config -------------------------------------------------------------

test("claude-code: the factory builds it with no API key; key providers still require one", () => {
  const m = createChatModel({ provider: "claude-code", model: "sonnet" });
  assert.ok(m instanceof ClaudeCodeChatModel);
  assert.equal(m.label, "claude-code:sonnet");
  assert.equal(providerNeedsKey("claude-code"), false);
  assert.equal(providerNeedsKey("anthropic"), true);
  assert.throws(() => createChatModel({ provider: "anthropic", model: "m" }), /needs an API key/);
});

test("claude-code: resolveConfig holds no key for it, even with GRAFT_API_KEY set, and defaults to sonnet", () => {
  const saved = { key: process.env.GRAFT_API_KEY, model: process.env.GRAFT_MODEL };
  process.env.GRAFT_API_KEY = "sk-should-not-be-used";
  delete process.env.GRAFT_MODEL;
  try {
    const cfg = resolveConfig({ provider: "claude-code" });
    assert.equal(cfg.apiKey, undefined);
    assert.equal(cfg.model, "sonnet");
    assert.equal(cfg.usedLegacyEnv, false);
    assert.equal(DEFAULT_MODELS["claude-code"], "sonnet");
    // Other providers are unaffected.
    assert.equal(resolveConfig({ provider: "anthropic" }).apiKey, "sk-should-not-be-used");
  } finally {
    if (saved.key === undefined) delete process.env.GRAFT_API_KEY;
    else process.env.GRAFT_API_KEY = saved.key;
    if (saved.model !== undefined) process.env.GRAFT_MODEL = saved.model;
  }
});

// --- sign-in status and graft auth ----------------------------------------------------

const STATUS_JSON = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "someone@example.com",
  orgId: "org-123",
  orgName: "Example Org",
  subscriptionType: "max",
});

test("claude-code: status keeps only the sign-in method and plan, never the email or organization", async () => {
  const fake = fakeRunner([{ stdout: STATUS_JSON }]);
  const s = await claudeCodeStatus({ runner: fake.runner, env: { CLAUDECODE: "1" } });
  assert.deepEqual(fake.runs[0].args, ["auth", "status", "--json"]);
  assert.equal(fake.runs[0].env.CLAUDECODE, undefined);
  assert.equal(JSON.stringify(s).includes("example"), false);
  assert.equal(JSON.stringify(s).includes("org-123"), false);
  assert.equal(describeSignIn(s), "signed in with a Claude Max subscription");
  assert.equal(preflightProblem(s), null);
});

test("claude-code: preflight fails early, pointing at graft auth login, when signed out or not installed", async () => {
  const out = fakeRunner([{ code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) }]);
  const signedOut = await claudeCodeStatus({ runner: out.runner });
  assert.match(preflightProblem(signedOut) ?? "", /not signed in\. Run `graft auth login`/);

  const missing = fakeRunner([Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })]);
  const notInstalled = await claudeCodeStatus({ runner: missing.runner });
  assert.equal(notInstalled.installed, false);
  assert.match(preflightProblem(notInstalled) ?? "", /not found\. Install it.*graft auth login/);
});

test("claude-code: an API key in Claude Code's environment is called out, since it outranks the subscription", () => {
  const s = { installed: true, loggedIn: true, authMethod: "claude.ai", apiKeySource: "ANTHROPIC_API_KEY" };
  assert.match(describeSignIn(s), /API key from ANTHROPIC_API_KEY/);
});

function authDeps(status = { installed: true, loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }) {
  const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    calls,
    out,
    err,
    deps: {
      interactive: async (bin: string, args: string[], env: NodeJS.ProcessEnv) => (calls.push({ bin, args, env }), 0),
      status: async () => status,
      env: { CLAUDECODE: "1" } as NodeJS.ProcessEnv,
      out: (l: string) => void out.push(l),
      err: (l: string) => void err.push(l),
    },
  };
}

test("graft auth login hands the terminal to `claude auth login`, then confirms the sign-in", async () => {
  const a = authDeps();
  assert.equal(await runAuth("login", a.deps), 0);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].bin, "claude");
  assert.deepEqual(a.calls[0].args, ["auth", "login"]);
  assert.equal(a.calls[0].env.CLAUDECODE, undefined);
  assert.match(a.out.join("\n"), /signed in with a Claude Pro subscription/);
});

test("graft auth token runs `claude setup-token` and tells the user to export the token themselves", async () => {
  const a = authDeps();
  assert.equal(await runAuth("token", a.deps), 0);
  assert.deepEqual(a.calls[0].args, ["setup-token"]);
  const said = a.err.join("\n");
  assert.match(said, /does not read, store or print it/);
  assert.match(said, /export CLAUDE_CODE_OAUTH_TOKEN=<the token above>/);
  assert.deepEqual(a.out, [], "graft itself prints nothing to stdout");
});

test("graft auth status summarizes the sign-in and exits 1 when signed out", async () => {
  const a = authDeps();
  assert.equal(await runAuth("status", a.deps), 0);
  assert.equal(a.calls.length, 0, "status never hands off the terminal");
  assert.match(a.out.join("\n"), /Claude Code: signed in with a Claude Pro subscription/);
  assert.match(a.out.join("\n"), /auth method {3}claude\.ai/);

  const b = authDeps({ installed: true, loggedIn: false, authMethod: "none", subscriptionType: undefined as unknown as string });
  assert.equal(await runAuth("status", b.deps), 1);
  assert.match(b.err.join("\n"), /graft auth login/);
});

test("graft auth reports a missing claude binary instead of throwing", async () => {
  const a = authDeps();
  a.deps.interactive = async () => {
    throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  };
  assert.equal(await runAuth("login", a.deps), 1);
  assert.match(a.err.join("\n"), /was not found\. Install it/);
});
