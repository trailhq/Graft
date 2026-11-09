/**
 * Builders for the skills trace tests: an empty session state, an injection,
 * and transcripts shaped like Claude Code's (one tool_use per assistant line,
 * `cwd` and `gitBranch` on every line, results as user lines). Made-up repos
 * (acme/shop, acme/storefront) and prompts only. Not a test file itself.
 */
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { GatedKind, RunCall, RunState, SkillInjection, SkillSessionState } from "../src/trace/types.js";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";
import { readNewEvents } from "../src/trace/claude.js";
import { foldEvents, type FoldContext, type FoldResult } from "../src/trace/runs.js";

export function emptyState(extra: Partial<SkillSessionState> = {}): SkillSessionState {
  return {
    v: 1, sessionHash: "e76b4ca7f1a0", host: "claude", tier: "A", learn: true, scopeKeys: ["github.com/acme/shop"],
    epoch: 0, pendingBoundary: false, runs: [], pendingOffer: null, offerUsed: false, offerUsedBy: null, saveRequest: null,
    injected: [], credit: [], tampered: null, updatedAt: "2026-10-01T10:00:00.000Z", ...extra,
  };
}

export function injection(extra: Partial<SkillInjection> = {}): SkillInjection {
  return {
    injId: "i-0b12aa", skillId: "s-7f3a2c", name: "release-npm", epoch: 0, at: "2026-10-01T10:00:00.000Z", cue: "job",
    params: { version: "1.4.3" },
    steps: ["npm run build", "npm version 1.4.3 --no-git-tag-version", "npm pack", "npm publish acme-cli-1.4.3.tgz --access public", "npm publish acme-core-1.4.3.tgz --access public"],
    gated: [{ step: 4, kind: "publish" as GatedKind }, { step: 5, kind: "publish" as GatedKind }],
    check: "npm view acme-cli version", runId: null, live: true, ...extra,
  };
}

/** A clock: `at(0)` is 2026-10-01T10:00:00Z, `at(n)` n seconds later. */
export const at = (sec: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + sec * 1000).toISOString();

let ids = 0;
/** A Bash call and its result, `sec` seconds into the session. */
export function bash(command: string, output: string, opts: { sec?: number; isError?: boolean; cwd?: string; branch?: string; id?: string; bg?: boolean } = {}): object[] {
  const id = opts.id ?? `toolu_${String(++ids).padStart(4, "0")}`;
  const sec = opts.sec ?? 0;
  const where = { ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.branch ? { gitBranch: opts.branch } : {}) };
  return [
    toolUse(id, "Bash", { command, description: "run it", ...(opts.bg ? { run_in_background: true } : {}) }, { timestamp: at(sec), ...where }),
    toolResult(id, output, opts.isError, { timestamp: at(sec + 1), ...where }),
  ];
}

export const ask = (text: string, sec = 0, extra: Record<string, unknown> = {}) => typed(text, { timestamp: at(sec), ...extra });
export const reply = (text: string, sec = 0) => said(text, { timestamp: at(sec) });

export function writeTranscript(entries: object[], tag = "tx"): string {
  const dir = mkdtempSync(join(tmpdir(), `trace-run-${tag}-`));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, jsonl(entries));
  return path;
}

export function runCall(extra: Partial<RunCall> = {}): RunCall {
  return {
    id: "toolu_01", at: at(10), cmd: "npm test", key: "github.com/acme/shop", cwd: "", bg: false, failed: false, isError: false,
    kind: "step", src: { use: 100, result: 200 }, ...extra,
  };
}

export function runState(extra: Partial<RunState> = {}): RunState {
  return {
    id: "r-1001-3f9a", epoch: 0, startedAt: at(0), lastAt: at(60), repoKey: "github.com/acme/shop", branch: "main", job: "tests",
    jobWords: ["integration", "tests"], promptParams: {}, sharedWords: [], typedCount: 1, toolCalls: 1, edits: 0, commands: 1,
    failedCount: 0, stepCalls: 1, calls: [runCall()], closed: true, end: "done", sheet: "none", checkIndex: null, poolNoted: false, ...extra,
  };
}

/** Made-up checkouts: /home/dev/shop and /home/dev/storefront are repos; anything else is outside git. */
export const REPOS: Record<string, string> = { "/home/dev/shop": "github.com/acme/shop", "/home/dev/storefront": "github.com/acme/storefront" };
/** Compared resolved, so a folder a cd lands in (resolve() gives Windows a drive and '\') still finds its checkout. */
const rootOf = (p: string) => Object.keys(REPOS).find((r) => resolve(p) === resolve(r) || resolve(p).startsWith(resolve(r) + sep)) ?? null;

export function foldCtx(extra: Partial<FoldContext> = {}): FoldContext {
  return {
    sessionHash: "e76b4ca7f1a0", checkout: "/home/dev/shop", repoKey: "github.com/acme/shop",
    repoKeyOf: (p: string) => { const r = rootOf(p); return r ? REPOS[r]! : null; },
    rootOf: (p: string) => rootOf(p),
    trailHome: "/home/dev/.trail", transcriptPath: "/home/dev/.claude/projects/-home-dev-shop/s.jsonl", marks: [],
    now: new Date(Date.UTC(2026, 9, 1, 12, 0, 0)), ...extra,
  };
}

/** A transcript that grows between folds into one state, as the hooks see it. */
export function session(tag = "s", st: SkillSessionState = emptyState()) {
  const dir = mkdtempSync(join(tmpdir(), `trace-fold-${tag}-`));
  const path = join(dir, "s.jsonl");
  const cursor = join(dir, "cursor.json");
  writeFileSync(path, "");
  return {
    st,
    path,
    fold(entries: object[], extra: Partial<FoldContext> = {}): FoldResult {
      appendFileSync(path, jsonl(entries));
      const evs = readNewEvents(path, cursor, { firstReadBytes: Infinity });
      return foldEvents(st, evs, foldCtx({ transcriptPath: path, ...extra }));
    },
  };
}
