/**
 * b5 review: replay parity (design 4.2) on inputs the build's parity test
 * left out. The live Stop hook does not run when the person interrupts a
 * turn, and it judges a run before the agent says Trail's offer lines; the
 * replay must reach the same run verdicts. Synthetic sessions through the
 * real hooks, then the same transcript replayed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { replaySession } from "../src/init/replay-runs.js";
import {
  agentRuns, at, box, done, finish, grow, reply, promptHook, release, sayOfferLines, session, stateOf, testsJob, type Box, type Session,
} from "./claude-skills-journey-fixtures.js";
import { interrupted, toolResult, toolUse } from "./trace-fixtures.js";
import type { RunSheet } from "../src/trace/types.js";

process.env.TZ = "UTC";

const SHOP = "github.com/acme/shop";
const shape = (job: unknown, checked: boolean, end: string, cmds: Array<string | null>) => JSON.stringify([job, checked, end, cmds]);

function liveSheets(b: Box, s: Session): string[] {
  const dir = join(b.trail, "runs");
  return readdirSync(dir).filter((f) => f.startsWith("r-")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RunSheet)
    .filter((x) => x.session === stateOf(s).sessionHash)
    .sort((a, c) => a.startedAt.localeCompare(c.startedAt))
    .map((x) => shape(x.job, x.checked, x.end, x.calls.map((c) => c.cmd)));
}

function replayed(b: Box, s: Session): string[] {
  const r = replaySession(s.tx, { from: 0, to: statSync(s.tx).size }, SHOP, new Date(at(28)), { env: { HOME: b.home, TRAIL_HOME: b.trail }, keepCalls: true });
  return r.runs.filter((x) => x.sheet !== "none").sort((a, c) => a.startedAt.localeCompare(c.startedAt))
    .map((x) => shape(x.job, x.sheet === "checked", x.end, x.calls.map((c) => c.cmd)));
}

test("parity: a turn the person interrupted gets no Stop, so its run is not judged done", async () => {
  const b = box("par-int");
  try {
    const s = session(b);
    // The release checks out, the agent says so and goes on; the person presses Esc: Claude Code runs no Stop hook.
    await release(s, 10, "1.5.0");
    reply(s, at(10, 40), "Version 1.5.0 is on npm. Now I'll update the changelog.");
    grow(s, [
      { ...interrupted(), sessionId: s.sid, cwd: "/home/dev/shop", timestamp: at(10, 50) },
    ]);
    await testsJob(s, 10, { sec: 100 });
    await finish(s, 10, "All 12 tests pass.", 140);
    const live = liveSheets(b, s);
    assert.equal(live.length, 2);
    assert.deepEqual(replayed(b, s), live);
  } finally {
    done(b);
  }
});

test("parity: Trail's own offer lines at the end of a reply don't turn a checked run into a question", async () => {
  const b = box("par-offer");
  try {
    for (const [day, v] of [[20, "1.6.1"], [21, "1.6.2"]] as const) {
      const s = session(b);
      await release(s, day, v, { failedFirst: true });
      await finish(s, day, `Published ${v}.`);
    }
    const s = session(b);
    // A costly 3rd day: line 1 of the offer says what failed on the way.
    await release(s, 22, "1.6.3", { failedFirst: true });
    const blocked = await finish(s, 22, "Published 1.6.3.");
    assert.equal(blocked?.decision, "block", JSON.stringify(blocked));
    await sayOfferLines(s, 22, stateOf(s).pendingOffer!.lines);
    const live = liveSheets(b, s);
    assert.equal(live.length, 1);
    assert.equal(JSON.parse(live[0]!)[1], true, "live: a checked release");
    assert.deepEqual(replayed(b, s), live);
  } finally {
    done(b);
  }
});

test("parity: a reply that is only the offer reads as the run's own end, as live", async () => {
  const b = box("par-offer2");
  try {
    for (const [day, v] of [[23, "1.7.1"], [24, "1.7.2"]] as const) {
      const s = session(b);
      await release(s, day, v, { failedFirst: true });
      await finish(s, day, `Published ${v}.`);
    }
    const s = session(b);
    await release(s, 25, "1.7.3", { failedFirst: true });
    const blocked = await finish(s, 25, "Published 1.7.3.");
    assert.equal(blocked?.decision, "block");
    const lines = stateOf(s).pendingOffer!.lines;
    // The continued turn says only the 2 lines; then the person answers "no" and asks for the tests.
    await sayOfferLines(s, 25, lines, 45, "");
    await promptHook(s, at(25, 60), "no");
    await testsJob(s, 25, { sec: 70 });
    await finish(s, 25, "All 12 tests pass.", 110);
    assert.deepEqual(replayed(b, s), liveSheets(b, s));
  } finally {
    done(b);
  }
});

test("parity: a ship run with a cd chain, a background call, a push and a Vercel deploy check over MCP", async () => {
  const b = box("par-ship");
  try {
    const s = session(b);
    const where = (iso: string) => ({ sessionId: s.sid, cwd: "/home/dev/shop", timestamp: iso });
    const SHA = "5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e";
    const deployment = (state: string) => JSON.stringify({ result: { deployment: { id: "dpl_x1", state, readyState: state, target: "production", createdAt: 1790000000000,
      meta: { githubCommitRef: "prod", githubCommitSha: SHA } } } });
    for (const [day, first] of [[11, "BUILDING"], [12, "READY"]] as const) {
      await promptHook(s, at(day, 0), "deploy it to prod");
      await agentRuns(s, at(day, 5), "cd /home/dev/shop && npm run build", () => ({ out: "built in 2.1s" }));
      await agentRuns(s, at(day, 8), "npm run preview &", () => ({ out: "Command running in background with ID: b7x2" }));
      await agentRuns(s, at(day, 10), "git push origin prod", () => ({ out: "To github.com:acme/shop.git\n   1a2b3c4..5d6e7f8  prod -> prod" }));
      grow(s, [toolUse(`toolu_mcp${day}a`, "mcp__claude_ai_Vercel__get_deployment", { idOrUrl: "dpl_x1" }, where(at(day, 20))),
        toolResult(`toolu_mcp${day}a`, deployment(first), false, where(at(day, 21)))]);
      if (first === "BUILDING") {
        grow(s, [toolUse(`toolu_mcp${day}b`, "mcp__claude_ai_Vercel__get_deployment", { idOrUrl: "dpl_x1" }, where(at(day, 30))),
          toolResult(`toolu_mcp${day}b`, deployment("READY"), false, where(at(day, 31)))]);
      }
      await finish(s, day, "Deployed: prod is READY.");
    }
    const live = liveSheets(b, s);
    assert.equal(live.length, 2);
    assert.deepEqual(live.map((x) => JSON.parse(x).slice(0, 2)), [["ship", true], ["ship", true]], live.join("\n"));
    assert.deepEqual(replayed(b, s), live);
  } finally {
    done(b);
  }
});
