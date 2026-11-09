/**
 * Lesson offers made the way the hooks make them, for the lesson gate's
 * tests: moment 3 kept as a lesson (the Docker wall fixed with Colima's
 * socket again) and moment 4 (a correction after release-npm was used).
 * Built on skills-consent-fixtures (real gate, fold and session lock).
 * Synthetic data only. Not a test file itself.
 */
import { rmSync } from "node:fs";
import { said, toolResult, toolUse } from "./trace-fixtures.js";
import { SHOP, T, add as _add, append, bash, box, callLine, ctxAt, nextId, resultLine, saidLines, say, state, stop, where, type Box } from "./skills-consent-fixtures.js";
import { compiled } from "./skills-store-fixtures.js";
import { noteWalls } from "../src/trace/wall-state.js";
import { savePersonal } from "../src/skills/store.js";
import { appendLedger } from "../src/skills/ledger.js";
import { creditWindow } from "../src/skills/credit.js";
import { withSkillSession, currentRun, type GateCtx } from "../src/trace/skill-session.js";
import { typedSha } from "../src/trace/typed.js";
import { stopSkillsRun } from "../src/claude/stop-skills.js";
import { offerLinesOf } from "../src/skills/offer-lesson.js";
import { keepLessonCli, lessonGatePre } from "../src/skills/lesson-gate.js";
import type { PendingOffer } from "../src/trace/types.js";

void _add;
export const CORRECTION = "no, it didn't push the tag";
const made: Box[] = [];
export function cleanup(): void {
  for (const b of made.splice(0)) rmSync(b.root, { recursive: true, force: true });
}
function mk(host: "claude" | "codex" = "claude"): Box {
  const b = box({ env: { TRAIL_TEST_NOW: T(200).toISOString() }, host, tierA: host === "codex" });
  made.push(b);
  return b;
}

/** Moment 3 as a lesson: an earlier epoch's repair in walls.json, then go hits the Docker wall and passes with Colima's socket. */
export function repairedOffer(host: "claude" | "codex" = "claude"): { b: Box; o: PendingOffer } {
  const b = mk(host);
  noteWalls({ fixed: [{ cls: "docker-rootless", d: "2026-10-24", sh: "aaaaaaaaaaaa", epoch: 0, repo: SHOP, program: "go", delta: [{ kind: "env", name: "DOCKER_HOST" }] }] }, b.env);
  say(b, 0, "run the integration tests");
  bash(b, 5, "go test ./...", "Error: rootless Docker not found\nFAIL\tacme/shop\t0.1s", true);
  bash(b, 20, `DOCKER_HOST=unix://${b.root}/.colima/default/docker.sock go test ./...`, "ok  \tacme/shop\t0.4s");
  append(b, saidLines(b, "The integration tests pass.", 30));
  const s = stop(b, 50);
  if (!s.offer || s.offer.repair?.as !== "lesson") throw new Error(`no lesson offer: ${s.why}`);
  return { b, o: s.offer };
}

/** Moment 4: release-npm used and flushed, the person's correction, the agent pushes the tags, Stop offers the lesson. */
export function correctionOffer(): { b: Box; o: PendingOffer } {
  const b = mk();
  savePersonal(compiled("release-npm", { trail: "s-7f3a2c" }), { from: "repeated", runId: "r-0930-0001", consent: "offer-yes", stepsVerified: 2, env: b.env, now: T(0) });
  say(b, 0, "publish 1.4.3");
  bash(b, 5, "npm run build", "built");
  append(b, [said("Built.", where(b, 20))]);
  withSkillSession(ctxAt(b, 30), { catchUp: true }, (st) => {
    const run = currentRun(st)!;
    run.closed = true;
    st.injected.push({ injId: "i-0b12aa", skillId: "s-7f3a2c", name: "release-npm", epoch: 0, at: T(1).toISOString(), cue: "job", params: { version: "1.4.3" }, steps: [], gated: [], check: null, runId: run.id, live: false });
    st.credit.push({ useId: "u-1", injId: "i-0b12aa", skillId: "s-7f3a2c", epoch: 0, runId: run.id, stepsRan: [1], failedStep: null, check: "passed", calls: 1, failed: 0, flushed: true, promptsAfter: 0 });
  });
  appendLedger("s-7f3a2c", { at: T(25).toISOString(), event: "use", useId: "u-1", skill: "s-7f3a2c", v: "1", host: "claude", cue: "job", repo: SHOP, stepsRan: [1], failedStep: null, readyFailed: [], check: "passed", calls: 1, failed: 0 }, b.env);
  withSkillSession(ctxAt(b, 40), { catchUp: false }, (st) => { creditWindow(st, { sha: typedSha(CORRECTION) }, { env: b.env, now: T(40) }); });
  say(b, 40, CORRECTION);
  bash(b, 60, "git push origin --tags", "To github.com:acme/shop.git\n * [new tag]         v1.4.3 -> v1.4.3");
  append(b, [said("Pushed the tag.", where(b, 70))]);
  const r = stopSkillsRun({ ...b.payload, hook_event_name: "Stop", stop_hook_active: false }, "/home/dev/shop", b.env);
  const o = state(b).pendingOffer;
  if (!r.out.block || !o || o.moment !== "correction") throw new Error(`no correction offer: ${JSON.stringify(r)}`);
  return { b, o };
}

/** The agent's reply ending with the offer's 2 lines (rebuilt for a correction), or with `after` past them. */
export function sayLines(b: Box, sec: number, o: PendingOffer, extra: { after?: string } = {}): [string, string] {
  const lines = offerLinesOf(o, b.tx, b.env)!;
  append(b, saidLines(b, `Done.\n\n${lines[0]}\n${lines[1]}${extra.after ?? ""}`, sec));
  return lines;
}

export const lessonCmd = (o: PendingOffer, skill: string | null = o.moment === "correction" ? o.name : null) =>
  `trail skills lesson ${skill ? `${skill} ` : ""}--offer ${o.offerId}`;

export interface KeepResult { id: string; decision: Awaited<ReturnType<typeof lessonGatePre>>; cli: ReturnType<typeof keepLessonCli> | null }
/** The agent runs a lesson command: its tool_use line, PreToolUse's lesson gate, then (when let through) the CLI half, then the result. */
export async function keep(b: Box, sec: number, command: string, opts: { ctx?: GateCtx; skipHook?: boolean; skill?: string | null; offerId?: string } = {}): Promise<KeepResult> {
  const id = nextId(b);
  append(b, [callLine(b, id, command, sec, "keep the lesson")]);
  const ctx = opts.ctx ?? ctxAt(b, sec);
  const input = { ...b.payload, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id };
  const decision = opts.skipHook ? null : await lessonGatePre(input, ctx);
  const m = /lesson\s+(?:(\S+)\s+)?--offer\s+(\S+)/.exec(command);
  const skill = opts.skill !== undefined ? opts.skill : m?.[1] && !m[1].startsWith("-") ? m[1] : null;
  const offerId = opts.offerId ?? m?.[2];
  let cli: ReturnType<typeof keepLessonCli> | null = null;
  if (!decision && offerId) cli = keepLessonCli(skill, offerId, b.env, T(sec + 1));
  append(b, [resultLine(b, id, cli ? cli.line : "", decision !== null, sec + 2)]);
  return { id, decision, cli };
}
