/**
 * "Saved vs said": how often does the agent actually TELL the user what graft saved?
 *
 *   node scripts/tally-audit.mjs [transcript-dir] [--json]
 *
 * `savedTokens` (src/claude/state.ts) counts what graft *computed* — every
 * `[graft] tokens saved ≈ N` footer the PostToolUse accumulator swept up. This
 * script measures the other half, offline and in full detail: of the turns that
 * used graft, how many closed with the one-line tally SKILL.md asks for, was the
 * number right, and did it name the call count.
 *
 * The shipped metric (`graft_turns_bucket` / `reported_turns_bucket` on
 * `session_summary`) is the same ratio at bucket resolution, which is all that
 * can cross the wire. Run this locally when the aggregate says something
 * surprising and you need to see which turns and why.
 *
 * Reads Claude Code's own transcript JSONL, which defaults to
 * ~/.claude/projects/<slugified-cwd>/. Nothing leaves the machine.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SAVED_FOOTER = /\[graft\] tokens saved ≈ ([\d,]+)/g;
const TALLY = /graft\s+saved\s*[~≈]?\s*([\d,.]+)\s*(k|m)?\s*(?:tok|tokens)/i;
const CALLS = /(\d+)\s*calls?/i;
/** How far past the tally to look for its call count. The tally is one line
 * ("🌱 graft saved ~12,400 tokens this turn (3 calls)"); scanning the rest of
 * the reply instead would match any unrelated "3 calls" further down and report
 * near-perfect compliance for a field the agent mostly omits. */
const TALLY_WINDOW = 60;
/** Above this, a per-turn "saved" figure is an estimator artifact rather than a
 * saving — a `--depth all` closure or a vendored tree summing whole-file
 * baselines nobody would have read. Reported separately, never averaged in. */
const IMPLAUSIBLE_TOKENS = 1_000_000;

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
const dir = args[0] ?? defaultTranscriptDir();

function defaultTranscriptDir() {
  const slug = process.cwd().replace(/[/.]/g, "-");
  return join(homedir(), ".claude", "projects", slug);
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p?.type === "text" ? p.text ?? "" : "")).join("\n");
}
function isUserPrompt(o) {
  if (o.type !== "user" || o.isSidechain || o.isMeta) return false;
  const c = o.message?.content;
  if (typeof c === "string") return true;
  return Array.isArray(c) && !c.some((p) => p?.type === "tool_result");
}
function median(ns) {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

if (!existsSync(dir)) {
  console.error(`no transcripts at ${dir}`);
  process.exit(1);
}

const turns = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  let turn = null;
  const flush = () => { if (turn?.calls > 0) turns.push(turn); };
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;                    // a subagent's prose is not what the user read
    if (isUserPrompt(o)) { flush(); turn = { file, calls: 0, saved: 0, said: null, statedCalls: null }; continue; }
    if (!turn) continue;
    if (o.type === "user") {                        // a tool_result wearing the user role
      for (const m of JSON.stringify(o.message?.content ?? "").matchAll(SAVED_FOOTER)) {
        turn.calls++;
        turn.saved += Number(m[1].replace(/,/g, "")) || 0;
      }
    }
    if (o.type === "assistant") {
      const m = TALLY.exec(textOf(o.message?.content));
      if (m) {
        let n = Number(m[1].replace(/,/g, ""));
        if (m[2]?.toLowerCase() === "k") n *= 1e3;
        if (m[2]?.toLowerCase() === "m") n *= 1e6;
        turn.said = n;
        const c = CALLS.exec(textOf(o.message?.content).slice(m.index, m.index + TALLY_WINDOW));
        turn.statedCalls = c ? Number(c[1]) : null;
      }
    }
  }
  flush();
}

const said = turns.filter((t) => t.said !== null);
const plausible = turns.filter((t) => t.saved < IMPLAUSIBLE_TOKENS);
const outliers = turns.filter((t) => t.saved >= IMPLAUSIBLE_TOKENS);
const fidelity = { exact: 0, over: 0, under: 0 };
for (const t of said.filter((t) => t.saved > 0)) {
  const r = t.said / t.saved;
  if (r >= 0.9 && r <= 1.1) fidelity.exact++;
  else if (r > 1.1) fidelity.over++;
  else fidelity.under++;
}

const report = {
  transcripts: readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length,
  graft_turns: turns.length,
  reported: said.length,
  silent: turns.length - said.length,
  reported_pct: turns.length ? Number(((said.length / turns.length) * 100).toFixed(1)) : 0,
  stated_call_count: said.filter((t) => t.statedCalls !== null).length,
  median_saved_per_turn: median(plausible.map((t) => t.saved)),
  fidelity,
  implausible_turns: outliers.length,
  implausible_max: outliers.length ? Math.max(...outliers.map((t) => t.saved)) : 0,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { graft_turns: n } = report;
  console.log(`transcripts scanned:      ${report.transcripts}  (${dir})`);
  console.log(`turns that used graft:    ${n}`);
  console.log(`  ...reported a tally:    ${report.reported}  (${report.reported_pct}%)`);
  console.log(`  ...silent:              ${report.silent}`);
  console.log(`  ...named the call count ${report.stated_call_count}/${report.reported}`);
  console.log(`median saved per turn:    ${report.median_saved_per_turn.toLocaleString()} tok`);
  console.log(`reported number vs footer sum (±10%): exact ${fidelity.exact} · over ${fidelity.over} · under ${fidelity.under}`);
  if (outliers.length) {
    console.log(`\n⚠ ${outliers.length} turn(s) claim ≥${IMPLAUSIBLE_TOKENS.toLocaleString()} tokens saved ` +
      `(max ${report.implausible_max.toLocaleString()}) — an estimator artifact, excluded from the median. ` +
      `See savingsFor() in src/context/savings.ts.`);
  }
}
