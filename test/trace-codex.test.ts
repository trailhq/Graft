/**
 * Codex rollouts into Trail's trace events (design 4.15, P30, P34, P39, P40):
 * synthetic rollouts only, built from codex-cli 0.150's line shapes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexExitOf, codexHome, codexLineEvents, codexMeta, codexTypedSha, isImportedRollout, noteCodexPrompt, readNewCodexEvents, type CodexMeta,
} from "../src/trace/codex.js";
import type { SkillSessionState } from "../src/trace/types.js";
import type { TraceEvent } from "../src/trace/claude.js";
import * as F from "./codex-fixtures.js";

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "trace-codex-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { HOME: root, TRAIL_HOME: join(root, "trail-home"), CODEX_HOME: join(root, ".codex") };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  return { root, env, cursor: join(env.TRAIL_HOME!, "sessions", "s.json") };
}
/** A session state whose prompt hook saw `prompts` (P30). */
function seen(env: NodeJS.ProcessEnv, prompts: string[]): SkillSessionState {
  const st = { codex: undefined } as unknown as SkillSessionState;
  for (const p of prompts) noteCodexPrompt(st, p, env);
  return st;
}
const kinds = (evs: TraceEvent[]) => evs.map((e) => e.kind);
const read = (h: ReturnType<typeof home>, path: string, st: SkillSessionState | null = null) =>
  readNewCodexEvents(path, h.cursor, { env: h.env, state: st, firstReadBytes: Infinity });

test("codexMeta: line 1's facts; a file whose first line isn't session_meta, or is over 64 KB, gives null", () => {
  const h = home();
  const p = F.rollout(h.root, [F.meta({ originator: "codex_exec", source: "exec", history: "paginated", cwd: "/home/dev/acme-cli" }), F.userMessage("hi")]);
  assert.deepEqual(codexMeta(p), { id: F.CODEX_SID, originator: "codex_exec", source: "exec", cliVersion: "0.150.0-alpha.8", cwd: "/home/dev/acme-cli", historyMode: "paginated" } satisfies CodexMeta);
  // A subagent's source is an object: its kind is the source.
  const q = F.rollout(h.root, [F.meta({ source: { subagent: { thread_spawn: {} } }, history: "future" })], "019fa295-0000-7000-8000-000000000002");
  assert.deepEqual([codexMeta(q)?.source, codexMeta(q)?.historyMode], ["subagent", null]);
  assert.equal(codexMeta(F.rollout(h.root, [F.userMessage("hi")], "019fa295-0000-7000-8000-000000000003")), null);
  const big = F.meta();
  (big.payload.base_instructions as { text: string }).text = "x".repeat(70 * 1024);
  assert.equal(codexMeta(F.rollout(h.root, [big], "019fa295-0000-7000-8000-000000000004")), null);
  assert.equal(codexMeta(join(h.root, "gone.jsonl")), null);
});

test("codexHome: CODEX_HOME, else $HOME/.codex", () => {
  assert.equal(codexHome({ HOME: "/home/dev", CODEX_HOME: "/tmp/x/codex" }), resolve("/tmp/x/codex"));
  assert.equal(codexHome({ HOME: "/home/dev" }), join("/home/dev", ".codex"));
});

test("codexExitOf: each header form; a header-looking line in the output body is not the exit", () => {
  assert.deepEqual(codexExitOf(F.execText(0, "ok")), { code: 0 });
  assert.deepEqual(codexExitOf(F.execText(1, "npm error 403")), { code: 1 });
  assert.deepEqual(codexExitOf("Exit code: 2\nWall time: 0.1 seconds\nOutput:\nboom"), { code: 2 });
  assert.deepEqual(codexExitOf(JSON.stringify({ output: "boom", metadata: { exit_code: 3, duration_seconds: 0.2 } })), { code: 3 });
  assert.deepEqual(codexExitOf(F.runningText(7, "building…")), { running: 7 });
  assert.equal(codexExitOf("Success. Updated the following files:\nM src/cart.ts"), null);
  assert.equal(codexExitOf(`Chunk ID: 1\nOutput:\nProcess exited with code 0`), null);
  assert.deepEqual(codexExitOf(F.execText(0, "Process exited with code 9\nExit code: 9")), { code: 0 });
});

test("typed lines (P30): legacy and paginated count only when the prompt hook saw them; AGENTS.md, developer and unseen lines are injected", () => {
  const h = home();
  const p = F.rollout(h.root, [
    F.meta(),
    F.userItem("# AGENTS.md instructions for /home/dev/shop\nUse pnpm."),
    F.userItem("<environment_context>cwd /home/dev/shop</environment_context>"),
    F.userItem("[trail] a hook's context", 1, "developer"),
    F.userMessage("publish 1.4.3", 2), F.userItem("publish 1.4.3", 2),
    F.userCompleted("now tag it", 3),
    F.userMessage("a line the hook never saw", 4),
  ]);
  const st = seen(h.env, ["publish 1.4.3", "now tag it"]);
  const evs = read(h, p, st);
  assert.deepEqual(evs.filter((e) => e.kind === "typed").map((e) => (e as { text: string }).text), ["publish 1.4.3", "now tag it"]);
  const injected = evs.filter((e) => e.kind === "injected").map((e) => (e as { text: string }).text);
  assert.ok(injected.some((t) => t.startsWith("# AGENTS.md")));
  assert.ok(injected.some((t) => t.startsWith("[trail] a hook's")));
  assert.ok(injected.includes("a line the hook never saw"));
  // No state, or no key: nothing is typed.
  const h2 = home();
  const p2 = F.rollout(h2.root, [F.meta(), F.userMessage("publish 1.4.3")]);
  assert.deepEqual(kinds(read(h2, p2)), ["injected"]);
  assert.equal(codexTypedSha("publish 1.4.3", h2.env), null, "no key yet: no hash");
});

test("noteCodexPrompt: keyed 16-hex hashes (R7), the last 20, the key 0600 in Trail's state folder (D138); never the text", () => {
  const h = home();
  const st = seen(h.env, Array.from({ length: 25 }, (_, i) => `prompt ${i}`));
  assert.equal(st.codex!.typedShas.length, 20);
  assert.ok(st.codex!.typedShas.every((s) => /^[0-9a-f]{16}$/.test(s)));
  assert.equal(st.codex!.typedShas.at(-1), codexTypedSha("prompt 24", h.env));
  assert.equal(codexTypedSha("  prompt 24\n", h.env), codexTypedSha("prompt 24", h.env), "trimmed");
  assert.equal(JSON.stringify(st).includes("prompt"), false);
  if (process.platform !== "win32") assert.equal(statSync(join(h.env.TRAIL_HOME!, "state", "typed-key")).mode & 0o777, 0o600);
  const other = home();
  noteCodexPrompt(seen(other.env, []), "prompt 24", other.env);
  assert.notEqual(codexTypedSha("prompt 24", other.env), codexTypedSha("prompt 24", h.env), "keyed per home");
});

test("calls: exec_command is Bash with its workdir; the older shell forms unwrap bash -lc; apply_patch is an edit per file", () => {
  const h = home();
  const p = F.rollout(h.root, [
    F.meta(), F.turnContext("/home/dev/shop"),
    F.exec("c1", "npm run build"),
    F.exec("c2", "npm test", "/home/dev/shop/packages/cli"),
    F.exec("c3", "ls", "docs"),
    F.fnCall("c4", "shell", { command: ["bash", "-lc", "npm view acme-cli version"], workdir: "/home/dev/shop" }),
    F.fnCall("c5", "shell", { command: ["git", "tag", "v1.4.3", "-m", "release 1.4.3"] }),
    F.fnCall("c6", "shell_command", { command: "git push --tags" }),
    { timestamp: F.at(1), type: "response_item", payload: { type: "local_shell_call", call_id: "c7", status: "completed", action: { type: "exec", command: ["sh", "-c", "make dist"], working_directory: "/home/dev/shop" } } },
    F.applyPatch("c8", ["src/cart.ts", "/home/dev/.trail/state/skills.json"]),
    F.fnCall("c9", "update_plan", { plan: [] }),
  ]);
  const calls = read(h, p).filter((e) => e.kind === "tool_call") as Array<Extract<TraceEvent, { kind: "tool_call" }>>;
  const cmd = (c: (typeof calls)[number]) => (c.input as { command?: string }).command;
  assert.deepEqual(calls.filter((c) => c.name === "Bash").map((c) => [c.id, cmd(c), c.cwd]), [
    ["c1", "npm run build", "/home/dev/shop"],
    ["c2", "npm test", "/home/dev/shop/packages/cli"],
    ["c3", "ls", resolve("/home/dev/shop/docs")],
    ["c4", "npm view acme-cli version", "/home/dev/shop"],
    ["c5", "git tag v1.4.3 -m 'release 1.4.3'", "/home/dev/shop"],
    ["c6", "git push --tags", "/home/dev/shop"],
    ["c7", "make dist", "/home/dev/shop"],
  ]);
  assert.ok(calls.every((c) => c.name !== "Bash" || c.branch === "main"));
  assert.deepEqual(calls.filter((c) => c.name === "Edit").map((c) => [c.id, (c.input as { file_path: string }).file_path]), [
    ["c8", resolve("/home/dev/shop/src/cart.ts")], ["c8#2", "/home/dev/.trail/state/skills.json"],
  ]);
  assert.ok(calls.some((c) => c.id === "c9" && c.name === "update_plan"));
});

test("exits: the header decides; a failure reads as Claude's does; an array output; JSON metadata", () => {
  const h = home();
  const p = F.rollout(h.root, [
    F.meta(),
    F.exec("c1", "npm run build"), F.execOut("c1", 0, "built in 2.1s"),
    F.exec("c2", "npm publish"), F.execOut("c2", 1, "npm error code E403"),
    F.exec("c3", "npm test"), F.output("c3", "Exit code: 2\nWall time: 1.2 seconds\nOutput:\n2 failed"),
    F.fnCall("c4", "shell", { command: ["bash", "-lc", "make"] }), F.output("c4", JSON.stringify({ output: "made", metadata: { exit_code: 0 } })),
    F.exec("c5", "npm view acme-cli version"), F.output("c5", [{ type: "input_text", text: F.execText(0, "1.4.3") }]),
    F.exec("c6", "grep -r TODO src"), F.execOut("c6", 1, ""),
    F.exec("c7", "echo hi"), F.output("c7", "no header at all"),
  ]);
  const res = new Map((read(h, p).filter((e) => e.kind === "tool_result") as Array<Extract<TraceEvent, { kind: "tool_result" }>>).map((r) => [r.id, r]));
  assert.deepEqual([...res.keys()], ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  assert.deepEqual([res.get("c1")!.ok, res.get("c1")!.isError, res.get("c1")!.text], [true, false, "built in 2.1s"]);
  assert.deepEqual([res.get("c2")!.ok, res.get("c2")!.isError, res.get("c2")!.text], [false, true, "Exit code 1\nnpm error code E403"]);
  assert.deepEqual([res.get("c3")!.ok, res.get("c3")!.text], [false, "Exit code 2\n2 failed"]);
  assert.deepEqual([res.get("c4")!.ok, res.get("c4")!.text], [true, "made"]);
  assert.deepEqual([res.get("c5")!.ok, res.get("c5")!.text], [true, "1.4.3"]);
  assert.deepEqual([res.get("c6")!.ok, res.get("c6")!.isError], [false, true]);
  assert.deepEqual([res.get("c7")!.ok, res.get("c7")!.isError], [false, false], "no exit known: not passed, errs safe");
});

test("a command still running is held open until write_stdin's output with an exit header closes it; one never closed stays open", () => {
  const h = home();
  const p = F.rollout(h.root, [
    F.meta(),
    F.exec("c1", "npm run build"), F.output("c1", F.runningText(7, "building…")),
    F.writeStdin("w1", 7), F.output("w1", F.runningText(7, "still building…")),
    F.writeStdin("w2", 7), F.output("w2", F.execText(0, "built in 31s")),
    F.exec("c2", "npm run watch"), F.output("c2", F.runningText(8, "watching")),
  ]);
  const evs = read(h, p);
  const results = evs.filter((e) => e.kind === "tool_result") as Array<Extract<TraceEvent, { kind: "tool_result" }>>;
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [["c1", true]]);
  assert.match(results[0]!.text, /building…[\s\S]*built in 31s/);
  assert.equal(evs.filter((e) => e.kind === "tool_call").length, 2, "write_stdin is no call of its own");
});

test("a structured CommandExecution exit beats the parsed one, by id or by command text on the same turn", () => {
  const h = home();
  const p = F.rollout(h.root, [
    F.meta(),
    F.exec("c1", "npm test"), F.commandDone("c1", ["/bin/zsh", "-lc", "npm test"], 1, "1 failed"), F.execOut("c1", 0, "done"),
    F.exec("c2", "npm run lint"), F.commandDone("exec-9", ["/bin/zsh", "-lc", "npm run lint"], 0, "clean"), F.execOut("c2", 1, "?"),
    F.exec("c3", "npm run build"), F.output("c3", F.runningText(4, "…")), F.commandDone("c3", ["/bin/zsh", "-lc", "npm run build"], 0, "built"),
  ]);
  const res = (read(h, p).filter((e) => e.kind === "tool_result") as Array<Extract<TraceEvent, { kind: "tool_result" }>>).map((r) => [r.id, r.ok]);
  assert.deepEqual(res, [["c1", false], ["c2", true], ["c3", true]]);
});

test("compaction once per timestamp; the agent's words once per turn; task lines give nothing", () => {
  const h = home();
  const p = F.rollout(h.root, [
    F.meta(), F.taskStarted(), ...F.reply("Published 1.4.3.", 1), F.taskComplete(),
    F.compacted(5), F.contextCompacted(5), F.contextCompacted(9),
    F.taskStarted("turn-2", 10), ...F.reply("Published 1.4.3.", 11),
  ]);
  assert.deepEqual(kinds(read(h, p)), ["assistant", "compaction", "compaction", "assistant"]);
});

test("the cursor resumes mid-file, an open call carried across reads; a line over 2 MB is skipped", () => {
  const h = home();
  const p = F.rollout(h.root, [F.meta(), F.exec("c1", "npm run build")]);
  assert.deepEqual(kinds(read(h, p)), ["tool_call"]);
  F.appendLines(p, [{ timestamp: F.at(1), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "y".repeat(2 * 1024 * 1024 + 10) }] } }]);
  F.appendLines(p, [F.execOut("c1", 1, "Cannot find module 'x'")]);
  const second = read(h, p);
  assert.deepEqual(second.map((e) => [e.kind, (e as { id?: string }).id]), [["tool_result", "c1"]]);
  assert.deepEqual(read(h, p), [], "nothing new");
});

test("a .jsonl.zst rollout is skipped (P40); an imported rollout gives no events (P39); a missing file gives none", () => {
  const h = home();
  const z = F.rollout(h.root, [F.meta(), F.exec("c1", "ls")], F.CODEX_SID, ".jsonl.zst");
  assert.deepEqual(read(h, z), []);
  const imported = "019fa295-0000-7000-8000-0000000000aa";
  const p = F.rollout(h.root, [F.meta({ id: imported, originator: "Codex Desktop", source: "vscode" }), F.userMessage("hi"), ...F.reply("hello")], imported);
  assert.equal(isImportedRollout(p, h.env), false);
  writeFileSync(join(h.env.CODEX_HOME!, "external_agent_session_imports.json"), JSON.stringify({ records: [{ source_path: "/home/dev/.claude/projects/x/y.jsonl", content_sha256: "0".repeat(64), imported_thread_id: imported, imported_at: 1, source_modified_at: 1, connector_names: {} }] }));
  assert.equal(isImportedRollout(p, h.env), true);
  assert.deepEqual(read(h, p), []);
  assert.deepEqual(read(h, join(h.root, "gone.jsonl")), []);
});

test("codexLineEvents: one parsed line with a memo the caller keeps; never throws on junk", () => {
  const memo = {};
  assert.deepEqual(codexLineEvents(null, memo), []);
  assert.deepEqual(codexLineEvents([1, 2], memo), []);
  assert.deepEqual(codexLineEvents({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{not json" } }, memo), []);
  const evs = codexLineEvents(F.exec("c1", "npm test", "/home/dev/shop"), memo, 120);
  assert.deepEqual(evs.map((e) => [e.kind, e.offset]), [["tool_call", 120]]);
  // A typed candidate from one line alone: the dialect's typedByPerson judges it.
  assert.deepEqual(kinds(codexLineEvents(F.userMessage("yes"), {})), ["typed"]);
});
