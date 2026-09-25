// graft.ts — pi / omp (oh-my-pi) extension for the Graft context graph.
//
// Graft's Claude Code support has four channels; pi/omp cover two natively:
//   1. orientation  -> AGENTS.md section (graft init "agents" host); both pi and
//                      omp load AGENTS.md, so nothing to do here
//   2. MCP tools    -> .mcp.json (graft init "claude" host); omp reads it
//                      natively, pi via pi-mcp-adapter
//   3. per-prompt retrieval (Claude's UserPromptSubmit hook) -> THIS extension:
//      before_agent_start runs `graft ask --json` on the prompt and injects a
//      pointers-only pack, gated on the same coverage floors and novelty rules
//      as graft's own relevantRetrieval() (STRONG 0.1 / HIGH 0.5, nudges ≤ 2,
//      never repeat a pointer). Edit/write marks the graph stale; the next turn
//      gets a one-line stale note.
//   4. statusline   -> THIS extension: the status text (ctx.ui.setStatus) shows
//      the graph's node/edge counts and freshness (graft/.cache/stats.json),
//      and the session's saved-tokens counter fed by the retrieval pack.
// Load paths:
//   pi:  ~/.pi/agent/extensions/graft.ts (global) or <repo>/.pi/extensions/graft.ts
//   omp: <repo>/.omp/hooks/pre/graft.ts or ~/.omp/agent/hooks/pre/graft.ts
// It no-ops in repos without graft/INDEX.md.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface GraftAskHit { kind: string; title: string; pointer: string; snippet: string; code?: string }
interface GraftAskJson { hits: GraftAskHit[]; coverage?: number; coverageStrong?: number; saved?: { files: number; baselineChars: number } }
interface GraftSessionState { injectedPointers: string[]; weakNudges: number; staleNoted: boolean; stale: boolean; savedTokens: number }
interface GraftExtensionContext { cwd: string }
interface BeforeAgentStartEvent { prompt?: string }
interface TurnEndEvent { timestamp?: number }
interface GraftStatusContext { cwd: string; ui?: { setStatus(key: string, text: string | undefined): void } }
interface ToolResultEvent { toolName?: string; isError?: boolean }
type PackResult = { text: string; used: string[] } | { text: null; used: [] };

const MIN_PROMPT_CHARS = 12; // graft hooks.ts: shorter prompts are conversational
const STRONG_FLOOR = 0.1;    // graft ask/fuse.ts coverageStrong floor
const HIGH_FLOOR = 0.5;      // graft ask/fuse.ts broad-coverage floor
const NUDGE_CAP = 2;         // graft: weak-match nudges per session
const INJECTED_CAP = 40;     // graft: novelty-gate memory
const PACK_CAP = 3;          // hits per injected pack
const ASK_TIMEOUT_MS = 8000; // graft: installed hook child budget
const STATE_FILE = "graft/.session-state.json";
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, multiedit: true, notebookedit: true };

const EMPTY_STATE: GraftSessionState = { injectedPointers: [], weakNudges: 0, staleNoted: false, stale: false, savedTokens: 0 };

function readIndex(dir: string): string | null {
  try { return readFileSync(`${dir}/graft/INDEX.md`, "utf8"); } catch { return null; }
}

function readState(dir: string): GraftSessionState {
  try {
    const raw: unknown = JSON.parse(readFileSync(`${dir}/${STATE_FILE}`, "utf8"));
    if (typeof raw !== "object" || raw === null) return { ...EMPTY_STATE };
    // Shape is written by this file only; a narrow guard, not a schema engine.
    const o = raw as Record<string, unknown>; // internal file, shape owned here
    const pointers = Array.isArray(o.injectedPointers)
      ? o.injectedPointers.filter((p): p is string => typeof p === "string")
      : [];
    return {
      injectedPointers: pointers,
      weakNudges: typeof o.weakNudges === "number" ? o.weakNudges : 0,
      staleNoted: o.staleNoted === true,
      stale: o.stale === true,
      savedTokens: typeof o.savedTokens === "number" ? o.savedTokens : 0,
    };
  } catch { return { ...EMPTY_STATE }; }
}

function writeState(dir: string, s: GraftSessionState): void {
  try { writeFileSync(`${dir}/${STATE_FILE}`, JSON.stringify(s)); } catch { /* best-effort */ }
}

function askGraft(dir: string, prompt: string): GraftAskJson | null {
  try {
    const r = spawnSync("graft", ["ask", prompt, ".", "--json", "--source", "-n", String(PACK_CAP)], {
      cwd: dir, timeout: ASK_TIMEOUT_MS, encoding: "utf8",
    });
    if (r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout) as GraftAskJson; // graft ask --json output, owned by graft
  } catch { return null; } // graft missing/stale/slow: never block the turn
}

function formatPack(hits: GraftAskHit[]): string {
  const blocks = hits.map((h, i) => {
    const ptr = h.pointer.split(",")[0].trim();
    const snip = h.snippet.replace(/\s+/g, " ").trim().slice(0, 140);
    return snip ? ` ${i + 1}. ${h.title}: ${ptr}\n    ${snip}` : ` ${i + 1}. ${h.title}: ${ptr}`;
  });
  return (
    `[graft] starting points for this task: pull the code inline with \`graft ask "<what you need>" --source\`, ` +
    `trace impact with \`graft callers <symbol>\`, or search with \`graft grep "<literal>"\`:\n${blocks.join("\n")}`
  );
}

/** Same two-clause gate as graft format.ts relevantRetrieval(): weak lexical
 * matches get at most a capped nudge; strong matches get fresh pointers only. */
function relevantRetrieval(ask: GraftAskJson, s: GraftSessionState): PackResult {
  if (!ask.hits?.length) return { text: null, used: [] };
  const seen = new Set(s.injectedPointers);
  const fresh = ask.hits.filter((h) => !seen.has(h.pointer));
  const strong = ask.coverageStrong ?? 0;
  const broad = ask.coverage ?? 0;
  if (strong < STRONG_FLOOR && broad < HIGH_FLOOR) {
    if (!fresh.length || s.weakNudges >= NUDGE_CAP) return { text: null, used: [] };
    s.weakNudges += 1;
    return {
      text:
        `[graft] this repo is indexed in graft/; before grepping source, pull context with ` +
        `\`graft ask "<question>" --source\` (ranked nodes with file:line), \`graft grep "<literal>"\` ` +
        `(exhaustive), or \`graft callers <symbol>\` (who calls it).`,
      used: [],
    };
  }
  if (!fresh.length) return { text: null, used: [] };
  const pack = fresh.slice(0, PACK_CAP);
  return { text: formatPack(pack), used: pack.map((h) => h.pointer) };
}

/** Graph freshness + size. Preferred source is graft/.cache/stats.json (the
 * hook-maintained cache); on pi/omp nothing maintains it, so fall back to the
 * graph itself (graft/.graph/wiring.json) the way graft's Claude statusline
 * resolveStats() does — the bar reflects reality immediately after a build. */
function renderStatus(dir: string, savedTokens: number): string {
  let stats: { nodeCount?: number; edgeCount?: number; dirty?: boolean; staleCount?: number } = {};
  try {
    stats = JSON.parse(readFileSync(`${dir}/graft/.cache/stats.json`, "utf8")) as typeof stats;
  } catch { /* cache absent: fall through to the graph */ }
  if (typeof stats.nodeCount !== "number" || stats.nodeCount === 0) {
    try {
      const wiring = JSON.parse(readFileSync(`${dir}/graft/.graph/wiring.json`, "utf8")) as
        { meta?: { nodeCount?: number; edgeCount?: number }; nodes?: unknown[]; edges?: unknown[] };
      stats = {
        nodeCount: wiring.meta?.nodeCount ?? (wiring.nodes ?? []).length,
        edgeCount: wiring.meta?.edgeCount ?? (wiring.edges ?? []).length,
      };
    } catch { /* not built */ }
  }
  const nodes = typeof stats.nodeCount === "number" ? stats.nodeCount : null;
  if (nodes === null) return "graft · not built · run `graft build`";
  const freshness = stats.dirty ? "⚠ stale" : "✓ synced";
  const saved = savedTokens > 0 ? ` · ~${savedTokens.toLocaleString()} tok saved` : "";
  return `graft · ${nodes} nodes / ${typeof stats.edgeCount === "number" ? stats.edgeCount : 0} edges · ${freshness}${saved}`;
}

export default function (pi: {
  on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: GraftExtensionContext) => Promise<{ message?: { customType: string; content: string; display: boolean } } | void>): void;
  on(event: "tool_result", handler: (event: ToolResultEvent, ctx: GraftExtensionContext) => Promise<void>): void;
  on(event: "turn_end", handler: (event: TurnEndEvent, ctx: GraftStatusContext) => Promise<void>): void;
  on(event: string, handler: (event: never, ctx: never) => unknown): void;
}): void {
  // UserPromptSubmit equivalent: gated retrieval pack before the agent loop.
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = String(event.prompt ?? "").trim();
    if (prompt.length < MIN_PROMPT_CHARS) return;
    const dir = ctx.cwd;
    if (!readIndex(dir)) return; // no graph here — nothing to say
    const s = readState(dir);
    const ask = askGraft(dir, prompt);
    if (!ask) { writeState(dir, s); return; }
    const pack = relevantRetrieval(ask, s);
    let content = pack.text;
    if (pack.used.length) {
      s.injectedPointers = [...s.injectedPointers, ...pack.used].slice(-INJECTED_CAP);
      // Honest floor only: the pack is pointers-only (~100 tok), so the credit
      // is what graft's ask said the hits replace (baselineChars/4) minus the
      // pack — never the full baseline (that would double-count the pull).
      const saved = ask.saved?.baselineChars ?? 0;
      const credit = Math.max(0, Math.round(saved / 4) - 100);
      s.savedTokens += credit;
    }
    if (s.stale && !s.staleNoted) {
      s.staleNoted = true;
      const note =
        "[graft] the graph in graft/ is now stale (code was edited after it was built); " +
        "refresh with `graft build` before relying on it for changed areas.";
      content = content ? `${content}\n${note}` : note;
    }
    writeState(dir, s);
    if (!content) return;
    return { message: { customType: "graft-retrieval", content, display: false } };
  });

  // PostToolUse(edit) equivalent: flip the stale flag; the note ships on the
  // next turn's injection instead of clobbering this edit's tool result.
  pi.on("tool_result", async (event, ctx) => {
    if (!EDIT_TOOLS[String(event.toolName ?? "").toLowerCase()]) return;
    if (event.isError) return;
    const dir = ctx.cwd;
    if (!readIndex(dir)) return;
    const s = readState(dir);
    if (!s.stale) { s.stale = true; writeState(dir, s); }
  });

  // Statusline: graft's bar lives in the host's footer status area instead of a
  // shell script — same content as Claude's statusline, refreshed per turn.
  pi.on("turn_end", async (_event, ctx) => {
    if (!ctx.ui) return; // print/JSON mode: no footer to paint
    const s = readState(ctx.cwd);
    ctx.ui.setStatus("graft", renderStatus(ctx.cwd, s.savedTokens));
  });
}
