/**
 * Builders for the phase 2 fold tests (c1): a Bash call as the fold stores
 * it, a run sheet, an injection, and the skills the 1a and 1b tests render,
 * in every layout the renderer writes. Made-up repos and values only
 * (acme/cli, acme/shop, /home/dev). Not a test file itself.
 */
import type { CheckHit, JobClass, RunCall, RunSheet, SkillInjection } from "../src/trace/types.js";
import type { CompiledSkill } from "../src/skills/types.js";
import { callKind } from "../src/trace/checks.js";
import { redactSecrets } from "../src/trace/redact.js";
import { isMultiLine } from "../src/trace/shell.js";
import { fillParams } from "../src/skills/params.js";
import { releaseSkill, shipSkill } from "./skills-recall-fixtures.js";
import { compiled } from "./skills-store-fixtures.js";

export const HOME = "/home/dev";
export const ROOT = "/home/dev/src/cli";
export const KEY = "github.com/acme/cli";

let seq = 0;
/** A Bash call as the fold would store it (4.1): redacted, kind from the command. */
export function call(raw: string, o: Partial<RunCall> & { job?: JobClass | null } = {}): RunCall {
  seq++;
  const { job = "release", ...rest } = o;
  const red = redactSecrets(raw);
  const at = new Date(Date.UTC(2026, 9, 27, 10, 31, 40) + seq * 20_000).toISOString();
  return {
    id: `toolu_${String(seq).padStart(4, "0")}`, at, cmd: red.cmd, ...(red.secret ? { secret: red.secret } : {}),
    key: KEY, cwd: "", bg: false, failed: false, isError: false,
    ...(isMultiLine(raw) ? { multiLine: true } : {}),
    kind: callKind(raw, job), src: { use: seq * 1000, result: seq * 1000 + 400 },
    ...rest,
  };
}
export const failed = (raw: string, o: Partial<RunCall> = {}) => call(raw, { failed: true, isError: true, errorLine: "error: something went wrong", ...o });
export const passed = (family: CheckHit["family"], facts: CheckHit["facts"] = {}): CheckHit => ({ family, passed: true, facts });

export function sheet(calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id: "r-1027-3f9a", session: "e76b4ca7f1a0", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 1,
    startedAt: "2026-10-27T10:31:40Z", endedAt: "2026-10-27T10:44:05Z", job: "release", jobWords: [], sharedWords: [], promptParams: {},
    calls, checkIndex: null, checked: false, end: "done",
    counts: { commands: calls.length, failed: calls.filter((c) => c.failed).length, toolCalls: calls.length + 2, edits: 0 },
    helpers: [], skillId: null, ...o,
  };
}

/** The injection a run block made for a skill: its steps filled with this run's values. */
export function injectionFor(c: Pick<CompiledSkill, "steps" | "check">, params: Record<string, string>, extra: Partial<SkillInjection> = {}): SkillInjection {
  return {
    injId: "i-0a1b2c", skillId: "s-7f3a2c", name: "release-npm", epoch: 1, at: "2026-10-27T10:00:00.000Z", cue: "job", params,
    steps: c.steps.map((s) => fillParams(s.cmd, params)), gated: [], check: c.check ? fillParams(c.check, params) : null,
    runId: "r-1027-3f9a", live: true, ...extra,
  };
}

/** Every skill shape the 1a and 1b tests render (design 2.1 and its variants). */
export function renderedFixtures(): Array<{ label: string; skill: CompiledSkill }> {
  const ship = shipSkill();
  return [
    { label: "release (recall fixtures)", skill: releaseSkill() },
    { label: "ship with a wait (recall fixtures)", skill: ship },
    { label: "release (store fixtures)", skill: compiled() },
    { label: "a check that is the last step", skill: compiled("go-tests", { job: "tests", check: "go test ./...", "check-shows": "ok" }, {
      steps: [{ n: 1, cmd: "go vet ./...", gated: null, bg: false, wait: false }, { n: 2, cmd: "go test ./...", gated: null, bg: false, wait: false }],
      check: "go test ./...", checkShows: "ok", checkIsStep: true }) },
    { label: "a check that is a step, not found among the steps", skill: compiled("ship-prod", { check: "git push origin main", "check-shows": undefined }, {
      steps: [{ n: 1, cmd: "npm run build", gated: null, bg: false, wait: false }], check: "git push origin main", checkShows: null, checkIsStep: true }) },
    { label: "no check", skill: compiled("run-locally", { job: "run-local", check: undefined, "check-shows": undefined }, { check: "", checkShows: null }) },
    { label: "a check with no output to show", skill: compiled("build-only", { "check-shows": undefined }, { checkShows: null }) },
    { label: "a check that shows a phrase", skill: compiled("deploy-site", { "check-shows": "all checks passed" }, { checkShows: "all checks passed" }) },
    { label: "a deploy status tool check", skill: shipSkill({ "check-tool": "get_deployment", check: "read the deployment for {sha} with get_deployment", "check-shows": "READY" }, {
      check: "read the deployment for {sha} with get_deployment", checkShows: "READY" }) },
    { label: "before you start", skill: compiled("publish-npm", { "before-you-start": "the person is logged in to npm; they run npm login themselves" }) },
    { label: "a background step and a backticked step", skill: compiled("serve-docs", {}, {
      steps: [{ n: 1, cmd: "npm run dev &", gated: null, bg: true, wait: false }, { n: 2, cmd: "printf '`%s`' x", gated: null, bg: false, wait: false }] }) },
    { label: "if it fails lines", skill: releaseSkill({}, { ifFails: ["`npm publish` said \"npm error code EOTP\": what worked was step 5.", "Stop and tell the person."] }) },
    { label: "an extra meta key", skill: compiled("release-extra", { custom: "kept" } as never) },
    { label: "three dashes in a command", skill: compiled("dash-run", { check: "node x.js ---flag" }, { check: "node x.js ---flag", steps: [{ n: 1, cmd: "node x.js ---flag", gated: null, bg: false, wait: false }] }) },
  ];
}
