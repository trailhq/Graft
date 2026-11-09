/**
 * Builders for the phase 2 moment tests (c3): a sandbox Trail home with a
 * kept release skill compiled from a synthetic run, its run sheets on disk,
 * and a thin stand-in for c2's `foldInputFor` and `replan` (update-gate.ts),
 * built from c1's pure functions the way c2's note says they are, until c2
 * lands. Made-up acme/shop, acme-cli and values only. Not a test file itself.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckHit, RunCall, RunSheet, RunState, SkillInjection, SkillSessionState } from "../src/trace/types.js";
import type { CompiledSkill, LedgerUse } from "../src/skills/types.js";
import type { FoldPlanner } from "../src/skills/offer-update.js";
import type { OfferInput } from "../src/skills/offer-moment.js";
import { compileRun } from "../src/skills/compile.js";
import { parseSkillMd, renderSkillMd, skillHash } from "../src/skills/skillmd.js";
import { savePersonal, listAllPersonal } from "../src/skills/store.js";
import { getSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { readLessons } from "../src/skills/lessons.js";
import { fidelityOf } from "../src/skills/fidelity.js";
import { applyFold, planFold, replaceWith, type FoldInput } from "../src/skills/fold.js";
import { rebuildCompiled, rebuildLoose } from "../src/skills/skill-rebuild.js";
import { fidelityWhere } from "../src/skills/credit-facts.js";
import { runSheetPath, readRunSheet } from "../src/trace/run-sheets.js";
import { callKind } from "../src/trace/checks.js";
import { fillParams } from "../src/skills/params.js";
import { box, SHOP } from "./skills-store-fixtures.js";
import { emptyState, runState } from "./trace-run-fixtures.js";

export { SHOP };
export const NOW = new Date("2026-11-12T11:00:00.000Z");
export const PUSH = "git push origin HEAD:main";

let seq = 0;
/** A Bash call as the fold stores it, in acme/shop. */
export function call(raw: string, o: Partial<RunCall> = {}): RunCall {
  seq++;
  const at = new Date(Date.UTC(2026, 10, 12, 10, 0, 0) + seq * 20_000).toISOString();
  return { id: `toolu_m${String(seq).padStart(4, "0")}`, at, cmd: raw, key: SHOP, cwd: "", bg: false, failed: false, isError: false,
    kind: callKind(raw, "release"), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...o };
}
export const failed = (raw: string) => call(raw, { failed: true, isError: true, errorLine: "error: something went wrong" });
export const npmView = (v: string): RunCall => call("npm view acme-cli version", { tail: v, check: { family: "npm-view", passed: true, facts: { version: v, pkg: "acme-cli" } } as CheckHit });

/** One release run: 4 steps, then the check. `extraAfter[n]` calls go after step n; `replace[n]` stand in for step n. */
export function releaseCalls(v: string, o: { skip?: number[]; extraAfter?: Record<number, RunCall[]>; replace?: Record<number, RunCall[]> } = {}): RunCall[] {
  const steps = ["npm run build", `npm version ${v} --no-git-tag-version`, PUSH, "npm publish --access public"];
  const out: RunCall[] = [];
  steps.forEach((s, k) => {
    const n = k + 1;
    if (o.replace?.[n]) out.push(...o.replace[n]!);
    else if (!o.skip?.includes(n)) out.push(call(s));
    out.push(...(o.extraAfter?.[n] ?? []));
  });
  out.push(npmView(v));
  return out;
}

export function sheetOf(id: string, calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id, session: "e76b4ca7f1a0", repoKey: SHOP, branch: "main", host: "claude", tier: "A", epoch: 0,
    startedAt: calls[0]?.at ?? NOW.toISOString(), endedAt: calls.at(-1)?.at ?? NOW.toISOString(), job: "release", jobWords: ["release"], sharedWords: [],
    promptParams: {}, calls, checkIndex: calls.length - 1, checked: true, end: "done",
    counts: { commands: calls.length, failed: calls.filter((c) => c.failed).length, toolCalls: calls.length, edits: 0 }, helpers: [], skillId: null, ...o,
  };
}

export interface Lab { env: NodeJS.ProcessEnv; home: string; checkout: string; base: CompiledSkill; id: string; dir: string; file: string }

/** A sandbox home, a known acme/shop checkout, and release-npm kept from a run of 0.22.3 (a candidate, as saved). */
export function lab(tag: string, homes: string[]): Lab {
  const b = box(`m2-${tag}`);
  homes.push(b.home);
  mkdirSync(b.trail, { recursive: true });
  mkdirSync(join(b.checkout, ".trail"), { recursive: true });
  writeFileSync(join(b.trail, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: "2026-08-01T00:00:00.000Z" }));
  const calls = releaseCalls("0.22.3");
  const r = compileRun(sheetOf("r-1110-0001", calls, { promptParams: { version: "0.22.3" } }), {
    repoRoot: b.checkout, home: b.home, platform: "darwin", moment: "repeated", applies: SHOP, taken: () => false, name: "release-npm", id: "s-7f3a2c",
  });
  if (!r.ok) throw new Error(`compile refused ${r.reason}`);
  const ref = savePersonal(r.skill, { from: "repeated", runId: "r-1110-0001", consent: "offer-yes", stepsVerified: 4, env: b.env, now: new Date("2026-11-10T11:00:00.000Z") });
  return { env: b.env, home: b.home, checkout: b.checkout, base: r.skill, id: r.skill.meta.trail, dir: ref.dir, file: ref.file };
}

export function writeSheet(env: NodeJS.ProcessEnv, s: RunSheet): RunSheet {
  const p = runSheetPath(s.id, env);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(s));
  return s;
}

/** The block's injection for the kept skill, filled with `v`. */
export function injFor(l: Lab, v: string, runId: string, extra: Partial<SkillInjection> = {}): SkillInjection {
  return {
    injId: "i-0a1b2c", skillId: l.id, name: "release-npm", epoch: 0, at: "2026-11-12T09:59:00.000Z", cue: "job", params: { version: v },
    steps: l.base.steps.map((s) => fillParams(s.cmd, { version: v })), gated: [], check: fillParams(l.base.check, { version: v }), runId, live: false, ...extra,
  };
}

export function runOf(sheet: RunSheet, extra: Partial<RunState> = {}): RunState {
  return runState({ id: sheet.id, repoKey: SHOP, job: "release", calls: sheet.calls, closed: true, end: "done", checkIndex: sheet.checkIndex,
    startedAt: sheet.startedAt, lastAt: sheet.endedAt, stepCalls: sheet.calls.length, ...extra });
}

/** OfferInput for a Stop at NOW, with the planner stand-in. */
export function input(l: Lab, run: RunState, sheet: RunSheet | null, st: SkillSessionState, extra: Partial<OfferInput> = {}): OfferInput {
  return {
    run, verdict: { checked: true, checkIndex: run.checkIndex, end: "done" }, sheet, st,
    ctx: { learn: true, checkout: l.checkout, repoKey: SHOP, env: l.env, now: NOW, transcriptPath: null }, channel: "stop", plan: standIn, ...extra,
  };
}

export const state = (extra: Partial<SkillSessionState> = {}) => emptyState({ updatedAt: NOW.toISOString(), ...extra });
export const uses = (l: Lab) => readLedger(l.id, l.env).filter((x): x is LedgerUse => x.event === "use");

/* ---- the stand-in for c2's foldInputFor and replan (update-gate.ts), as c2's message describes them ---- */

function foldInputFor(skillId: string, runId: string, env: NodeJS.ProcessEnv, o: { inj?: Pick<SkillInjection, "params" | "steps" | "at" | "check">; now?: Date } = {}): FoldInput | null {
  const sheet = readRunSheet(runId, env);
  const ref = listAllPersonal(env).find((r) => r.id === skillId);
  if (!sheet || !ref) return null;
  const text = readFileSync(ref.file, "utf8");
  const skill = parseSkillMd(text, ref.name);
  const st = getSkillState(skillId, env);
  if (!skill || !st) return null;
  const c = compileRun(sheet, { repoRoot: "", home: env.HOME!, platform: "darwin", prior: null, name: ref.name, moment: "repeated", applies: skill.meta.applies ?? sheet.repoKey, taken: () => false, id: skill.meta.trail, readSheet: (id) => readRunSheet(id, env) });
  const earlier = readLedger(skillId, env).filter((x): x is LedgerUse => x.event === "use" && Date.parse(x.at) < Date.parse(sheet.startedAt)).slice(-4);
  const handEdited = skillHash(text) !== st.hash;
  const inj = o.inj ?? { params: {}, steps: [], at: sheet.startedAt, check: null };
  return {
    skill, text, fresh: c.ok ? c.skill : null, fid: fidelityOf(skill, inj, sheet.calls, fidelityWhere(sheet, env)), inj,
    earlierExtraShas: earlier.map((u) => u.extraShas ?? []), earlierRan: earlier.map((u) => u.stepsRan), earlierChecks: earlier.map((u) => u.check),
    lessons: readLessons(ref.dir), base: handEdited ? rebuildLoose(text, skill) : rebuildCompiled(text, skill, { source: st.source, helpers: [], runId: st.runId }),
  };
}

function replan(skillId: string, runId: string, op: "update" | "extend" | "split" | "replace", env: NodeJS.ProcessEnv, o: { inj?: Pick<SkillInjection, "params" | "steps" | "at" | "check">; now?: Date } = {}) {
  const fi = foldInputFor(skillId, runId, env, o);
  if (!fi || !fi.base || op === "split") return null;
  let next: CompiledSkill | null;
  let plan = null as ReturnType<typeof planFold> | null;
  if (op === "replace") next = fi.fresh ? replaceWith(fi.base, fi.fresh) : null;
  else {
    plan = planFold(fi);
    next = plan.op === op && (plan.op === "update" || plan.op === "extend") ? applyFold(fi.base, plan) : null;
  }
  if (!next) return null;
  const text = renderSkillMd(next);
  return { next, text, proposalSha: createHash("sha256").update(text).digest("hex").slice(0, 16), baseHash: skillHash(fi.text), handEdited: skillHash(fi.text) !== getSkillState(skillId, env)!.hash, plan, base: fi.base, fresh: fi.fresh };
}

export const standIn: FoldPlanner = { foldInputFor, replan };

export function cleanup(homes: string[]): void {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
}
