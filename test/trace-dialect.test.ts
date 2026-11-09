/**
 * Host dialects (design 4.16): Claude's readers as they are, Codex's from
 * codex.ts; a Codex receipt must name this session's own rollout under
 * CODEX_HOME/sessions, read by the hooks (its cursor's inode). Synthetic only.
 */
process.env.TZ = "UTC";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_DIALECT, CODEX_DIALECT, dialectFor, typedOnLine } from "../src/trace/dialect.js";
import { noteCodexPrompt } from "../src/trace/codex.js";
import { receiptTranscriptOk, receiptTranscriptRead } from "../src/skills/receipts.js";
import { sessionPath } from "../src/trace/gate-file.js";
import type { Receipt } from "../src/skills/types.js";
import type { SkillSessionState } from "../src/trace/types.js";
import { typed, toolUse } from "./trace-fixtures.js";
import * as F from "./codex-fixtures.js";

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "trace-dialect-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { HOME: root, TRAIL_HOME: join(root, "trail-home"), CODEX_HOME: join(root, ".codex") };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  return { root, env };
}
const receipt = (over: Partial<Receipt> & { session: string; transcriptPath: string }): Receipt => ({
  v: 1, toolUseId: "call_0001", runId: "r-1027-0001", name: "release-npm", at: F.at(0), host: "codex", tier: "B",
  consent: "offer-yes", offerId: "o-0a0b0c", typed: null, typedYes: true, typedSave: false, asked: null,
  stepsTotal: 3, stepsVerified: 3, verdict: "held", usedAt: null, ...over,
});

test("dialectFor: claude and codex; none for the hosts Trail can't read", () => {
  assert.equal(dialectFor("claude"), CLAUDE_DIALECT);
  assert.equal(dialectFor("codex"), CODEX_DIALECT);
  for (const h of ["cursor", "copilot", "gemini", "unknown", ""]) assert.equal(dialectFor(h), null, h);
  assert.deepEqual([CLAUDE_DIALECT.hostName, CODEX_DIALECT.hostName], ["Claude Code", "Codex"]);
});

test("lineEvents: each dialect reads its own host's lines, and only those", () => {
  const claudeLine = toolUse("toolu_1", "Bash", { command: "npm test" });
  const codexLine = F.exec("call_1", "npm test", "/home/dev/shop");
  assert.deepEqual(CLAUDE_DIALECT.lineEvents(claudeLine, {}).map((e) => e.kind), ["tool_call"]);
  assert.deepEqual(CODEX_DIALECT.lineEvents(codexLine, {}).map((e) => e.kind), ["tool_call"]);
  assert.deepEqual(CLAUDE_DIALECT.lineEvents(codexLine, {}), []);
  assert.deepEqual(CODEX_DIALECT.lineEvents(claudeLine, {}), []);
});

test("typedByPerson and typedOnLine: Claude's line flags; Codex's prompt-hook hashes (P30)", () => {
  const h = home();
  const st = { codex: { meta: null, typedShas: [] } } as unknown as SkillSessionState;
  noteCodexPrompt(st, "yes", h.env);
  const ev = (text: string) => ({ kind: "typed" as const, text, at: F.at(0) });
  assert.equal(CODEX_DIALECT.typedByPerson(ev("yes"), st, h.env), true);
  assert.equal(CODEX_DIALECT.typedByPerson(ev("no"), st, h.env), false);
  assert.equal(CODEX_DIALECT.typedByPerson(ev("yes"), null, h.env), false);
  assert.equal(CLAUDE_DIALECT.typedByPerson(ev("yes"), null, h.env), true);
  assert.equal(typedOnLine(F.userMessage("yes"), { dialect: CODEX_DIALECT, st }, h.env), "yes");
  assert.equal(typedOnLine(F.userItem("yes"), { dialect: CODEX_DIALECT, st }, h.env), "", "the model's copy is not the typed line");
  assert.equal(typedOnLine(F.userMessage("no"), { dialect: CODEX_DIALECT, st }, h.env), "");
  assert.equal(typedOnLine(typed("yes"), { dialect: CLAUDE_DIALECT, st: null }, h.env), "yes");
});

test("a Codex receipt names this session's own rollout under CODEX_HOME/sessions, or it is refused", () => {
  const h = home();
  const tx = F.rollout(h.root, [F.meta(), F.userMessage("publish 1.4.3")]);
  const ok = (r: Partial<Receipt> & { transcriptPath: string }, env = h.env) => receiptTranscriptOk(receipt({ session: F.CODEX_SID, ...r }), env);
  assert.equal(ok({ transcriptPath: tx }), true);
  assert.equal(ok({ transcriptPath: tx, tier: "A", verdict: "live" }), true);
  // Another session's rollout: by its name, and by its first line.
  const other = "019fa295-0000-7000-8000-0000000000bb";
  const otherTx = F.rollout(h.root, [F.meta({ id: other })], other);
  assert.equal(ok({ transcriptPath: otherTx }), false, "another session's file");
  const renamed = join(otherTx, "..", `rollout-2026-10-27T11-00-00-${F.CODEX_SID}.jsonl`);
  copyFileSync(otherTx, renamed);
  assert.equal(ok({ transcriptPath: renamed }), false, "the name says this session, the first line another");
  // A link, a copy outside the sessions folder, a linked folder inside it, a relative path, no file.
  const away = mkdtempSync(join(tmpdir(), "trace-dialect-away-"));
  roots.push(away);
  const copy = join(away, `rollout-2026-10-27T10-00-00-${F.CODEX_SID}.jsonl`);
  copyFileSync(tx, copy);
  assert.equal(ok({ transcriptPath: copy }), false, "a copy in /tmp");
  const link = join(h.env.CODEX_HOME!, "sessions", "2026", "10", "28");
  mkdirSync(link, { recursive: true });
  symlinkSync(copy, join(link, `rollout-2026-10-28T10-00-00-${F.CODEX_SID}.jsonl`));
  assert.equal(ok({ transcriptPath: join(link, `rollout-2026-10-28T10-00-00-${F.CODEX_SID}.jsonl`) }), false, "a file link");
  symlinkSync(away, join(h.env.CODEX_HOME!, "sessions", "2026", "11"));
  assert.equal(ok({ transcriptPath: join(h.env.CODEX_HOME!, "sessions", "2026", "11", `rollout-2026-10-27T10-00-00-${F.CODEX_SID}.jsonl`) }), false, "a linked folder");
  assert.equal(ok({ transcriptPath: "sessions/x.jsonl" }), false);
  assert.equal(ok({ transcriptPath: join(h.root, "gone.jsonl") }), false);
  // CODEX_HOME from the env decides where the sessions folder is.
  assert.equal(ok({ transcriptPath: tx }, { ...h.env, CODEX_HOME: away }), false);
});

test("receiptTranscriptRead: a Codex receipt needs the hooks' cursor on the same inode, like Claude's (D82)", () => {
  const h = home();
  const tx = F.rollout(h.root, [F.meta()]);
  const r = receipt({ session: F.CODEX_SID, transcriptPath: tx });
  assert.equal(receiptTranscriptRead(r, h.env), false, "no cursor: the hooks never read it");
  const { ino, dev } = statSync(tx);
  const cursor = sessionPath(F.CODEX_SID, ".json", h.env);
  mkdirSync(join(cursor, ".."), { recursive: true });
  writeFileSync(cursor, JSON.stringify({ trace: { offset: 0, dev, ino, print: "", memo: {} } }));
  assert.equal(receiptTranscriptRead(r, h.env), true);
  const copy = join(tx, "..", "copy.jsonl");
  copyFileSync(tx, copy);
  assert.equal(receiptTranscriptRead({ ...r, transcriptPath: copy }, h.env), false, "a copy is another inode");
  // A host with no dialect is held anyway, unless it claims tier A.
  assert.equal(receiptTranscriptRead({ ...r, host: "cursor", tier: "D" }, h.env), true);
  assert.equal(receiptTranscriptRead({ ...r, host: "cursor", tier: "A" }, h.env), false);
});
