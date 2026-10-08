/** The per-prompt hint brings in notes earlier sessions left, each once a session. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { notesForPrompt, type AskJson } from "../src/claude/format.js";
import type { SessionState } from "../src/claude/state.js";

const hit = (title: string, path: string) => ({
  note: { path, title, author: "Anirudh", date: "2026-10-08", touches: ["pkg/cmd/repo/clone/clone.go"], body: "## Decided\nPrint ✓ Cloned OWNER/REPO to DIR, only on a TTY.\n" },
  score: 1,
  shared: [],
});

test("a matching note reaches the agent with the prompt, once a session", () => {
  const ask = { query: "fork clone message", mode: "lexical", hits: [], notes: [hit("gh repo clone success message", "/n/a.md")] } as AskJson;
  const s = {} as SessionState;
  const first = notesForPrompt(ask, s);
  assert.match(first!, /notes earlier sessions left on this/);
  assert.match(first!, /end your reply with one line that says so/);
  assert.match(first!, /from Anirudh's note · Oct 8 · gh repo clone success message/);
  assert.match(first!, /Print ✓ Cloned OWNER\/REPO to DIR/);
  assert.equal(notesForPrompt(ask, s), null, "not again in the same session");
  assert.equal(notesForPrompt({ query: "x", mode: "lexical", hits: [] } as AskJson, {} as SessionState), null, "no notes, nothing");
});
