import { basename } from 'node:path';
import { toPosixPath } from '../util/paths.js';
import type { Stats, SessionState } from './state.js';
import type { GraphV1, EdgeV1 } from '../graph/types.js';
// The injection gate reuses the federation floors rather than inventing its own:
// "did we hit a real name, or match broadly enough to trust anyway" is the same
// question in both places, and one set of calibrated numbers beats two.
import { HIGH_FLOOR, STRONG_FLOOR } from '../ask/fuse.js';
import { dollarsSaved, formatDollars } from '../context/price.js';

const C = {
  indigo: (s: string) => `\x1b[38;2;84;111;255m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;2;224;165;68m${s}\x1b[0m`,
  muted: (s: string) => `\x1b[38;5;244m${s}\x1b[0m`,
  text: (s: string) => `\x1b[38;5;251m${s}\x1b[0m`,
};
const SEP = C.muted(' · ');

export function freshnessSegment(s: Stats): string {
  if (s.syncing) return C.amber('syncing…');
  if (s.dirty && s.staleCount > 0) return C.amber(`⚠ ${s.staleCount} stale`);
  if (s.dirty) return C.amber('⚠ stale');
  return C.indigo('✓ synced');
}

export function renderStatusline(
  stats: Stats | null,
  session: SessionState | null,
  ctx: { ctxPct: number | null },
): string[] {
  if (!stats) {
    return [C.muted('◤ graft · not built · run ') + C.text('graft build')];
  }
  const top = [C.muted('◤ ') + C.indigo('graft'), C.text(`${stats.nodeCount} nodes / ${stats.edgeCount} edges`)];
  top.push(freshnessSegment(stats));
  const saved = session?.savedTokens ?? 0;
  if (saved > 0) {
    // Dollars only once a turn has actually been billed — see context/price.ts.
    // Until then (turn one, or a host with no transcript) the token count
    // stands alone rather than carrying a rate nobody measured.
    const usd = dollarsSaved(saved, session?.inputCostMicros, session?.inputTokensBilled);
    const money = usd === null ? '' : ` · ~${formatDollars(usd)}`;
    top.push(C.indigo(`~${saved.toLocaleString()} tok saved${money}`));
  }

  const bottom: string[] = [];
  if (typeof ctx.ctxPct === 'number') bottom.push(C.text(`ctx ${ctx.ctxPct}%`));
  if (stats.lastFile) bottom.push(C.muted('last: ') + C.text(basename(stats.lastFile)));

  const lines = [top.join(SEP)];
  if (bottom.length) lines.push(C.muted('▸ ') + bottom.join(SEP));
  return lines;
}

function nodeIdsInFile(w: GraphV1, filePath: string): Set<string> {
  const nodes = w.nodes ?? [];
  // The hook is handed whatever the host wrote in `tool_input.file_path` — on
  // Windows that is a backslash path (`E:\repo\src\a.gd`), while every
  // `node.path` is posix by construction. Without this normalization the suffix
  // test could never match on Windows and the blast radius was silently empty
  // for every language, not just one.
  const target = toPosixPath(filePath);
  return new Set(
    nodes.filter((n) => n.path && (target === n.path || target.endsWith(`/${n.path}`)))
      .map((n) => n.id),
  );
}

export function incomingEdges(w: GraphV1, filePath: string): EdgeV1[] {
  const ids = nodeIdsInFile(w, filePath);
  if (!ids.size) return [];
  return (w.edges ?? []).filter((e) => ids.has(e.target) && !ids.has(e.source));
}

export function formatBlastRadius(w: GraphV1, filePath: string, cap = 8): string | null {
  const edges = incomingEdges(w, filePath);
  if (!edges.length) return null;
  const byId = new Map((w.nodes ?? []).map((n) => [n.id, n]));
  const items = edges.slice(0, cap).map((e) => {
    const n = byId.get(e.source);
    const label = n ? `${n.name} (${basename(n.path)})` : e.source;
    return ` • ${e.relation} ← ${label}`;
  });
  const more = edges.length > cap ? `\n • +${edges.length - cap} more` : '';
  return `[graft] blast radius for ${basename(filePath)}, who depends on it:\n${items.join('\n')}${more}`;
}

export interface AskJson {
  query: string; mode: string;
  hits: { kind: string; title: string; pointer: string; snippet: string; score: number; code?: string }[];
  /** Set by `ask --source`: whole size of the files these hits cover (baseline). */
  saved?: { files: number; baselineChars: number };
  /** Lexical mode: share (0..1) of the query's distinct terms the top hit matched. */
  coverage?: number;
  /** Lexical mode: the same share over the top hit's NAME field only — "did the
   * query hit a real symbol, or only words buried in some body?". `ask --json`
   * has always emitted it; the gate below is what finally reads it. */
  coverageStrong?: number;
}

function tokensOf(chars: number): number { return Math.round(chars / 4); }

/** The retrieval pack body — pointers, snippets, and (in --source mode) the
 * actual code span for each hit, so the agent reads it here instead of opening
 * the file. Kept separate so the tokens-saved math can measure this exact text. */
function retrievalBody(hits: AskJson['hits']): string {
  const blocks = hits.map((h, i) => {
    const ptr = (h.pointer ?? '').split(',')[0].trim();
    const snip = (h.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    let b = ` ${i + 1}. ${h.title}: ${ptr}`;
    if (snip) b += `\n    ${snip}`;
    if (h.code) b += `\n\`\`\`\n${h.code}\n\`\`\``;
    return b;
  });
  // Two pack shapes: with inlined code the pack is substitutive (read here, don't
  // re-open); without code it is pointers-only — locators the agent may follow,
  // pulling spans itself via `graft ask --source` (push→pull: per-prompt injected
  // tokens are always fresh full-price input, so the pack stays tiny).
  const header = hits.some((h) => h.code)
    ? '[graft] retrieved context, read these spans; do not re-open the files:'
    : '[graft] starting points for this task: pull the code inline with `graft ask "<what you need>" --source`, trace impact with `graft callers <symbol>`, or search with `graft grep "<literal>"`:';
  return `${header}\n${blocks.join('\n')}`;
}

/** Tokens saved (baseline − this pack), or 0 when no honest estimate applies. */
export function retrievalTokensSaved(ask: AskJson, cap = 5): number {
  const hits = (ask.hits ?? []).slice(0, cap);
  if (!hits.length || !ask.saved || ask.saved.baselineChars <= 0) return 0;
  const pack = tokensOf(retrievalBody(hits).length);
  const base = tokensOf(ask.saved.baselineChars);
  return base > pack ? base - pack : 0;
}

export function formatRetrieval(ask: AskJson, cap = 5): string | null {
  const hits = (ask.hits ?? []).slice(0, cap);
  if (!hits.length) return null;
  const body = retrievalBody(hits);
  const saved = retrievalTokensSaved(ask, cap);
  if (saved <= 0) return body;
  const base = tokensOf(ask.saved!.baselineChars);
  const pct = Math.round((saved / base) * 100);
  return (
    `${body}\n[graft] tokens saved ≈ ${saved.toLocaleString()} (${pct}%); this pack ≈ ` +
    `${tokensOf(body.length).toLocaleString()} tok vs reading the ${ask.saved!.files} file(s) whole ≈ ` +
    `${base.toLocaleString()} tok (estimate).`
  );
}

/**
 * Superseded by the two-clause strength gate in {@link relevantRetrieval} (see
 * {@link STRONG_FLOOR} / {@link HIGH_FLOOR}). Kept exported because the old
 * single-clause floor is still the documented reference point for why it changed:
 * it sat at 0.15, and a prompt measuring 0.165 / strong 0.033 cleared it by 0.015
 * and injected three test files for a question whose answer was elsewhere. The
 * comment it used to carry justified leaning low — "a wrongly-skipped pack is
 * recoverable, the agent pulls with `graft ask`" — and that assumption is exactly
 * what a traced session falsified: the agent did not pull. It grepped 38 times.
 */
export const INJECT_MIN_COVERAGE = 0.15;

/** How many recently-injected pointers the novelty gate remembers per session. */
const INJECTED_POINTERS_CAP = 40;

/** How many weak-match nudges one session may spend. A line that shows up every
 * turn stops being read; two is enough to land the habit without becoming
 * wallpaper. */
export const NUDGE_CAP = 2;

/** The line injected instead of a weak pack: names the command, says why, once.
 * Deliberately not an imperative about graft in general — it's a fact about this
 * prompt's match quality plus the command that fixes it. */
export function weakMatchNudge(s: SessionState, strong: number): string | null {
  const spent = s.nudges ?? 0;
  if (spent >= NUDGE_CAP) return null;
  s.nudges = spent + 1;
  return (
    `[graft] no strong match for this prompt (name-field match ${strong.toFixed(2)}) — the graph ` +
    `has more than this probe found. Run \`graft ask "<your task>" --source\` before grepping.`
  );
}

/**
 * The per-prompt injection gate. Returns the text to inject, or null to stay
 * silent. Mutates `s` to remember what was shown (caller persists it).
 *
 * Gate 1 — **strength**. A pack earns its place only if the top hit either landed
 * on a real symbol NAME (`coverageStrong ≥ STRONG_FLOOR`) or matched the query
 * broadly enough to trust regardless (`coverage ≥ HIGH_FLOOR`). This is the same
 * two-clause rule `fuse.ts` already uses to decide whether a whole sub-repo joins
 * a cross-repo ranking — a cheaper decision than this one, previously held to a
 * stricter standard. Failing it emits {@link weakMatchNudge} rather than nothing:
 * silence leaves the agent with no signal at all, and a borderline pack is worse
 * than either, because it reads as orientation and suppresses the very retrieval
 * call it should have triggered. Structural results carry neither score — the
 * resolved intent is itself the relevance signal — so they always pass.
 *
 * Gate 2 — **novelty**. Hits whose pointer was already injected this session are
 * dropped; if none remain, the pack is skipped.
 */
export function relevantRetrieval(ask: AskJson, s: SessionState, cap = 3): string | null {
  if (!(ask.hits ?? []).length) return null;
  const lexical = typeof ask.coverage === 'number' || typeof ask.coverageStrong === 'number';
  if (lexical) {
    const strong = ask.coverageStrong ?? 0;
    const broad = ask.coverage ?? 0;
    if (strong < STRONG_FLOOR && broad < HIGH_FLOOR) return weakMatchNudge(s, strong);
  }
  const seen = new Set(s.injectedPointers ?? []);
  const fresh = ask.hits.filter((h) => !seen.has(h.pointer));
  if (!fresh.length) return null;
  const txt = formatRetrieval({ ...ask, hits: fresh }, cap);
  if (!txt) return null;
  s.injectedPointers = [...(s.injectedPointers ?? []), ...fresh.slice(0, cap).map((h) => h.pointer)]
    .slice(-INJECTED_POINTERS_CAP);
  return txt;
}

export function formatOrientation(indexMd: string, budgetBytes = 1500, staleNote?: string): string {
  // Always-on directive (cached, seen turn 0) so the agent reaches for graft's
  // commands without waiting for the discretionary skill to load. This is the
  // reliable steering channel (fires every session, unlike the discretionary
  // skill): it carries a one-line description of each tool AND the call-discipline
  // that keeps the agent from over-tooling. Positive only, names the tools,
  // forbids nothing.
  const directive =
    `[graft] This repo is indexed by graft. To find, understand, or change code, reach for graft first; it answers from a prebuilt graph with exact file:line, faster than grep/read. Pick the ONE tool that fits and act on its answer. Most tasks need a single call. If one isn't enough, switch to the tool that fits the next need; don't call the same tool again and again or re-ask a question reworded:\n` +
    `  • graft ask "<task>" --source: locate + understand. Ranked nodes with the code inlined at each file:line (the ≤8-line crux; add --full for the whole span). The default for "how does X work" / "where is Y".\n` +
    `  • graft grep "<literal>": exhaustive find. Every occurrence, grouped by enclosing symbol; use when you need them ALL (ask is ranked top-N and misses instances).\n` +
    `  • graft skeleton <file>: a file's whole API in ~200 tokens, every signature + span, ~10x cheaper than reading the file.\n` +
    `  • graft callers <sym> [--direction out] [--depth N|all]: exact edges. Who calls it (default), what it calls (--direction out), or the full blast radius (--depth 2, or --depth all for every connected source). Run before you change a symbol.\n` +
    `  • graft map: orientation for an unfamiliar repo, directory clusters, hubs, hotspots. map alone is the answer; don't then skeleton every subsystem it names.\n` +
    `  In a monorepo, add --in <path>/ to ask/grep/callers to scope to one sub-project; hits are labeled [scope/].\n` +
    `  Already know the file or symbol to change? Go straight to it: graft grep "<symbol>", read the span, edit. Save ask for when you don't yet know where the code lives.\n` +
    `  Refactor, rename, or multi-file change? Run graft callers <sym> --depth all FIRST to map every connected file; editing the primary file and stopping is the classic miss (platform siblings, a new file to extract).\n` +
    `Each tool opens its output with a "[graft] tokens saved ≈ N" line, sometimes with its dollar value; when you used graft this turn, close your reply with a one-line tally of the total saved, dollars included when given (e.g. 🌱 graft saved ~12k tokens (~$0.04) this turn, 3 calls). Never price tokens yourself; never pipe graft through head/tail — it is already capped, and clipping drops that line.\n`;
  const banner = staleNote ? `${staleNote}\n\n` : "";
  return `${banner}${directive}\nrepo map (graft/INDEX.md):\n${indexMd.slice(0, budgetBytes)}`;
}

export function renderSubagent(agentName: string, session: SessionState | null): string {
  const q = session?.perAgentQuery?.[agentName];
  const tail = q ? SEP + C.muted('graft: ') + C.text(q) : '';
  return C.muted('◤ ') + C.indigo(agentName) + tail;
}
