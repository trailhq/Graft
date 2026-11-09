/**
 * The kept notice (D87) is named once even when two sessions start together in the same repo (the desktop app
 * restoring two tabs): `keptNotice` reads and sets `notice.shownAt` under the init record's lock, and only the start
 * that set it shows the line (fix-lab5; the 1b lab saw it twice in 29 of 30 trials). The 50 ms SessionStart wait
 * stays: a start that can't get the lock in time shows nothing, and a later start names it. Synthetic repo key.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keptNotice } from "../src/claude/start-init.js";
import { HOOK_RECORD_WAIT_MS, readInitRecord, updateInitRecord } from "../src/init/init-record.js";
import { withLock } from "../src/util/private-fs.js";
import { initRecordPath } from "../src/init/init-record.js";

const TRAIL = mkdtempSync(join(tmpdir(), "graft-kept-race-"));
after(() => rmSync(TRAIL, { recursive: true, force: true }));
const ENV = { HOME: "/nonexistent", TRAIL_HOME: TRAIL };
const KEY = "local/home-dev-acme-shop";
const CHILD = fileURLToPath(new URL("./start-kept-race-child.ts", import.meta.url));

function arm(): void {
  updateInitRecord(KEY, (r) => {
    r.notice = { run: "ir-1a2b", at: new Date().toISOString(), items: [{ kind: "skill", name: "release-npm", id: "s-1a2b3c", forget: "release-npm" }], shownAt: null };
  }, ENV);
}

function child(at: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", CHILD, TRAIL, KEY, String(at)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out).line) : reject(new Error(`child exit ${code}: ${err}`))));
  });
}

test("two sessions starting together: the notice shows exactly once", async () => {
  const counts: number[] = [];
  for (let k = 0; k < 4; k++) {
    arm();
    const at = Date.now() + 2000;
    const lines = await Promise.all([child(at), child(at)]);
    counts.push(lines.filter(Boolean).length);
    assert.ok(readInitRecord(KEY, ENV).notice?.shownAt, "set by the start that showed it");
  }
  assert.deepEqual(counts, counts.map(() => 1));
});

test("a start that can't get the lock within the 50 ms wait shows nothing and leaves the notice for the next start", () => {
  assert.equal(HOOK_RECORD_WAIT_MS, 50);
  arm();
  const held = withLock(initRecordPath(KEY, ENV), () => keptNotice(KEY, ENV, new Date()), 1000);
  assert.ok(held.ok);
  assert.equal(held.value, null, "busy: nothing shown");
  assert.equal(readInitRecord(KEY, ENV).notice?.shownAt, null, "still unnamed");
  assert.match(keptNotice(KEY, ENV, new Date()) ?? "", /^trail: kept from trail init in your terminal: release-npm/);
  assert.equal(keptNotice(KEY, ENV, new Date()), null, "once");
});
