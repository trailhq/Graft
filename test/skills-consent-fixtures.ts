/**
 * A sandbox for the consent tests: a made-up checkout (acme/shop), a Trail
 * home, a transcript that grows between hook calls, and the hooks' consent
 * steps emulated through the real gate, fold and session lock: Stop's moment
 * 2 (3.5 steps 8 to 10), the prompt hook's answer capture and save request
 * (3.2 steps 4 and 6), PreToolUse's save gate (3.3 step 3) and the CLI half
 * (4.9). `box({ host: "codex" })` writes the same session as a Codex rollout
 * (phase 2 c6), so a journey runs through either dialect; `tierA` stands in
 * for the lab's TRAIL_TIER_CODEX=A (4.18). Synthetic data only. Not a test
 * file itself.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";
import { skillsGate, withSkillSession, currentRun, type GateCtx } from "../src/trace/skill-session.js";
import { checkedSuccess, costly, findPriorSheet, lastGoodRun, readRunSheet, runHelpers, writeRunSheet } from "../src/trace/runs.js";
import { notePoolDay } from "../src/trace/pool.js";
import { isSaveRequest, scopeWords, typedPrompt } from "../src/trace/typed.js";
import { localDate } from "../src/skills/settings.js";
import { recordShown } from "../src/skills/offers.js";
import { captureAnswer, noteSaveRequest, offerDue } from "../src/skills/offer-moment.js";
import { compileRun } from "../src/skills/compile.js";
import { nameTaken } from "../src/skills/store.js";
import { cliAdd, parseSkillsAdd, saveGateFor } from "../src/skills/save-gate.js";
import type { PendingOffer, SkillSessionState } from "../src/trace/types.js";
import type { HookOut } from "../src/skills/types.js";
import { noteCodexPrompt } from "../src/trace/codex.js";
import * as CX from "./codex-fixtures.js";

export const SHOP = "github.com/acme/shop";
/** 2026-10-27T10:00:00Z plus `sec` seconds. */
export const T = (sec: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, 0) + sec * 1000);
export const iso = (sec: number) => T(sec).toISOString();

let boxes = 0;
export interface Box {
  root: string; repo: string; env: NodeJS.ProcessEnv; tx: string; sid: string;
  payload: Record<string, unknown>; ids: number;
  /** Whose transcript this is: Claude Code's (the default) or a Codex rollout. */
  host: "claude" | "codex";
  /** Codex only: the gate's ctx at tier A, as TRAIL_TIER_CODEX=A gives it in a test home (4.18). */
  tierA: boolean;
}

/** A fresh box: skills on since August, the transcript empty, the gate's ctx pointed at the fake checkout. */
export function box(opts: { settings?: Record<string, unknown>; payload?: Record<string, unknown>; env?: Record<string, string>; host?: "claude" | "codex"; tierA?: boolean } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), "skills-consent-"));
  const repo = join(root, "src", "shop");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/shop.git\n');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TRAIL_HOME: join(root, "trail-home"), CLAUDE_CODE_ENTRYPOINT: "cli", ...opts.env };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: "2026-08-01T00:00:00.000Z", ...opts.settings }));
  // A repo Trail knows (D117 (3), J16): its key is in the repo index, as after trail init.
  mkdirSync(join(env.TRAIL_HOME!, "repos"), { recursive: true });
  writeFileSync(join(env.TRAIL_HOME!, "repos", "index.json"), JSON.stringify({ aliases: {}, roots: { "0000000000000000000000000000000000000001": SHOP } }));
  if (opts.host === "codex") {
    env.CODEX_HOME = join(root, ".codex");
    const sid = `019fa295-20a9-7943-90ae-${String(++boxes).padStart(12, "0")}`;
    const tx = CX.rollout(root, [CX.meta({ id: sid, cwd: repo }), CX.turnContext(repo)], sid);
    const payload = { session_id: sid, transcript_path: tx, cwd: "/home/dev/shop", permission_mode: "default", turn_id: "turn-1", model: "gpt-5-codex", ...opts.payload };
    return { root, repo, env, tx, sid, payload, ids: 0, host: "codex", tierA: opts.tierA === true };
  }
  const sid = `5f0c1a2b-3c4d-4e5f-8a9b-${String(++boxes).padStart(12, "0")}`;
  const tx = join(root, ".claude", "projects", "-home-dev-shop", `${sid}.jsonl`);
  mkdirSync(join(tx, ".."), { recursive: true });
  writeFileSync(tx, "");
  const payload = { session_id: sid, transcript_path: tx, cwd: "/home/dev/shop", permission_mode: "default", ...opts.payload };
  return { root, repo, env, tx, sid, payload, ids: 0, host: "claude", tierA: false };
}

/** The gate's ctx at `sec`, with the checkout the made-up repo (the payload's cwd is not a real folder). */
export function ctxAt(b: Box, sec: number, payload: Record<string, unknown> = {}): GateCtx {
  const g = skillsGate({ ...b.payload, ...payload }, "/home/dev/shop", b.env, T(sec));
  if (!g.ok) throw new Error(`gate: ${g.why}`);
  const a = b.tierA ? { tier: "A" as const, learn: g.ctx.fold, learnOff: g.ctx.fold ? null : g.ctx.learnOff } : {};
  return { ...g.ctx, ...a, checkout: b.repo, repoKey: SHOP };
}

export const where = (b: Box, sec: number) => ({ cwd: b.repo, gitBranch: "main", sessionId: b.sid, timestamp: iso(sec) });
export function append(b: Box, entries: object[]): void {
  appendFileSync(b.tx, jsonl(entries));
}
export const nextId = (b: Box) => `${b.host === "codex" ? "call_" : "toolu_"}${b.sid.slice(-4)}${String(++b.ids).padStart(4, "0")}`;

/** The host's lines: the agent calling Bash, its result, the agent's words, the person's prompt. */
export const callLine = (b: Box, id: string, command: string, sec: number, description = "run it") =>
  b.host === "codex" ? CX.exec(id, command, b.repo, sec) : toolUse(id, "Bash", { command, description }, where(b, sec));
export const resultLine = (b: Box, id: string, output: string, isError: boolean | undefined, sec: number) =>
  b.host === "codex" ? CX.execOut(id, isError ? 1 : 0, output, sec) : toolResult(id, output, isError, where(b, sec));
export const saidLines = (b: Box, text: string, sec: number): object[] => (b.host === "codex" ? CX.reply(text, sec) : [said(text, where(b, sec))]);

/** A Bash call and its result in the transcript. */
export function bash(b: Box, sec: number, command: string, output: string, isError?: boolean, id = nextId(b)): string {
  append(b, [callLine(b, id, command, sec), resultLine(b, id, output, isError, sec + 1)]);
  return id;
}

/** The person types `text` (a line the transcript shows as typed by them). Codex: the event and the model's copy. */
export function say(b: Box, sec: number, text: string, extra: Record<string, unknown> = {}): void {
  append(b, b.host === "codex" ? [CX.userMessage(text, sec), CX.userItem(text, sec)] : [typed(text, { ...where(b, sec), ...extra })]);
}

/** Codex: the prompt hook saw `text` (its keyed hash in the session state, P30), with nothing else it does. Claude: nothing. */
export function hookSaw(b: Box, sec: number, text: string): void {
  if (b.host !== "codex") return;
  withSkillSession(ctxAt(b, sec), { catchUp: false, prepare: (st) => noteCodexPrompt(st, text, b.env) }, () => null);
}

/** A release that worked: build, publish (it failed once first when `failedFirst`), then npm shows the version. */
export function release(b: Box, sec: number, opts: { version?: string; failedFirst?: boolean; ask?: string } = {}): { ids: string[] } {
  const v = opts.version ?? "1.4.3";
  hookSaw(b, sec, opts.ask ?? `publish ${v}`);
  say(b, sec, opts.ask ?? `publish ${v}`);
  const ids: string[] = [];
  ids.push(bash(b, sec + 10, "npm run build", "built in 2.1s"));
  if (opts.failedFirst) bash(b, sec + 15, `npm publish acme-cli-${v}.tgz`, "npm error code E403\nnpm error 403 Forbidden", true);
  ids.push(bash(b, sec + 20, `npm publish acme-cli-${v}.tgz --access public`, `+ acme-cli@${v}`));
  ids.push(bash(b, sec + 30, "npm view acme-cli version", v));
  append(b, saidLines(b, `Published ${v}; npm shows it.`, sec + 40));
  return { ids };
}

/** Two earlier session-days of the release job, both costly, so today's is the 3rd (4.12 condition 5). */
export function seedPool(b: Box, days: string[] = ["2026-10-20", "2026-10-23"]): void {
  for (const [i, d] of days.entries()) notePoolDay(SHOP, { job: "release", words: ["publish"] }, { d, s: `seed${i}`, costly: true }, null, b.env, T(0));
}

/** Stop (3.5 steps 3, 8 to 10): judge the open run, write its sheet and pool day, and offer when due. */
export function stop(b: Box, sec: number, opts: { lastAssistant?: string; ctx?: GateCtx } = {}): { offer: PendingOffer | null; why?: string; runId: string | null } {
  const ctx = opts.ctx ?? ctxAt(b, sec);
  const r = withSkillSession(ctx, { catchUp: true }, (st, fold) => {
    const run = currentRun(st);
    if (!run) return { offer: null, why: "no-run", runId: null };
    const v = checkedSuccess(run, opts.lastAssistant ?? fold?.lastAssistant ?? null);
    run.end = v.end;
    const meta = { host: ctx.host, tier: ctx.tier, sessionHash: ctx.sessionHash, helpers: runHelpers(run) };
    const sheet = v.checked ? writeRunSheet(run, v, meta, b.env) : null;
    if (ctx.learn && run.job === "release" && run.stepCalls > 0) {
      notePoolDay(run.repoKey, { job: "release", words: run.jobWords }, { d: localDate(run.startedAt), s: ctx.sessionHash, costly: costly(run) }, sheet ? run.id : null, b.env, ctx.now);
    }
    const due = offerDue({ run, verdict: v, sheet, st, ctx, channel: "stop" });
    if (!due.due) return { offer: null, why: due.why, runId: run.id };
    st.pendingOffer = due.offer;
    recordShown(due.offer, run.repoKey, b.env, ctx.now);
    st.offerUsed = true;
    st.offerUsedBy = "offer";
    return { offer: due.offer, runId: run.id };
  });
  if (!r) throw new Error("stop: lock timed out");
  return r;
}

export type Order = "line-first" | "hook-first";
/**
 * The prompt hook (3.2 steps 2 to 4 and 6) for a prompt the person typed: `line-first` writes the typed line before
 * the hook runs, `hook-first` after it, so both orders are tested.
 */
export function prompt(b: Box, sec: number, text: string, order: Order = "line-first", extra: Record<string, unknown> = {}): { out: HookOut | null; answer: string | null; save?: string } {
  if (order === "line-first") say(b, sec, text, extra);
  const ctx = ctxAt(b, sec);
  const t = typedPrompt(text);
  // Codex: the hook records the prompt's keyed hash before its catch-up (P30, c8's prompt hook).
  const prepare = b.host === "codex" ? (st: SkillSessionState) => noteCodexPrompt(st, text, b.env) : undefined;
  const r = t === null ? { out: null, answer: null } : withSkillSession(ctx, { catchUp: ctx.fold, waitMs: 150, prepare }, (st, fold) => {
    const cap = captureAnswer(st, t, b.env, ctx.now);
    if (cap.out) return { out: cap.out, answer: cap.answer };
    if (ctx.fold && isSaveRequest(t)) {
      const good = lastGoodRun(st, b.env);
      if ("none" in good) return { out: { context: `none:${good.none}` }, answer: cap.answer, save: good.none };
      // 3.2 step 6.3, as g6's promptSkills does it: the skill compiled now is what the person asked to keep (D73).
      const scope = scopeWords(t);
      const keys = st.scopeKeys.includes(good.run.repoKey) ? st.scopeKeys : [good.run.repoKey];
      const c = compileRun(good.sheet, {
        repoRoot: ctx.repoKey === good.sheet.repoKey ? ctx.checkout : "", home: b.env.HOME!, platform: process.platform,
        prior: findPriorSheet(good.sheet, b.env), moment: "asked", applies: scope === "every repo" ? "every repo" : good.run.repoKey, now: ctx.now,
        askedWith: t, readSheet: (id) => readRunSheet(id, b.env), taken: (n) => nameTaken(n, { repoKeys: keys, checkout: ctx.checkout, env: b.env }) !== null,
      });
      if (!c.ok) return { out: { context: `refused:${c.reason}` }, answer: cap.answer };
      noteSaveRequest(st, fold, { runId: good.run.id, typed: t, scope, skill: c.skill }, b.env, ctx.now);
      return { out: { context: `add ${good.run.id}` }, answer: cap.answer, save: good.run.id };
    }
    return { out: cap.extra ? { context: cap.extra } : null, answer: cap.answer };
  });
  if (order === "hook-first") say(b, sec, text, extra);
  if (!r) throw new Error("prompt: lock timed out");
  return r;
}

/** `fn` with the process in `dir`, as the CLI runs in the agent's shell; the old folder after. */
export function cliIn<T>(dir: string, fn: () => T): T {
  const was = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(was);
  }
}

export interface AddResult { id: string; decision: ReturnType<typeof saveGateFor>; cli: ReturnType<typeof cliAdd> | null }
/**
 * The agent runs `command`: its tool_use line goes into the transcript, PreToolUse's save gate decides (3.3 step 3),
 * and when it was let through the CLI half runs (`trail skills add <name> --run <id>`), then the result line.
 * `cliCwd`: the folder the agent's shell runs the CLI in (the checkout by default), as its cwd and the process's.
 */
export function add(b: Box, sec: number, command: string, opts: { name?: string; runId?: string; ctx?: GateCtx; skipHook?: boolean; skipCli?: boolean; input?: Record<string, unknown>; cliCwd?: string } = {}): AddResult {
  const id = nextId(b);
  append(b, [callLine(b, id, command, sec, "keep it")]);
  const ctx = opts.ctx ?? ctxAt(b, sec);
  const input = { ...b.payload, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id, ...opts.input };
  const decision = opts.skipHook ? null : saveGateFor(input, ctx);
  const argv = parseSkillsAdd(command);
  const name = opts.name ?? argv?.name;
  const runId = opts.runId ?? argv?.runId;
  let cli: ReturnType<typeof cliAdd> | null = null;
  if (!decision && !opts.skipCli && name && runId) cli = cliIn(opts.cliCwd ?? b.repo, () => cliAdd(name, runId, b.env, T(sec + 1), opts.cliCwd ?? b.repo));
  append(b, [resultLine(b, id, cli ? cli.lines.join("\n") : "", decision !== null, sec + 2)]);
  return { id, decision, cli };
}

/** The session state on disk now (read through the lock, no catch-up). */
export function state(b: Box): SkillSessionState {
  const st = withSkillSession(ctxAt(b, 0), { catchUp: false }, (s) => structuredClone(s));
  if (!st) throw new Error("state: lock timed out");
  return st;
}

/** What Trail keeps: skill folders and held items. */
export function kept(b: Box): { skills: string[]; held: string[] } {
  const ls = (d: string) => {
    try {
      return readdirSync(d).filter((n) => !n.startsWith(".")).sort();
    } catch {
      return [];
    }
  };
  return { skills: ls(join(b.env.TRAIL_HOME!, "skills")), held: ls(join(b.env.TRAIL_HOME!, "held")) };
}

/**
 * A release offered at Stop: the pool seeded, the run checked, the offer pending and shown, and the agent's reply
 * (the Stop block's continuation) ending with the offer's 2 lines, as the block tells it to. `say: false` leaves
 * the reply out.
 */
export function offered(b: Box, sec = 0, opts: { failedFirst?: boolean; say?: boolean } = {}): { offer: PendingOffer; ids: string[] } {
  seedPool(b);
  const { ids } = release(b, sec, opts);
  const s = stop(b, sec + 50);
  if (!s.offer) throw new Error(`no offer: ${s.why}`);
  if (opts.say !== false) sayOffer(b, sec + 52, s.offer);
  return { offer: s.offer, ids };
}

/** The agent's reply that ends with the offer's 2 lines (after `before`), or with `after` added past them. */
export function sayOffer(b: Box, sec: number, o: PendingOffer, extra: { before?: string; after?: string } = {}): void {
  append(b, saidLines(b, `${extra.before ?? "Done."}\n\n${o.lines[0]}\n${o.lines[1]}${extra.after ?? ""}`, sec));
}
