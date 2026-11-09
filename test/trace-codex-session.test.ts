/**
 * The skills session reads each host through its dialect (design 4.16, 0.2):
 * a Codex session folds its rollout, and its typed lines count only after the
 * prompt hook recorded them (P30), whichever comes first, the line or the
 * hook. A host with no dialect keeps 1a's reader. Synthetic rollouts only.
 */
process.env.TZ = "UTC";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsGate, withSkillSession, currentRun, type GateCtx } from "../src/trace/skill-session.js";
import { sessionPath } from "../src/trace/gate-file.js";
import { noteCodexPrompt } from "../src/trace/codex.js";
import * as F from "./codex-fixtures.js";

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function box() {
  const root = mkdtempSync(join(tmpdir(), "trace-codex-sess-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TRAIL_HOME: join(root, "trail-home"), CODEX_HOME: join(root, ".codex"), TRAIL_TEST_NOW: "2026-10-27T10:05:00Z" };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "on" }));
  const tx = F.rollout(root, [F.meta(), F.turnContext("/home/dev/shop")]);
  return { root, env, tx };
}
const codexPayload = (tx: string) => ({ session_id: F.CODEX_SID, transcript_path: tx, cwd: "/home/dev/shop", hook_event_name: "UserPromptSubmit", turn_id: "turn-1", model: "gpt-5-codex", permission_mode: "default" });
function ctxOf(b: ReturnType<typeof box>): GateCtx {
  const g = skillsGate(codexPayload(b.tx), "/home/dev/shop", b.env);
  if (!g.ok) throw new Error(g.why);
  return g.ctx;
}
const job = [
  F.exec("call_1", "npm run test:integration"), F.execOut("call_1", 0, "Test Files  3 passed (3)\n     Tests  42 passed (42)"),
  ...F.reply("All 42 integration tests pass.", 30),
];

test("a Codex session folds its rollout through the Codex dialect: tier B, fold on, learning off", () => {
  const b = box();
  const ctx = ctxOf(b);
  assert.deepEqual([ctx.host, ctx.tier, ctx.fold, ctx.learn, ctx.learnOff], ["codex", "B", true, false, "host"]);
  F.appendLines(b.tx, [F.userMessage("run the integration tests", 1), F.userItem("run the integration tests", 1), ...job]);
  const prompt = "run the integration tests";
  const out = withSkillSession(ctx, { catchUp: true, prepare: (st) => noteCodexPrompt(st, prompt, b.env) }, (st, fold) => {
    assert.deepEqual(fold!.events.map((e) => e.kind), ["typed", "injected", "tool_call", "tool_result", "assistant"]);
    const run = currentRun(st)!;
    return [run.job, run.typedCount, run.commands, run.stepCalls];
  });
  assert.deepEqual(out, ["tests", 1, 1, 1]);
  const disk = readFileSync(sessionPath(F.CODEX_SID, ".json", b.env), "utf8");
  assert.ok(!disk.includes("integration tests\""), "no typed text on disk");
  assert.equal(JSON.parse(disk).skills.codex.typedShas.length, 1);
});

for (const order of ["line-first", "hook-first"] as const) {
  test(`a typed line counts whichever comes first, the line or the prompt hook (${order})`, () => {
    const b = box();
    const prompt = "run the integration tests";
    const line = () => F.appendLines(b.tx, [F.userMessage(prompt, 1), F.userItem(prompt, 1)]);
    if (order === "line-first") line();
    withSkillSession(ctxOf(b), { catchUp: true, prepare: (st) => noteCodexPrompt(st, prompt, b.env) }, () => null);
    if (order === "hook-first") line();
    F.appendLines(b.tx, job);
    const run = withSkillSession(ctxOf(b), { catchUp: true }, (st) => currentRun(st));
    assert.deepEqual([run?.job, run?.typedCount], ["tests", 1]);
  });
}

test("a line the prompt hook never saw starts nothing as typed: AGENTS.md or a continuation is not the person", () => {
  const b = box();
  F.appendLines(b.tx, [F.userItem("# AGENTS.md instructions\nrun the integration tests first"), F.userMessage("run the integration tests", 1), ...job]);
  const run = withSkillSession(ctxOf(b), { catchUp: true }, (st) => currentRun(st));
  assert.deepEqual([run?.job ?? null, run?.typedCount ?? 0], [null, 0]);
});

test("a host with no dialect keeps 1a's reader (J24: folded, then held by its tier); only Codex reads as Codex", () => {
  const b = box();
  const tx = join(b.root, ".gemini", "tmp", "x.jsonl");
  mkdirSync(join(tx, ".."), { recursive: true });
  writeFileSync(tx, F.jsonl([F.meta(), F.userMessage("run the integration tests", 1), ...job]));
  const g = skillsGate({ session_id: "g-1", transcript_path: tx, cwd: "/home/dev/shop", hook_event_name: "AfterTool" }, "/home/dev/shop", b.env);
  assert.ok(g.ok);
  assert.deepEqual([g.ctx.host, g.ctx.learn], ["gemini", false]);
  const r = withSkillSession(g.ctx, { catchUp: true }, (_st, fold) => fold!.events.length);
  assert.equal(r, 0, "Codex lines in another host's file are not read as Codex");
});
