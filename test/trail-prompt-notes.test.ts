/** The per-prompt hint brings in learnings earlier sessions left, each once a session. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { notesForPrompt, type AskJson } from "../src/claude/format.js";
import type { SessionState } from "../src/claude/state.js";

const hit = (title: string, path: string, tokens = 90_000) => ({
  note: { path, title, author: "Maya", date: "2026-10-08", touches: ["pkg/cmd/repo/clone/clone.go"], body: "## Decided\nPrint ✓ Cloned OWNER/REPO to DIR, only on a TTY.\n", cost: { minutes: 4, tokens } },
  score: 1,
  shared: [],
});

test("a matching learning reaches the agent with the prompt, once a session, with what it saves", () => {
  const ask = { query: "fork clone message", mode: "lexical", hits: [], notes: [hit("gh repo clone success message", "/n/a.md")] } as AskJson;
  const s = {} as SessionState;
  const first = notesForPrompt(ask, s);
  assert.match(first!, /learnings earlier sessions left on this/);
  assert.match(first!, /close your reply with one short line that credits it/);
  assert.match(first!, /📝 Started from Maya's learning · saved ~90k tokens and ~4 min/);
  assert.match(first!, /from Maya's learning · Oct 8 · gh repo clone success message/);
  assert.match(first!, /\[(graft|trail)\] learnings saved ≈ 89,\d{3} tokens/, "what it took less reading it, for the savings total");
  assert.match(first!, /Print ✓ Cloned OWNER\/REPO to DIR/);
  assert.equal(notesForPrompt(ask, s), null, "not again in the same session");
  assert.equal(notesForPrompt({ query: "x", mode: "lexical", hits: [] } as AskJson, {} as SessionState), null, "no notes, nothing");
});

test("a learning that took under 80k tokens is credited by whose it was, with no saving claimed", () => {
  const ask = { query: "fork clone message", mode: "lexical", hits: [], notes: [hit("gh repo clone success message", "/n/a.md", 30_000)] } as AskJson;
  const first = notesForPrompt(ask, {} as SessionState);
  assert.match(first!, /naming whose it was \(e\.g\. "📝 Started from Maya's learning"\)\. Claim no saving for it/);
  assert.doesNotMatch(first!, /faster|tokens and|saved ≈/, "no value it hasn't earned");
});

test("a preference kept from init seconds ago carries no value claim and its first-said date", () => {
  // As `trail init` keeps it: no measured cost, dated the day it was first said.
  const kept = { note: { path: "/home/.trail/repos/x/notes/2026-10-07-run-the-generator.md", title: "don't hand-edit the generated file, run the generator", author: "", date: "2026-10-07", touches: [], body: "don't hand-edit the generated file, run the generator", standing: true }, score: 1, shared: [] };
  const first = notesForPrompt({ query: "generated file", mode: "lexical", hits: [], notes: [kept] } as unknown as AskJson, {} as SessionState);
  assert.match(first!, /from a learning · Oct 7 · don't hand-edit the generated file/);
  assert.doesNotMatch(first!, /faster|saved|gets you to a PR/);
  assert.doesNotMatch(first!, /—/, "no em dash in trail's own lines");
});
