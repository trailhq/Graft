/**
 * D135 (3): jobs that met moment 2's bar but whose runs didn't compile go into the init record as job, session-day
 * count and refusal codes (no text), and `trail init --verbose` prints them. Without --verbose nothing is said.
 * Synthetic sessions only (b5's acme/shop world); an agent run, so no model is started.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginLookBack, finishLookBack } from "../src/init/run.js";
import { readInitRecord, recordFrom } from "../src/init/init-record.js";
import { repoPlace } from "../src/notes/home.js";
import type { PsRow } from "../src/skills/person.js";
import { day, done, Tx, world } from "./init-mine-fixtures.js";

const ME = 4243;
const table = (): PsRow[] => [
  { pid: 1, ppid: 0, comm: "/sbin/launchd", args: "/sbin/launchd" },
  { pid: 10, ppid: 1, comm: "/bin/zsh", args: "-zsh" },
  { pid: ME, ppid: 10, comm: "node", args: "node trail init" },
];
const deps = { stdinTTY: false, stdoutTTY: false, ps: table, pid: ME };

/** Three release days, two costly: the publish ran from a shell heredoc on days 1 and 3, and alone on day 5. */
function history(home: string, repo: string): void {
  const tx = new Tx(repo);
  for (const d of [1, 3]) {
    tx.typed(day(d), `publish 1.0.${d}`);
    tx.bash(day(d, 10, 10), "npm run build", "built in 2.1s");
    tx.bash(day(d, 10, 15), `npm publish acme-cli-1.0.${d}.tgz`, "Exit code 1\nnpm error code E403\nnpm error 403 Forbidden", { isError: true });
    tx.bash(day(d, 10, 20), `sh <<'EOF'\nnpm publish acme-cli-1.0.${d}.tgz --access public\nEOF`, `+ acme-cli@1.0.${d}`);
    tx.bash(day(d, 10, 30), "npm view acme-cli version", `1.0.${d}`);
    tx.said(day(d, 10, 40), `Published 1.0.${d}.`);
  }
  tx.typed(day(5), "publish 1.0.5");
  tx.bash(day(5, 10, 20), "npm publish acme-cli-1.0.5.tgz --access public", "+ acme-cli@1.0.5");
  tx.bash(day(5, 10, 30), "npm view acme-cli version", "1.0.5");
  tx.said(day(5, 10, 40), "Published 1.0.5.");
  tx.write(home, "s-uncompiled");
}

function texts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(readFileSync(join(d, e.name), "utf8")));
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

async function run(verbose: boolean) {
  const w = world(`uncompiled-${verbose ? "v" : "q"}`);
  const bin = mkdtempSync(join(tmpdir(), "trail-uncompiled-bin-"));
  const saved = { trail: process.env.TRAIL_HOME, dnt: process.env.DO_NOT_TRACK };
  process.env.TRAIL_HOME = w.trail;
  process.env.DO_NOT_TRACK = "1";
  try {
    history(w.home, w.repo);
    const env = { HOME: w.home, TRAIL_HOME: w.trail, PATH: bin, TRAIL_NO_FETCH: "1", DO_NOT_TRACK: "1", CLAUDECODE: "1" };
    writeFileSync(join(w.trail, "settings.json"), JSON.stringify({ v: 1, skills: "on" }));
    const said: string[] = [];
    const { reads } = beginLookBack(w.repo, { env, deps });
    await finishLookBack(w.repo, reads, { yes: false, say: (l) => said.push(l), verbose });
    const rec = readInitRecord(repoPlace(w.repo, env).key, env);
    return { said, rec, disk: texts(w.trail) };
  } finally {
    for (const [k, v] of [["TRAIL_HOME", saved.trail], ["DO_NOT_TRACK", saved.dnt]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    done(w);
    rmSync(bin, { recursive: true, force: true });
  }
}

test("the record keeps each uncompiled job as job, days and codes; --verbose prints it; no text on disk", async () => {
  const v = await run(true);
  assert.deepEqual(v.rec.runs[0]!.reads.uncompiled, [{ job: "release", days: 3, why: ["one-step", "multi-line"] }]);
  assert.ok(v.said.includes("· not offered as a skill: release, on 3 days (one-step, multi-line)"), v.said.join("\n"));
  for (const t of v.disk) for (const words of ["npm publish", "heredoc", "acme-cli"]) assert.ok(!t.includes(words), `no "${words}" on disk`);
  const q = await run(false);
  assert.deepEqual(q.rec.runs[0]!.reads.uncompiled, [{ job: "release", days: 3, why: ["one-step", "multi-line"] }]);
  assert.ok(!q.said.some((l) => l.includes("not offered as a skill")), "said only with --verbose");
});

test("an edited record: an unknown job, a code with text in it, a bad count are dropped on read", () => {
  const run = {
    id: "ir-0123456789ab", at: "2026-09-20T10:00:00.000Z", by: "agent", screen: "relay",
    reads: { sessions: 1, days: 1, from: null, to: null, parent: 0, read: [], skipped: [], uncompiled: [
      { job: "release", days: 3, why: ["one-step"] }, { job: "rm -rf", days: 3, why: ["x"] },
      { job: "ship", days: 3, why: ["one-step", "npm publish acme"] }, { job: "tests", days: -1, why: ["secret"] },
    ] },
    model: "none", modelWhy: "agent", calls: 0, tokens: 0, ms: 0, shown: [], kept: [], closed: [], deferred: [],
  };
  const rec = recordFrom({ v: 2, repo: "github.com/acme/shop", runs: [run] }, "github.com/acme/shop");
  assert.deepEqual(rec.runs[0]?.reads.uncompiled, [{ job: "release", days: 3, why: ["one-step"] }, { job: "ship", days: 3, why: ["one-step"] }]);
});
