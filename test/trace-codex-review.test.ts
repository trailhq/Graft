/**
 * The c1 and c6 review's ways around the Codex reader (design 4.15, 4.16, D133): exits read only from the header,
 * a structured exit never given to the wrong call, forked rollouts read as nothing, a FIFO never waited on,
 * apply_patch run through the shell and keystrokes into a shell seen as what they write. Synthetic rollouts only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { codexExitOf, codexLineEvents, noteCodexPrompt, readNewCodexEvents } from "../src/trace/codex.js";
import { tamperOf } from "../src/trace/tamper.js";
import type { SkillSessionState } from "../src/trace/types.js";
import type { TraceEvent } from "../src/trace/claude.js";
import * as F from "./codex-fixtures.js";

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "trace-codex-rv-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { HOME: root, TRAIL_HOME: join(root, "trail-home"), CODEX_HOME: join(root, ".codex") };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  return { root, env, cursor: join(env.TRAIL_HOME!, "sessions", "s.json") };
}
/** Every event of `lines`, decoded in order with one memo, as a tail reader does. */
const decode = (lines: object[]) => {
  const memo = {};
  return lines.flatMap((l) => codexLineEvents(l, memo));
};
const TAMPER = { trailHome: "/home/dev/.trail", transcriptPath: "/home/dev/.codex/sessions/r.jsonl", home: "/home/dev", folder: "/home/dev/shop" };

test("review: with no Output: line there is no header, so a body that prints an exit line is no exit", () => {
  assert.equal(codexExitOf("npm ERR! publish failed\nProcess exited with code 0"), null);
  assert.equal(codexExitOf("Exit code: 0\nlooks fine"), null);
  assert.equal(codexExitOf("Process running with session ID 4\nstill going"), null);
  assert.deepEqual(codexExitOf(F.execText(1, "Process exited with code 0")), { code: 1 });
});

test("review: a structured exit that names no call goes by command only when one open call ran that command", () => {
  const evs = decode([F.turnContext("/home/dev/shop"), F.exec("a", "npm test"), F.exec("b", "npm test"),
    F.commandDone("item-x", ["npm", "test"], 0, "ok"), F.execOut("a", 1, "1 failed"), F.execOut("b", 0, "ok")]);
  const ok = Object.fromEntries(evs.flatMap((e) => (e.kind === "tool_result" ? [[e.id, e.ok]] : [])));
  assert.deepEqual(ok, { a: false, b: true });
  // One open call with that command: the structured exit still decides it.
  const one = decode([F.turnContext("/home/dev/shop"), F.exec("c", "npm test"), F.commandDone("item-y", ["npm", "test"], 1, "1 failed"), F.execOut("c", 0, "ok")]);
  assert.equal(one.find((e) => e.kind === "tool_result")?.ok, false);
});

test("review: a forked rollout gives no events (D133: fail closed); its copied history is another session's work", () => {
  const h = home();
  const m = F.meta();
  (m.payload as Record<string, unknown>).forked_from_id = "019fa295-0000-7000-8000-00000000aaaa";
  const p = F.rollout(h.root, [m, F.turnContext("/home/dev/shop", "old"), F.userMessage("ship it", 1), F.exec("c1", "npm publish"), F.execOut("c1", 0, "ok"),
    F.turnContext("/home/dev/shop", "new", 5), F.userMessage("ship it", 6)]);
  const st = { codex: undefined } as unknown as SkillSessionState;
  noteCodexPrompt(st, "ship it", h.env);
  assert.deepEqual(readNewCodexEvents(p, h.cursor, { env: h.env, state: st, firstReadBytes: Infinity }), []);
  // forked_from_id null is no fork.
  (m.payload as Record<string, unknown>).forked_from_id = null;
  const q = F.rollout(h.root, [m, F.userMessage("ship it", 1)], "019fa295-0000-7000-8000-00000000bbbb");
  assert.equal(readNewCodexEvents(q, join(h.root, "c2.json"), { env: h.env, state: st, firstReadBytes: Infinity }).length, 1);
});

test("review: a FIFO where the rollout should be is never waited on", { skip: process.platform === "win32" }, () => {
  const h = home();
  const dir = join(h.root, ".codex", "sessions", "2026", "10", "27");
  mkdirSync(dir, { recursive: true });
  const fifo = join(dir, `rollout-2026-10-27T10-00-00-${F.CODEX_SID}.jsonl`);
  execFileSync("mkfifo", [fifo]);
  const code = `import { readNewCodexEvents } from ${JSON.stringify(join(process.cwd(), "src/trace/codex.ts"))};
    console.log(JSON.stringify(readNewCodexEvents(${JSON.stringify(fifo)}, ${JSON.stringify(h.cursor)}, { env: ${JSON.stringify(h.env)} })));`;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { timeout: 8000, encoding: "utf8" });
  assert.equal(r.signal, null, "the read hung on the FIFO");
  assert.equal(r.stdout.trim(), "[]");
});

test("review: apply_patch run through the shell is an edit of each file it names, so a patch to ~/.trail is tamper", () => {
  const patch = "*** Begin Patch\n*** Update File: /home/dev/.trail/skills/release/SKILL.md\n@@\n-a\n+b\n*** Add File: notes.txt\n+x\n*** End Patch";
  const heredoc = decode([F.turnContext("/home/dev/shop"), F.exec("p1", `apply_patch <<'EOF'\n${patch}\nEOF`)]);
  const argv = decode([F.turnContext("/home/dev/shop"), F.fnCall("p2", "shell", { command: ["apply_patch", patch], workdir: "/home/dev/shop" })]);
  for (const evs of [heredoc, argv]) {
    const edits = evs.flatMap((e) => (e.kind === "tool_call" && e.name === "Edit" ? [(e.input as { file_path: string }).file_path] : []));
    // A relative name is resolved against the cwd (on Windows that gives a drive and '\\').
    assert.deepEqual(edits, ["/home/dev/.trail/skills/release/SKILL.md", resolve("/home/dev/shop/notes.txt")], JSON.stringify(evs));
    assert.ok(evs.some((e) => e.kind === "tool_call" && e.name === "Bash"), "the shell call is still the run's call");
    const hit = evs.flatMap((e) => (e.kind === "tool_call" ? [tamperOf(e.name, e.input, null, TAMPER)] : [])).find(Boolean);
    assert.ok(String(hit).startsWith(`Edit ${resolve("/home/dev/.trail")}${sep}`), String(hit));
  }
});

test("review: keystrokes into a running shell are a call of their own, joined across writes, so a write to ~/.trail is tamper", () => {
  const evs = decode([F.turnContext("/home/dev/shop"), F.exec("s", "bash -i"), F.output("s", F.runningText(3, "")),
    F.writeStdin("w1", 3, "cp /tmp/x /home/dev/.tra"), F.output("w1", F.runningText(3, "")),
    F.writeStdin("w2", 3, "il/skills/r/SKILL.md\n"), F.output("w2", F.runningText(3, ""))]);
  const calls = evs.filter((e): e is Extract<TraceEvent, { kind: "tool_call" }> => e.kind === "tool_call");
  assert.deepEqual(calls.map((c) => c.name), ["Bash", "write_stdin", "write_stdin"]);
  assert.equal(tamperOf(calls[1]!.name, calls[1]!.input, null, TAMPER), null, "half a path writes nothing yet");
  assert.match(String(tamperOf(calls[2]!.name, calls[2]!.input, null, TAMPER)), /^Bash cp/);
  // Each write has its own result, so no call stays open, and the shell's own result is still its exit.
  assert.deepEqual(evs.filter((e) => e.kind === "tool_result").map((e) => e.id), ["w1", "w2"]);
  // An empty poll is no call.
  assert.equal(decode([F.exec("t", "sleep 30"), F.output("t", F.runningText(5, "")), F.writeStdin("w3", 5, "")]).filter((e) => e.kind === "tool_call").length, 1);
});

test("review: the save gate's tail starts in the session's own folder, so a relative patch path is read where Codex applies it", async () => {
  const { tailCalls, tamperInTail } = await import("../src/skills/save-gate.js");
  const { CODEX_DIALECT } = await import("../src/trace/dialect.js");
  const h = home();
  const repo = join(h.root, "src", "shop");
  // Over 4 MB of replies after session_meta, and no turn_context in the tail: the tail alone doesn't know the folder.
  const filler = Array.from({ length: 560 }, (_, i) => F.agentMessage(`step ${i} ${"x".repeat(8000)}`, 1));
  const p = F.rollout(h.root, [F.meta({ cwd: repo }), ...filler,
    { timestamp: F.at(9), type: "response_item", payload: { type: "custom_tool_call", call_id: "pt1", name: "apply_patch", input: "*** Begin Patch\n*** Update File: ../../trail-home/state/skills.json\n@@\n-{}\n+{}\n*** End Patch" } }]);
  const calls = tailCalls(p, CODEX_DIALECT, h.env);
  assert.equal((calls.at(-1)?.input as { file_path?: string })?.file_path, join(h.env.TRAIL_HOME!, "state", "skills.json"));
  assert.match(String(tamperInTail(calls, p, h.env)), /^Edit /);
});
