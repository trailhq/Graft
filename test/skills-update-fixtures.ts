/**
 * Moment 5 and 6 offers made the way c3's hooks will make them, for the
 * update gate's tests: release-npm kept from a first release, then a second
 * release its block drove where step 2 (the publish) failed and another
 * publish worked (an update); or the skill needs a fix and a release went
 * another way (drift's replace). Stop settles the use through 1a's credit,
 * then c3's offer is stood in for: the plan from `replan`, the offer's two
 * lines, `fold` pinned by proposalSha and baseHash. Built on
 * skills-consent-fixtures (the real gate, fold and session lock).
 * Synthetic data only (acme/shop, acme-cli). Not a test file itself.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { skillHash } from "../src/skills/skillmd.js";
import { said, toolResult, toolUse } from "./trace-fixtures.js";
import { SHOP, T, append, bash, box, ctxAt, iso, nextId, say, where, type Box } from "./skills-consent-fixtures.js";
import { currentRun, withSkillSession, type GateCtx } from "../src/trace/skill-session.js";
import { checkedSuccess, readRunSheet, runHelpers, writeRunSheet } from "../src/trace/runs.js";
import { compileRun } from "../src/skills/compile.js";
import { listAllPersonal, savePersonal } from "../src/skills/store.js";
import { settleCredit } from "../src/skills/credit.js";
import { driftOfferKey, newOfferId, recordShown, updateOfferKey } from "../src/skills/offers.js";
import { updateSkillState } from "../src/skills/state.js";
import { fillParams } from "../src/skills/params.js";
import { checkSkillsUpdate, cliUpdate, replan, type Replanned } from "../src/skills/update-gate.js";
import type { PendingOffer } from "../src/trace/types.js";
import type { CompiledSkill, SkillRef } from "../src/skills/types.js";

const made: Box[] = [];
export function cleanup(): void {
  for (const b of made.splice(0)) rmSync(b.root, { recursive: true, force: true });
}
export function mk(): Box {
  const b = box({ env: { TRAIL_TEST_NOW: T(900).toISOString() } });
  made.push(b);
  return b;
}

export const NAME = "release-npm";
const publish = (v: string) => `npm publish acme-cli-${v}.tgz --access public`;
export const OTHER = (v: string) => `npm publish ./dist/acme-cli-${v}.tgz --access public`;

/** Stop's judging: the open run closed, checked, its sheet written. */
function closeRun(b: Box, ctx: GateCtx): string {
  const r = withSkillSession(ctx, { catchUp: true }, (st, fold) => {
    const run = currentRun(st)!;
    const v = checkedSuccess(run, fold?.lastAssistant ?? null);
    run.end = v.end;
    if (v.checked) writeRunSheet(run, v, { host: ctx.host, tier: ctx.tier, sessionHash: ctx.sessionHash, helpers: runHelpers(run) }, b.env);
    run.closed = true;
    return run.id;
  });
  if (!r) throw new Error("closeRun: lock");
  return r;
}

/** Day one: a release that worked, kept as release-npm (v1). */
export function keptSkill(b: Box): { ref: SkillRef; skill: CompiledSkill } {
  say(b, 0, "publish 1.4.3");
  bash(b, 5, "npm ci", "added 212 packages in 3s");
  bash(b, 8, "npm run lint", "0 problems");
  bash(b, 10, "npm run build", "built in 2.1s");
  bash(b, 20, publish("1.4.3"), "+ acme-cli@1.4.3");
  bash(b, 30, "npm view acme-cli version", "1.4.3");
  append(b, [said("Published 1.4.3; npm shows it.", where(b, 40))]);
  const runId = closeRun(b, ctxAt(b, 45));
  const c = compileRun(readRunSheet(runId, b.env)!, {
    repoRoot: b.repo, home: b.env.HOME!, platform: process.platform, moment: "repeated", applies: SHOP, taken: () => false, name: NAME, id: "s-7f3a2c",
  });
  if (!c.ok) throw new Error(`compile: ${c.reason} ${c.detail}`);
  savePersonal(c.skill, { from: "repeated", runId, consent: "offer-yes", stepsVerified: c.skill.steps.length, env: b.env, now: T(46) });
  return { ref: listAllPersonal(b.env).find((r) => r.name === NAME)!, skill: c.skill };
}

/** The second release, driven by the skill's block: step 2's publish fails, another publish works, npm shows it. */
export function blockRun(b: Box, skill: CompiledSkill, sec: number, opts: { plain?: boolean; version?: string } = {}): void {
  const v = opts.version ?? "1.4.4";
  const params = { version: v };
  withSkillSession(ctxAt(b, sec - 1), { catchUp: true }, (st) => {
    st.injected.push({
      injId: "i-0b12aa", skillId: skill.meta.trail, name: NAME, epoch: st.epoch, at: iso(sec - 1), cue: "job", params,
      steps: skill.steps.map((s) => fillParams(s.cmd, params)), gated: [], check: skill.check ? fillParams(skill.check, params) : null, runId: null, live: true,
    });
  });
  say(b, sec, `publish ${v}`);
  bash(b, sec + 5, "npm ci", "added 212 packages in 3s");
  bash(b, sec + 8, "npm run lint", "0 problems");
  bash(b, sec + 10, "npm run build", "built in 2.0s");
  if (!opts.plain) bash(b, sec + 20, publish(v), "npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/acme-cli", true);
  bash(b, sec + 25, opts.plain ? publish(v) : OTHER(v), `+ acme-cli@${v}`);
  bash(b, sec + 30, "npm view acme-cli version", v);
  append(b, [said(`Published ${v}; npm shows it.`, where(b, sec + 40))]);
}

export interface Offered { offer: PendingOffer; plan: Replanned; runId: string }

/** Stop: settle the use, then c3's offer stood in for (moment 5, or 6 for `op: 'replace'`), shown on the stop channel. */
export function offerAtStop(b: Box, sec: number, op: "update" | "replace" = "update", lines?: [string, string]): Offered {
  const ctx = ctxAt(b, sec);
  const r = withSkillSession(ctx, { catchUp: true }, (st, fold) => {
    const run = currentRun(st)!;
    const v = checkedSuccess(run, fold?.lastAssistant ?? null);
    run.end = v.end;
    writeRunSheet(run, v, { host: ctx.host, tier: ctx.tier, sessionHash: ctx.sessionHash, helpers: runHelpers(run) }, b.env);
    run.closed = true;
    settleCredit(st, { host: "claude", env: b.env, now: ctx.now });
    const plan = replan("s-7f3a2c", run.id, op, b.env, { st });
    if (!plan) return null;
    const version = Number(plan.base.meta.version);
    const offer: PendingOffer = {
      offerId: newOfferId(), moment: op === "replace" ? "drift" : "update", runId: run.id, name: NAME,
      key: op === "replace" ? driftOfferKey("s-7f3a2c", version) : updateOfferKey("s-7f3a2c", version),
      lines: lines ?? (op === "replace"
        ? ["Published 1.4.4: npm shows it. release-npm needs a fix, and this release went another way.", `Replace ${NAME} with the ${plan.next.steps.length} steps that just worked, retire it, or leave it? (replace / retire / leave it)`]
        : [`Published 1.4.4: npm shows it. This time ${NAME} needed '${OTHER("1.4.4")}' for step 4.`, `Change step 4 of ${NAME} to the command that worked? 1 line changes. (yes / show me / no)`]),
      channel: "stop", shownAt: ctx.now.toISOString(), showMe: false, yes: null, typedAfter: [], repo: SHOP,
      fold: { op, skillId: "s-7f3a2c", baseHash: plan.baseHash, proposalSha: plan.proposalSha, handEdited: plan.handEdited, version },
      ...(op === "replace" ? { retire: { skillId: "s-7f3a2c", name: NAME } } : {}),
    };
    st.pendingOffer = offer;
    recordShown(offer, SHOP, b.env, ctx.now);
    st.offerUsed = true;
    st.offerUsedBy = "offer";
    return { offer, plan, runId: run.id };
  });
  if (!r) throw new Error("offerAtStop: no plan");
  return r;
}

/** The skill made needs-fix, as two failures at one step would (1a). */
export function needsFix(b: Box): void {
  // D65: the file's hash at the mark, so an edit made before it is not taken for a fix.
  const fixHash = skillHash(readFileSync(join(b.env.TRAIL_HOME!, "skills", NAME, "SKILL.md"), "utf8"));
  updateSkillState("s-7f3a2c", (s) => (s ? { ...s, status: "needs-fix", prevStatus: "active", statusWhy: "step 4 failed on Oct 25 and Oct 26", fixHash } : s), b.env);
}

/** The agent's reply ending with the offer's 2 lines (or `after` past them). */
export function sayLines(b: Box, sec: number, o: PendingOffer, extra: { after?: string } = {}): void {
  append(b, [said(`Done.\n\n${o.lines![0]}\n${o.lines![1]}${extra.after ?? ""}`, where(b, sec))]);
}

export const updateCmd = (o: PendingOffer, name = o.name) => `trail skills update ${name} --offer ${o.offerId}`;

export interface UpdateRun { id: string; decision: ReturnType<typeof checkSkillsUpdate>; cli: ReturnType<typeof cliUpdate> | null }
/** The agent runs an update: its tool_use line, PreToolUse's gate (under the session lock), then (when let through) the CLI half. */
export function runUpdate(b: Box, sec: number, command: string, opts: { ctx?: GateCtx; skipHook?: boolean; name?: string; offerId?: string; cliAt?: number } = {}): UpdateRun {
  const id = nextId(b);
  append(b, [toolUse(id, "Bash", { command, description: "change the skill" }, where(b, sec))]);
  const ctx = opts.ctx ?? ctxAt(b, sec);
  const input = { ...b.payload, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id };
  const decision = opts.skipHook ? null : withSkillSession(ctx, { catchUp: true }, (st, fold) => checkSkillsUpdate(input, ctx, st, fold)) ?? null;
  const m = /update\s+(\S+)\s+--offer\s+(\S+)/.exec(command);
  let cli: ReturnType<typeof cliUpdate> | null = null;
  if (!decision && m) cli = cliUpdate(opts.name ?? m[1]!, opts.offerId ?? m[2]!, b.env, T(opts.cliAt ?? sec + 1));
  append(b, [toolResult(id, cli ? cli.lines.join("\n") : "", decision !== null, where(b, sec + 2))]);
  return { id, decision, cli };
}
