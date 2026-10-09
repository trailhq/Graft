/** The per-prompt hint brings in learnings earlier sessions left, each once a session. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { notesForPrompt, type AskJson } from "../src/claude/format.js";
import type { SessionState } from "../src/claude/state.js";

const hit = (title: string, path: string) => ({
  note: { path, title, author: "Anirudh", date: "2026-10-08", touches: ["pkg/cmd/repo/clone/clone.go"], body: "## Decided\nPrint ✓ Cloned OWNER/REPO to DIR, only on a TTY.\n", cost: { minutes: 4, tokens: 30_000 } },
  score: 1,
  shared: [],
});

test("a matching learning reaches the agent with the prompt, once a session, with what it saves", () => {
  const ask = { query: "fork clone message", mode: "lexical", hits: [], notes: [hit("gh repo clone success message", "/n/a.md")] } as AskJson;
  const s = {} as SessionState;
  const first = notesForPrompt(ask, s);
  assert.match(first!, /learnings earlier sessions left on this/);
  assert.match(first!, /close your reply with one short line that credits it/);
  assert.match(first!, /📝 Started from Anirudh's learning · saved ~27k tokens/);
  assert.match(first!, /from Anirudh's learning · Oct 8 · gh repo clone success message/);
  assert.match(first!, /\[(graft|trail)\] learnings saved ≈ 29,\d{3} tokens/, "what it took less reading it, for the savings total");
  assert.match(first!, /Print ✓ Cloned OWNER\/REPO to DIR/);
  assert.equal(notesForPrompt(ask, s), null, "not again in the same session");
  assert.equal(notesForPrompt({ query: "x", mode: "lexical", hits: [] } as AskJson, {} as SessionState), null, "no notes, nothing");
});

test("a teammate's pushed branch on the same code is put in front of the agent once, to start its reply with", async () => {
  const { overlapsForPrompt } = await import("../src/claude/format.js");
  const line = "● overlap · Kumar's branch kumar/retry also changes client.go (pushed today 15:32)";
  const ask = { query: "retry count", mode: "lexical", hits: [], overlaps: [line, "[trail] Start your reply with the overlap line above, word for word, so the user knows."] } as AskJson;
  const s = {} as SessionState;
  const first = overlapsForPrompt(ask, s);
  assert.match(first!, /Start your reply with this line, word for word/);
  assert.ok(first!.endsWith(line), "the overlap itself, and not ask's own instruction a second time");
  assert.equal(overlapsForPrompt(ask, s), null, "not again in the same session");
  assert.equal(overlapsForPrompt({ query: "x", mode: "lexical", hits: [] } as AskJson, {} as SessionState), null);
});
